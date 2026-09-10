"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const pricing = require("../src/lib/pricing");
const { lookupPricing } = require("../src/lib/pricing/matcher");
const curated = require("../src/lib/pricing/curated-overrides.json");

// Standard API-equivalent USD/MTok, verified 2026-09-07:
// https://developers.openai.com/api/docs/models/gpt-6-astra
const rates = { input: 10, output: 50, cache_read: 1, cache_write: 12.5 };
const models = [
  "gpt-6-astra", "gpt-6-astra-high", "gpt-6-astra-xhigh",
  "gpt-6-astrahigh", "gpt-6-astra-ultra", "openai/gpt-6-astra",
  "GPT-6-ASTRA",
];
const row = {
  source: "codex", model: "gpt-6-astra", input_tokens: 1_000_000,
  cached_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
  output_tokens: 1_000_000, reasoning_output_tokens: 500_000,
};

test("Astra resolves offline including provider and reasoning suffixes", () => {
  for (const model of models) {
    const actual = pricing.getModelPricing(model, { source: "codex" });
    for (const [key, value] of Object.entries(rates)) {
      assert.equal(actual[key], value, `${model}: ${key}`);
    }
  }
  const stale = lookupPricing("gpt-6-astra", {
    curated, litellm: { "gpt-6-astra": { input: 0, output: 0 } },
  });
  assert.equal(stale.source, "curated:exact");
  assert.equal(stale.value.input, 10);
});

test("Astra bills cache writes and counts Codex reasoning only once", () => {
  assert.equal(pricing.computeRowCost(row), 73.5);
  assert.equal(pricing.computeRowCost({ ...row, source: "every-code" }), 73.5);
  assert.equal(pricing.computeRowCost({ ...row, source: "gemini" }), 98.5);
});

test("Astra long-context premium applies only to observed requests, never daily totals", () => {
  const mixed = {
    ...row, model: "openai/gpt-6-astra-ultra", input_tokens: 200_000,
    cached_input_tokens: 400_000, cache_creation_input_tokens: 20_000,
    output_tokens: 40_000, reasoning_output_tokens: 10_000,
    long_context_input_tokens: 100_000, long_context_cached_input_tokens: 200_000,
    long_context_cache_creation_input_tokens: 10_000,
    long_context_output_tokens: 20_000, long_context_reasoning_output_tokens: 5_000,
  };
  // Standard 4.65 + long-request premium 1.825. Reasoning is inside output.
  assert.ok(Math.abs(pricing.computeRowCost(mixed) - 6.475) < 1e-12);
  assert.equal(pricing.computeRowCost(row), 73.5, "large aggregate is not a long request");
});

for (const slug of [
  "tokentracker-leaderboard-refresh", "tokentracker-account-daily",
  "tokentracker-account-summary", "tokentracker-account-model-breakdown",
  "tokentracker-leaderboard-profile",
]) {
  test(`${slug}: Astra prices match local standard estimates`, () => {
    const source = fs.readFileSync(path.join(__dirname, "../dashboard/edge-patches", `${slug}.ts`), "utf8");
    const blockMatch = source.match(/const MODEL_PRICING[\s\S]*?\nfunction getModelPricing\(model: string(?:, source = "")?\) \{[\s\S]*?\n\}/);
    assert.ok(blockMatch, `${slug}: pricing block is present`);
    const block = blockMatch[0];
    const rowPricing = source.match(/\nfunction getRowPricing\([\s\S]*?\n\}/)[0];
    const compute = source.match(/\nfunction computeRowCost\([\s\S]*?\n\}/)?.[0] || "";
    const script = transformSync(`${block}\n${rowPricing}\n${compute}`, { loader: "ts", format: "cjs" }).code;
    const context = vm.createContext({ SOURCES_WITH_AUTHORITATIVE_COST: new Set(["grok"]) });
    vm.runInContext(script, context);
    for (const model of models) {
      const actual = context.getModelPricing(model);
      for (const [key, value] of Object.entries(rates)) {
        assert.equal(actual[key], value, `${model}: ${key}`);
      }
      if (compute) assert.equal(context.computeRowCost({ ...row, model }), 73.5);
    }
  });
}
