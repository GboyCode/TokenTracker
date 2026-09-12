// Devin subscription usage limits.
//
// Data source (authoritative; verified against the installed Devin CLI and
// the official app.devin.ai generated client):
//
//   POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus
//
// Connect-RPC unary call: JSON body `{}`, `x-auth-token: <session>`,
// `Connect-Protocol-Version: 1`. The session token is the one the Devin CLI
// stores at $XDG_DATA_HOME/devin/credentials.toml (falling back to
// ~/.local/share/devin/credentials.toml) under `windsurf_api_key`. A
// non-default `api_server_url` in that file is an unsupported configuration —
// this module always talks to the official host and never forwards the token
// to a configured URL.
//
// The response's `planStatus` carries `planInfo.planName`, remaining-quota
// percentages (int32, proto3 implicit presence → omitted from JSON when 0)
// and reset timestamps (int64 unix seconds, emitted as JSON strings). Decode
// rule, verified against the official generated descriptor:
//   - percent present                      → used = 100 - remaining
//   - percent absent, reset present > 0    → proto default 0 → exhausted
//   - percent and reset both absent        → no window
//   - planInfo.hide{Daily,Weekly}Quota     → window suppressed
// Explicit null/malformed values are errors, never implicit defaults. A
// planInfo.billingStrategy other than BILLING_STRATEGY_QUOTA means the plan
// reports legacy credit balances instead of daily/weekly quota — supported
// accounts only.
//
// No local token/cost estimate exists for Devin: the bars below are always
// the server's own numbers.

const fs = require("node:fs");
const path = require("node:path");

const DEVIN_API_BASE_URL = "https://server.codeium.com";
const DEVIN_PLAN_STATUS_ROUTE =
  "/exa.seat_management_pb.SeatManagementService/GetPlanStatus";
const DEVIN_CREDENTIALS_RELATIVE = path.join(
  ".local",
  "share",
  "devin",
  "credentials.toml",
);

const DEVIN_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DEVIN_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

// Request timeouts are enforced by the caller: usage-limits.js passes a
// withFetchTimeout-wrapped fetchImpl (per-request AbortSignal timeout), so this
// module takes no timeout of its own.

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Explicit `home`/env HOME only — never os.homedir() — so a synthetic test env
// (no home, no HOME) discovers nothing and tests stay isolated from the
// developer's real credentials (cf. resolveCommandcodeHome).
function resolveDevinHome({ home, env = process.env } = {}) {
  if (isNonEmptyString(home)) return home.trim();
  const envHome = env && typeof env === "object" ? env.HOME : null;
  if (isNonEmptyString(envHome)) return envHome.trim();
  return null;
}

// $XDG_DATA_HOME/devin/credentials.toml wins; otherwise <home>/.local/share/
// devin/credentials.toml — the path layout the Devin CLI itself uses.
function resolveDevinCredentialsPath({ home, env = process.env } = {}) {
  const xdgDataHome =
    env && typeof env === "object" ? env.XDG_DATA_HOME : null;
  if (isNonEmptyString(xdgDataHome)) {
    return path.join(xdgDataHome.trim(), "devin", "credentials.toml");
  }
  const dir = resolveDevinHome({ home, env });
  if (!dir) return null;
  return path.join(dir, DEVIN_CREDENTIALS_RELATIVE);
}

// Minimal root-level TOML reader for the CLI-written credentials file. Only
// `key = "value"` / `key = 'value'` / bare scalar lines before the first
// `[section]` header are read; anything else is ignored. Returns a map of
// string values (never exported by this module's callers).
function parseDevinCredentialsToml(raw) {
  const fields = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break; // sections begin — root keys end
    const match = /^([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(
      trimmed,
    );
    if (!match) continue;
    const [, key, doubleQuoted, singleQuoted, bare] = match;
    fields[key] = doubleQuoted ?? singleQuoted ?? bare ?? "";
  }
  return fields;
}

// Returns { apiKey, apiServerUrl } when the CLI credentials file exists,
// null when it is absent. Throws a readable error for a present-but-mangled
// file so a broken sign-in surfaces instead of silently hiding the row. The
// apiKey is an opaque session token — it is only placed on the fixed official
// request, never logged or embedded in errors.
function readDevinCredentials({ home, env = process.env } = {}) {
  const credentialsPath = resolveDevinCredentialsPath({ home, env });
  if (!credentialsPath) return null;
  let raw;
  try {
    raw = fs.readFileSync(credentialsPath, "utf8");
  } catch {
    return null; // missing/unreadable file means "not signed in" here
  }
  const fields = parseDevinCredentialsToml(raw);
  const apiKey = isNonEmptyString(fields.windsurf_api_key)
    ? fields.windsurf_api_key.trim()
    : null;
  if (!apiKey) {
    throw new Error(
      "Devin credentials file has no sign-in token — run `devin auth login`.",
    );
  }
  const apiServerUrl = isNonEmptyString(fields.api_server_url)
    ? fields.api_server_url.trim().replace(/\/+$/, "")
    : null;
  if (apiServerUrl && apiServerUrl !== DEVIN_API_BASE_URL) {
    throw new Error(
      "Devin credentials point at a custom api_server_url, which this quota provider does not support.",
    );
  }
  return { apiKey };
}

// Proto-JSON emits camelCase; tolerate the snake_case spelling so a server
// naming change degrades one window instead of crashing the read.
function pickField(obj, camel, snake) {
  if (!obj || typeof obj !== "object") return undefined;
  if (obj[camel] !== undefined) return obj[camel];
  return obj[snake];
}

function devinFieldError(field) {
  return new Error(`Devin quota response has a malformed ${field}.`);
}

// Remaining-percent field: undefined → proto default semantics handled by the
// caller; null or non-numeric → malformed. Values are nominal integer
// percentages and are clamped defensively to 0..100.
function normalizeDevinRemainingPercent(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" && typeof value !== "string") {
    throw devinFieldError(field);
  }
  if (typeof value === "string" && value.trim() === "") {
    throw devinFieldError(field);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw devinFieldError(field);
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

// Reset field: int64 unix seconds (JSON string or number). undefined or the
// proto default 0 → absent; null or non-numeric/non-positive → malformed.
// Returns epoch milliseconds.
function normalizeDevinResetMs(value, field) {
  if (value === undefined || value === 0 || value === "0") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw devinFieldError(field);
  }
  if (typeof value === "string" && value.trim() === "") {
    throw devinFieldError(field);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw devinFieldError(field);
  const ms = n * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? ms : null;
}

// One quota window → the shared { used_percent, reset_at, limit_window_seconds }
// shape. Returns null when the plan reports no window in this slot.
function normalizeDevinWindow({
  remainingPercent,
  resetUnix,
  hidden,
  windowSeconds,
}) {
  if (hidden === true) return null;
  const resetMs = normalizeDevinResetMs(resetUnix, "quota reset timestamp");
  const remaining = normalizeDevinRemainingPercent(
    remainingPercent,
    "quota remaining percent",
  );
  // Both fields absent → the plan does not carry this window (e.g. a
  // weekly-only plan with no daily quota).
  if (remaining === undefined && resetMs === null) return null;
  // Percent omitted with a live reset timestamp is the proto3 default zero:
  // the window exists and is fully consumed.
  const used = remaining === undefined ? 100 : 100 - remaining;
  return {
    used_percent: used,
    reset_at: resetMs === null ? null : new Date(resetMs).toISOString(),
    limit_window_seconds: windowSeconds,
  };
}

// Normalize a GetPlanStatus JSON body into the generic limits shape, or throw
// on a malformed payload. planInfo is optional (free/unknown plans may omit
// it); the windows themselves are driven purely by the quota fields.
function normalizeDevinPlanStatus(body) {
  const planStatus =
    body && typeof body === "object" ? body.planStatus : undefined;
  if (!planStatus || typeof planStatus !== "object") {
    throw new Error("Devin quota response is missing planStatus.");
  }
  const planInfo =
    planStatus.planInfo && typeof planStatus.planInfo === "object"
      ? planStatus.planInfo
      : {};
  const planLabel = isNonEmptyString(planInfo.planName)
    ? planInfo.planName.trim()
    : null;

  // Legacy Windsurf billing fills ACU credit fields instead of the daily /
  // weekly quota; those strategies have nothing renderable here.
  const billingStrategy = pickField(
    planInfo,
    "billingStrategy",
    "billing_strategy",
  );
  const quotaBilling =
    billingStrategy === undefined ||
    billingStrategy === "BILLING_STRATEGY_QUOTA";
  if (!quotaBilling) {
    return { plan_label: planLabel, primary_window: null, secondary_window: null };
  }

  const daily = normalizeDevinWindow({
    remainingPercent: pickField(
      planStatus,
      "dailyQuotaRemainingPercent",
      "daily_quota_remaining_percent",
    ),
    resetUnix: pickField(
      planStatus,
      "dailyQuotaResetAtUnix",
      "daily_quota_reset_at_unix",
    ),
    hidden:
      pickField(planInfo, "hideDailyQuota", "hide_daily_quota") === true,
    windowSeconds: DEVIN_DAILY_WINDOW_SECONDS,
  });
  const weekly = normalizeDevinWindow({
    remainingPercent: pickField(
      planStatus,
      "weeklyQuotaRemainingPercent",
      "weekly_quota_remaining_percent",
    ),
    resetUnix: pickField(
      planStatus,
      "weeklyQuotaResetAtUnix",
      "weekly_quota_reset_at_unix",
    ),
    hidden:
      pickField(planInfo, "hideWeeklyQuota", "hide_weekly_quota") === true,
    windowSeconds: DEVIN_WEEKLY_WINDOW_SECONDS,
  });
  return { plan_label: planLabel, primary_window: daily, secondary_window: weekly };
}

function devinHeaders(apiKey) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    "x-auth-token": apiKey,
  };
}

// Returns `{ configured: false }` without a Devin CLI sign-in, or the
// normalized limits object on success. Auth failure throws with
// `code: "AUTH_EXPIRED"` so the aggregator can flag auth_action_required;
// every other transport/schema failure throws a readable Error. HTTP 400 is
// an ambiguous request rejection — not proof of an expired token.
async function fetchDevinLimits({ home, env = process.env, fetchImpl = fetch } = {}) {
  const credentials = readDevinCredentials({ home, env });
  if (!credentials) return { configured: false };

  let response;
  try {
    response = await fetchImpl(`${DEVIN_API_BASE_URL}${DEVIN_PLAN_STATUS_ROUTE}`, {
      method: "POST",
      headers: devinHeaders(credentials.apiKey),
      body: "{}",
      // Never follow a redirect: the session token must not leak to another
      // origin. A redirect therefore surfaces as a request failure.
      redirect: "error",
    });
  } catch (error) {
    // The underlying message can quote the request URL or an upstream body —
    // strip the session token so it can never ride out on an error string.
    const detail = String(error?.message || "network error")
      .split(credentials.apiKey)
      .join("[redacted]");
    throw new Error(`Devin quota request failed: ${detail}`);
  }
  if (response?.status === 401 || response?.status === 403) {
    const error = new Error(
      "Devin sign-in expired or was rejected — run `devin auth login` to sign in again.",
    );
    error.code = "AUTH_EXPIRED";
    throw error;
  }
  if (!response?.ok) {
    throw new Error(
      `Devin quota request was rejected (HTTP ${response?.status ?? "?"}).`,
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Devin quota response was not JSON.");
  }
  const windows = normalizeDevinPlanStatus(body);
  return {
    configured: true,
    error: null,
    plan_label: windows.plan_label,
    primary_window: windows.primary_window,
    secondary_window: windows.secondary_window,
    stale: false,
    cached_at: new Date().toISOString(),
  };
}

module.exports = {
  DEVIN_API_BASE_URL,
  DEVIN_PLAN_STATUS_ROUTE,
  DEVIN_DAILY_WINDOW_SECONDS,
  DEVIN_WEEKLY_WINDOW_SECONDS,
  resolveDevinHome,
  resolveDevinCredentialsPath,
  readDevinCredentials,
  normalizeDevinPlanStatus,
  normalizeDevinWindow,
  fetchDevinLimits,
};
