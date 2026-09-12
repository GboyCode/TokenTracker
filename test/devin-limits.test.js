const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEVIN_API_BASE_URL,
  DEVIN_PLAN_STATUS_ROUTE,
  resolveDevinCredentialsPath,
  readDevinCredentials,
  normalizeDevinPlanStatus,
  fetchDevinLimits,
} = require("../src/lib/devin-limits");
const {
  getUsageLimits,
  resetUsageLimitsCache,
} = require("../src/lib/usage-limits");

const TEST_TOKEN = "devin-test-session-token";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function makeDevinHome({ toml = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-devin-"));
  const home = path.join(tmp, "home");
  const env = {};
  if (toml !== null) {
    const dir = path.join(home, ".local", "share", "devin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "credentials.toml"), toml);
  }
  return { tmp, home, env };
}

const SIGNED_IN_TOML = `windsurf_api_key = "${TEST_TOKEN}"
api_server_url = "https://server.codeium.com"
devin_api_url = "https://api.devin.ai"
`;

function planStatusBody({
  planName = "Pro",
  billingStrategy = "BILLING_STRATEGY_QUOTA",
  dailyRemaining = 100,
  weeklyRemaining = 100,
  dailyReset = 1_789_200_000,
  weeklyReset = 1_789_286_400,
  hideDaily = false,
  hideWeekly = false,
} = {}) {
  return {
    planStatus: {
      planInfo: {
        planName,
        teamsTier: "TEAMS_TIER_DEVIN_PRO",
        billingStrategy,
        hideDailyQuota: hideDaily,
        hideWeeklyQuota: hideWeekly,
      },
      dailyQuotaRemainingPercent: dailyRemaining,
      weeklyQuotaRemainingPercent: weeklyRemaining,
      dailyQuotaResetAtUnix: String(dailyReset),
      weeklyQuotaResetAtUnix: String(weeklyReset),
    },
  };
}

describe("resolveDevinCredentialsPath", () => {
  it("uses $XDG_DATA_HOME/devin before the home fallback", () => {
    const resolved = resolveDevinCredentialsPath({
      home: "/tmp/hh",
      env: { XDG_DATA_HOME: "/tmp/xdg data" },
    });
    assert.equal(
      resolved,
      path.join("/tmp/xdg data", "devin", "credentials.toml"),
    );
  });

  it("falls back to ~/.local/share/devin/credentials.toml", () => {
    const resolved = resolveDevinCredentialsPath({ home: "/tmp/hh", env: {} });
    assert.equal(
      resolved,
      path.join("/tmp/hh", ".local", "share", "devin", "credentials.toml"),
    );
  });

  it("discovers nothing when no home or env is injected", () => {
    assert.equal(resolveDevinCredentialsPath({ env: {} }), null);
    assert.equal(readDevinCredentials({ env: {} }), null);
  });
});

describe("readDevinCredentials", () => {
  it("reads the CLI-written windsurf_api_key", () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    try {
      const creds = readDevinCredentials({ home, env });
      assert.equal(creds.apiKey, TEST_TOKEN);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws an actionable error for a signed-out credentials file", () => {
    const { tmp, home, env } = makeDevinHome({
      toml: 'api_server_url = "https://server.codeium.com"\n',
    });
    try {
      assert.throws(
        () => readDevinCredentials({ home, env }),
        /devin auth login/i,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("normalizeDevinPlanStatus", () => {
  it("maps 100% remaining to 0% used on both windows", () => {
    const result = normalizeDevinPlanStatus(planStatusBody());
    assert.equal(result.primary_window.used_percent, 0);
    assert.equal(result.secondary_window.used_percent, 0);
    assert.equal(result.plan_label, "Pro");
    assert.equal(result.primary_window.limit_window_seconds, 86400);
    assert.equal(result.secondary_window.limit_window_seconds, 604800);
  });

  it("converts unix-second reset strings to ISO timestamps", () => {
    const result = normalizeDevinPlanStatus(planStatusBody());
    assert.equal(
      result.primary_window.reset_at,
      new Date(1_789_200_000 * 1000).toISOString(),
    );
    assert.equal(
      result.secondary_window.reset_at,
      new Date(1_789_286_400 * 1000).toISOString(),
    );
  });

  it("treats an absent remaining-percent field as exhausted when the reset is live", () => {
    const body = planStatusBody({ dailyRemaining: undefined });
    delete body.planStatus.dailyQuotaRemainingPercent;
    const result = normalizeDevinPlanStatus(body);
    assert.equal(result.primary_window.used_percent, 100);
    assert.equal(result.secondary_window.used_percent, 0);
  });

  it("suppresses an absent daily window while keeping a valid weekly window", () => {
    const body = planStatusBody({ weeklyRemaining: 25 });
    delete body.planStatus.dailyQuotaRemainingPercent;
    delete body.planStatus.dailyQuotaResetAtUnix;
    const result = normalizeDevinPlanStatus(body);
    assert.equal(result.primary_window, null);
    assert.equal(result.secondary_window.used_percent, 75);
  });

  it("handles asymmetric nonzero daily/weekly remaining percentages", () => {
    const result = normalizeDevinPlanStatus(
      planStatusBody({ dailyRemaining: 32, weeklyRemaining: 90 }),
    );
    assert.equal(result.primary_window.used_percent, 68);
    assert.equal(result.secondary_window.used_percent, 10);
  });

  it("suppresses windows hidden by the planInfo hide flags", () => {
    const hidden = normalizeDevinPlanStatus(
      planStatusBody({ hideDaily: true, hideWeekly: true }),
    );
    assert.equal(hidden.primary_window, null);
    assert.equal(hidden.secondary_window, null);
    const dailyOnly = normalizeDevinPlanStatus(
      planStatusBody({ hideDaily: true }),
    );
    assert.equal(dailyOnly.primary_window, null);
    assert.equal(dailyOnly.secondary_window.used_percent, 0);
  });

  it("suppresses quota windows for legacy non-QUOTA billing", () => {
    const result = normalizeDevinPlanStatus(
      planStatusBody({ billingStrategy: "BILLING_STRATEGY_CREDITS" }),
    );
    assert.equal(result.primary_window, null);
    assert.equal(result.secondary_window, null);
    assert.equal(result.plan_label, "Pro");
  });

  it("throws on a missing planStatus instead of reporting a free plan", () => {
    assert.throws(() => normalizeDevinPlanStatus({}), /missing planStatus/);
    assert.throws(() => normalizeDevinPlanStatus(null), /missing planStatus/);
  });

  it("treats explicit null or malformed values as errors, never defaults", () => {
    for (const bad of [null, "abc", "", {}, [], true]) {
      const body = planStatusBody();
      body.planStatus.dailyQuotaRemainingPercent = bad;
      assert.throws(() => normalizeDevinPlanStatus(body), /malformed/);
    }
    for (const bad of [null, "abc", "", -5, {}, []]) {
      const body = planStatusBody();
      body.planStatus.weeklyQuotaResetAtUnix = bad;
      assert.throws(() => normalizeDevinPlanStatus(body), /malformed/);
    }
  });

  it("clamps out-of-range percentages defensively", () => {
    const low = normalizeDevinPlanStatus(planStatusBody({ dailyRemaining: -5 }));
    assert.equal(low.primary_window.used_percent, 100);
    const high = normalizeDevinPlanStatus(
      planStatusBody({ dailyRemaining: 150 }),
    );
    assert.equal(high.primary_window.used_percent, 0);
  });
});

describe("fetchDevinLimits", () => {
  it("returns configured:false without credentials and never hits the network", async () => {
    const { tmp, home, env } = makeDevinHome(); // no credentials file
    let called = false;
    try {
      const result = await fetchDevinLimits({
        home,
        env,
        fetchImpl: async () => {
          called = true;
          return jsonResponse(200, {});
        },
      });
      assert.deepEqual(result, { configured: false });
      assert.equal(called, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("posts an empty JSON body with the x-auth-token header to the fixed endpoint", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    const calls = [];
    try {
      const result = await fetchDevinLimits({
        home,
        env,
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return jsonResponse(200, planStatusBody());
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url,
        `${DEVIN_API_BASE_URL}${DEVIN_PLAN_STATUS_ROUTE}`,
      );
      assert.equal(calls[0].options.method, "POST");
      assert.equal(calls[0].options.body, "{}");
      assert.equal(
        calls[0].options.headers["x-auth-token"],
        TEST_TOKEN,
      );
      assert.equal(
        calls[0].options.headers["Connect-Protocol-Version"],
        "1",
      );
      assert.equal(calls[0].options.redirect, "error");
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.stale, false);
      assert.ok(result.cached_at);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a custom api_server_url without any network call", async () => {
    const { tmp, home, env } = makeDevinHome({
      toml: `windsurf_api_key = "${TEST_TOKEN}"
api_server_url = "https://devin-proxy.example.com"
`,
    });
    let called = false;
    try {
      await assert.rejects(
        fetchDevinLimits({
          home,
          env,
          fetchImpl: async () => {
            called = true;
            return jsonResponse(200, {});
          },
        }),
        /custom api_server_url/,
      );
      assert.equal(called, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags HTTP 401/403 as AUTH_EXPIRED", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    try {
      for (const status of [401, 403]) {
        const error = await fetchDevinLimits({
          home,
          env,
          fetchImpl: async () =>
            jsonResponse(status, { code: "unauthenticated" }),
        }).then(
          () => null,
          (e) => e,
        );
        assert.equal(error.code, "AUTH_EXPIRED");
        assert.match(error.message, /devin auth login/i);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats HTTP 400 as an ambiguous rejection, not credential expiry", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    try {
      const error = await fetchDevinLimits({
        home,
        env,
        fetchImpl: async () =>
          jsonResponse(400, { code: "invalid_argument" }),
      }).then(
        () => null,
        (e) => e,
      );
      assert.equal(error.code, undefined);
      assert.match(error.message, /400/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-JSON and planStatus-less responses", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    try {
      await assert.rejects(
        fetchDevinLimits({
          home,
          env,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            async json() {
              throw new SyntaxError("bad json");
            },
          }),
        }),
        /not JSON/,
      );
      await assert.rejects(
        fetchDevinLimits({
          home,
          env,
          fetchImpl: async () => jsonResponse(200, { unrelated: true }),
        }),
        /missing planStatus/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("propagates transport failures including aborted timeouts", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    try {
      await assert.rejects(
        fetchDevinLimits({
          home,
          env,
          fetchImpl: async () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            throw error;
          },
        }),
        /Devin quota request failed/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("never leaks the session token or credentials path into errors", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    try {
      const cases = [
        async () => jsonResponse(500, { detail: TEST_TOKEN }),
        async () => {
          throw new Error(`upstream refused ${TEST_TOKEN}`);
        },
        async () => jsonResponse(200, { leak: TEST_TOKEN }),
      ];
      for (const fetchImpl of cases) {
        const error = await fetchDevinLimits({ home, env, fetchImpl }).then(
          () => null,
          (e) => e,
        );
        assert.ok(error instanceof Error);
        assert.ok(
          !error.message.includes(TEST_TOKEN),
          `error leaked token: ${error.message}`,
        );
        assert.ok(
          !error.message.includes(home),
          `error leaked fs path: ${error.message}`,
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("devin inside the aggregated usage-limits round", () => {
  it("returns data.devin with plan label and both windows", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        fetchImpl: async (url) => {
          if (String(url).includes("GetPlanStatus")) {
            return jsonResponse(
              200,
              planStatusBody({ dailyRemaining: 60, weeklyRemaining: 10 }),
            );
          }
          return jsonResponse(404, {});
        },
      });
      const devin = data.devin;
      assert.equal(devin.configured, true);
      assert.equal(devin.error, null);
      assert.equal(devin.plan_label, "Pro");
      assert.equal(devin.stale, false);
      assert.ok(devin.cached_at);
      assert.equal(devin.provenance.source, "provider-api");
      assert.equal(devin.primary_window.used_percent, 40);
      assert.equal(devin.secondary_window.used_percent, 90);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns configured:false for devin without credentials without breaking peers", async () => {
    const { tmp, home, env } = makeDevinHome();
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        fetchImpl: async () => jsonResponse(404, {}),
      });
      assert.equal(data.devin.configured, false);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("isolates a devin transport failure from the other providers", async () => {
    const { tmp, home, env } = makeDevinHome({ toml: SIGNED_IN_TOML });
    resetUsageLimitsCache();
    try {
      const data = await getUsageLimits({
        home,
        env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "no-claude") },
        fetchImpl: async (url) => {
          if (String(url).includes("GetPlanStatus")) {
            throw new Error("socket hang up");
          }
          return jsonResponse(404, {});
        },
      });
      assert.equal(data.devin.configured, true);
      assert.match(data.devin.error, /Devin quota request failed/);
      assert.equal(data.devin.provenance.stale, false);
      assert.ok("claude" in data && "codex" in data);
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
