# Devin CLI usage tracking

TokenTracker reads retained **local** [Devin CLI](https://devin.ai) history as a passive source — the same class of integration as Cursor, Goose, or AnythingLLM. Nothing is installed into Devin, no hook is registered, and no Devin endpoint is contacted. Token statistics never read credentials, sign-in state, `cogs_json`, prompts, or message bodies.

## What is read

| Location | Purpose |
|---|---|
| `$XDG_DATA_HOME/devin/cli/sessions.db` (default `~/.local/share/devin/cli/sessions.db`) | Devin CLI's local session history (SQLite) |

Set `TOKENTRACKER_DEVIN_DB` to point at a different database file.

On Windows there is no known native Devin data directory; a Devin install inside WSL is discovered through the `\\wsl$` bridge like other WSL-resident tools.

The reader projects only statistical metadata from `message_nodes.chat_message` — `role`, `message_id`, `metadata.request_id`, `metadata.generation_model`, `metadata.started_generation_at` / `metadata.created_at`, and the scalar `metadata.metrics.*_tokens` counters — joined with `sessions.working_directory` for local project attribution. The full JSON is parsed in memory; only those fields are used.

## Deduplication and corrections

`request_id` is the billing identity, not the message node. Devin's retained history contains replay, fork, and compaction copies of the same request, so TokenTracker keeps a per-request ledger under `cursors.devin.requests` in `tracker/cursors.json`:

- The first copy of a request contributes its usage once; later copies of the same `request_id` are ignored.
- If a retained record's metrics are corrected in place, the previous contribution is subtracted and the corrected one applied — no double-add, no frozen stale value.
- Deleting or compacting a conversation does **not** refund tokens already consumed.
- Buckets use `metadata.started_generation_at` (falling back to `metadata.created_at`), never node insertion time, and the recorded `generation_model` — including `compactor` — is preserved rather than rewritten to the session's configured model.

## Pricing caveat

Token counts are authoritative. Devin's observed models (`swe-2`, `swe-2-high`, `compactor`) currently have **no pricing data** in TokenTracker's curated pricing or the public litellm feed, so their usage is reported in tokens but excluded from dollar estimates. A **$0 cost figure does not mean the usage was free** — the dashboard shows an explicit notice on the Devin provider view and on the combined "All tools" view whenever Devin contributes usage.

## Scope

This covers only the Devin CLI's local SQLite history. It does not include Devin Cloud sessions, Devin Desktop, Windsurf history, or Devin subscription/quota tracking (a separate, default-off limits concern).
