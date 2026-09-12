# Devin usage limits

## Overview

TokenTracker exposes **Devin** (devin.ai) as a usage-limits provider. The provider reports the two subscription quota windows a Devin plan calculates on its servers: daily usage and weekly usage. Both are *remaining* quotas on the wire and are inverted into the panel's `used_percent` convention.

Quota display only: there is no local session token parsing for Devin, no spending enforcement and no billing manager. The bars are always the server's own numbers.

## Data source

The only endpoint is the official seat-management RPC the Devin web app itself calls:

```text
POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus
```

Request contract (verified against the installed Devin CLI and the generated client shipped by `app.devin.ai`):

- Headers: `x-auth-token: <session>`, `Content-Type: application/json`, `Connect-Protocol-Version: 1`.
- Body: `{}` — no metadata or client-version fields.
- Redirects are not followed: the session token must never reach another origin.
- `GetUserStatus` is intentionally not used: it returns the same plan status plus identity fields this provider does not need.
- A non-default `api_server_url` in the credentials file is treated as an unsupported configuration, not as an alternate request destination.

## Configuration

The provider is keyed entirely by the Devin CLI's saved sign-in:

```bash
devin auth login
```

The CLI writes `$XDG_DATA_HOME/devin/credentials.toml` (falling back to `~/.local/share/devin/credentials.toml`). TokenTracker reads the root-level `windsurf_api_key` session token from that file — the same credential the CLI uses — and never stores, logs or forwards it anywhere except the fixed official endpoint above. With no credentials file the provider reports `configured: false` and the panel shows the sign-in hint.

## Response contract

`planStatus` carries `planInfo.planName` (rendered as the plan label), remaining-quota percentages and reset timestamps:

| Wire field | Type | Panel mapping |
|---|---|---|
| `dailyQuotaRemainingPercent` | int32 percent remaining | `primary_window.used_percent = 100 - value` |
| `weeklyQuotaRemainingPercent` | int32 percent remaining | `secondary_window.used_percent = 100 - value` |
| `dailyQuotaResetAtUnix` | int64 unix seconds (JSON string) | `primary_window.reset_at` (ISO) |
| `weeklyQuotaResetAtUnix` | int64 unix seconds (JSON string) | `secondary_window.reset_at` (ISO) |

Each emitted window also carries `limit_window_seconds` (86400 daily, 604800 weekly) for pacing. Reset times are always the server's timestamps — the observed daily boundary is 08:00 UTC and the weekly boundary Sunday 08:00 UTC, but these are account observations, not constants the code assumes.

### Implicit scalar semantics

The percent and reset fields are proto3 *implicit* scalars in the official `exa.codeium_common_pb.PlanStatus` descriptor (confirmed in the generated code bundled with `app.devin.ai`), so the server omits them from JSON when they hold their zero default. The decode rules in `src/lib/devin-limits.js`:

- Percent present → `used_percent = 100 - remaining`.
- Percent absent **with** a positive reset timestamp → the window exists at the proto default of 0% remaining, i.e. fully exhausted (`used_percent: 100`). An exhausted window must still render.
- Percent and reset both absent → the plan has no such window (e.g. no daily quota) and nothing is rendered for it.
- `planInfo.hideDailyQuota` / `hideWeeklyQuota` suppress the matching window.
- `planInfo.billingStrategy` other than `BILLING_STRATEGY_QUOTA` means the plan reports legacy credit balances instead of daily/weekly quota; those plans render no windows.
- Explicit `null` or non-numeric values are malformed responses, not implicit defaults.

Max-tier window shapes have not been verified against a live Max account; the behaviour above follows from the schema alone.

## Errors

- `401` / `403` → the saved session token expired or was rejected. The aggregate flags `auth_action_required: "reauth"` and the panel points at `devin auth login`.
- `400` → an ambiguous request rejection, **not** proof of expiry; surfaced as a plain provider error.
- Other transport/schema failures → a readable provider error that never contains response bodies, token values, account identifiers or filesystem paths.

## Brand asset

`dashboard/public/brand-logos/devin.svg` is a monochrome `currentColor` trace of the official Devin "nodes" mark published at `https://app.devin.ai/assets/pwa/apple-touch-icon.png` (see `THIRD_PARTY_NOTICES.md`). The macOS app loads the same bundled SVG.

## Implementation boundaries

The implementation lives in `src/lib/devin-limits.js` and is wired into the shared provider poll in `src/lib/usage-limits.js`, reusing the existing timeout, single-flight, two-minute cache and provenance machinery. It shares the generic `primary_window` / `secondary_window` schema, so dashboard, macOS and widget surfaces consume it like any other two-window provider.

## Tests and validation

`test/devin-limits.test.js` covers credential discovery (including `$XDG_DATA_HOME` and a synthetic test home), the request shape, window normalization including the implicit-zero and hide-flag rules, malformed payloads, authentication classification and error redaction. Dashboard coverage lives in `UsageLimitsPanel.test.jsx`; native coverage in `TokenTrackerBarTests`.

```bash
node --test test/devin-limits.test.js
npm run ci:local
```
