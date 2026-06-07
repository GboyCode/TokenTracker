const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const nativeBridgePath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "NativeBridge.swift",
);

test("NativeBridge pushes settings when sync state changes", () => {
  const source = fs.readFileSync(nativeBridgePath, "utf8");

  assert.match(
    source,
    /"isSyncing":\s*viewModel\?\.isSyncing\s*\?\?\s*false/,
    "settings payload should expose the current sync state",
  );
  assert.match(
    source,
    /viewModel\.\$isSyncing[\s\S]*?\.sink\s*\{\s*\[weak self\]\s*_\s*in\s*self\?\.pushSettings\(\)\s*\}/,
    "sync state changes should be pushed to the dashboard settings UI",
  );
});

test("NativeBridge availability fingerprint tracks every gated provider", () => {
  const source = fs.readFileSync(nativeBridgePath, "utf8");

  // The dropdown only re-pushes when the fingerprint changes. Any provider that
  // availableItemsPayload gates on isProviderAvailable() must be fingerprinted,
  // or its availability flip won't reach an already-open Widgets page.
  for (const provider of ["kimi", "kiro", "grok", "copilot", "antigravity"]) {
    assert.ok(
      source.includes(`limits.${provider}`),
      `availability fingerprint must reference ${provider} so the dropdown re-pushes when its limits flip available/unavailable`,
    );
  }
});
