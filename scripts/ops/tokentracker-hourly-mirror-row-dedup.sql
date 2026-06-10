-- Mirror-row dedup for tokentracker_hourly (2026-06 stats audit).
--
-- Root cause: device identity is not machine-stable. machineId regeneration
-- (config.json reset) and the per-browser clientId fallback in
-- resolveDeviceNameSuffix (dashboard/src/lib/cloud-sync.ts) create NEW active
-- device rows for the SAME physical machine; an upload-offset reset then
-- re-uploads the full queue history under the new device_id. Machine-level
-- aggregation SUMs across active devices (account_usage_grouped +
-- leaderboard_usage_grouped RPCs), so the mirrored history double-counts.
--
-- Measured on 2026-06-10: 4,435 whole-row-identical (user, source, model,
-- hour) keys across >1 active device — 26.4B mirrored tokens over 17 users
-- (worst account: +48.5% of its total; the top-2 leaderboard-scale accounts
-- carry 23.5B of it).
--
-- This script deletes ONLY rows that are byte-identical duplicates of another
-- active-device row for the same (user, source, model, hour) across ALL six
-- token columns — i.e. provably the same upload mirrored under a second
-- device identity. Two genuinely different machines working the same hour
-- produce different token counts and are NOT touched. cursor (account-level)
-- rows are excluded: readers already whole-row-dedupe them by design.
--
-- Keep rule: within each identical group the MOST RECENTLY upserted copy
-- survives (ORDER BY h.updated_at DESC). The most recent writer is the device
-- most likely to upsert that bucket again — deleting its copy instead would
-- just get re-created on the next re-emit, resurrecting the duplicate.
--
-- It does NOT revoke any device: historic rows hang off device_ids, and the
-- active-device filter would drop a revoked device's remaining history from
-- the account view. Devices left empty by this dedup are harmless.
--
-- Idempotent. Run the DRY RUN first; then run the DELETE in one transaction.
-- After the delete, POST /functions/tokentracker-leaderboard-refresh (no
-- body) to rebuild all three snapshot periods.

-- ── DRY RUN: what would be deleted ──────────────────────────────────────────
WITH ranked AS (
  SELECT
    h.ctid,
    h.user_id,
    h.total_tokens,
    ROW_NUMBER() OVER (
      PARTITION BY
        h.user_id, h.source, h.model, h.hour_start,
        h.total_tokens, h.input_tokens, h.output_tokens,
        h.cached_input_tokens, h.cache_creation_input_tokens,
        h.reasoning_output_tokens
      ORDER BY h.updated_at DESC, h.device_id ASC
    ) AS rn
  FROM tokentracker_hourly h
  JOIN tokentracker_devices d
    ON d.id = h.device_id AND d.revoked_at IS NULL
  WHERE h.source <> 'cursor'
)
SELECT
  COUNT(*)                          AS rows_to_delete,
  COUNT(DISTINCT user_id)           AS affected_users,
  ROUND(SUM(total_tokens) / 1e9, 2) AS mirrored_billions
FROM ranked
WHERE rn > 1;

-- ── DELETE (uncomment to execute) ───────────────────────────────────────────
-- BEGIN;
-- WITH ranked AS (
--   SELECT
--     h.ctid,
--     ROW_NUMBER() OVER (
--       PARTITION BY
--         h.user_id, h.source, h.model, h.hour_start,
--         h.total_tokens, h.input_tokens, h.output_tokens,
--         h.cached_input_tokens, h.cache_creation_input_tokens,
--         h.reasoning_output_tokens
--       ORDER BY h.updated_at DESC, h.device_id ASC
--     ) AS rn
--   FROM tokentracker_hourly h
--   JOIN tokentracker_devices d
--     ON d.id = h.device_id AND d.revoked_at IS NULL
--   WHERE h.source <> 'cursor'
-- )
-- DELETE FROM tokentracker_hourly
-- WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > 1);
-- COMMIT;
