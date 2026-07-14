const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// The pet's usage-driven ambient thresholds and the sprite-atlas timing tables are
// hand-mirrored between the web/Windows implementation (JS) and the macOS one
// (Swift). These shape-locked tests pin the two copies to each other so a tweak on
// one side can't silently make the platforms react differently to the same usage.

const repoRoot = path.join(__dirname, "..");

const personalitySource = fs.readFileSync(
  path.join(repoRoot, "dashboard/src/lib/pet-personality.js"),
  "utf8",
);
const companionSource = fs.readFileSync(
  path.join(repoRoot, "TokenTrackerBar/TokenTrackerBar/Views/ClawdCompanionView.swift"),
  "utf8",
);
const atlasJsSource = fs.readFileSync(
  path.join(repoRoot, "dashboard/src/ui/foundation/PetAtlasAnimated.jsx"),
  "utf8",
);
const atlasSwiftSource = fs.readFileSync(
  path.join(repoRoot, "TokenTrackerBar/TokenTrackerBar/Views/PetAtlasSpriteView.swift"),
  "utf8",
);
const windowsPetSource = fs.readFileSync(
  path.join(repoRoot, "TokenTrackerWin/PetWindow.cs"),
  "utf8",
);
const macControllerSource = fs.readFileSync(
  path.join(repoRoot, "TokenTrackerBar/TokenTrackerBar/Services/DesktopPetWindowController.swift"),
  "utf8",
);

// "workingThinking" → "working-thinking", so the two sides compare directly.
function kebab(swiftCase) {
  return swiftCase.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function jsAmbientRules() {
  const rules = [];
  for (const m of personalitySource.matchAll(
    /if \(tokens >= ([\d_]+)\) choices\.push\(([^)]+)\);/g,
  )) {
    for (const state of m[2].matchAll(/"([a-z-]+)"/g)) {
      rules.push({ trigger: `tokens>=${m[1]}`, state: state[1] });
    }
  }
  const models = personalitySource.match(
    /topModels\?\.length \|\| 0\) >= (\d+)\) choices\.push\("([a-z-]+)"\)/,
  );
  assert.ok(models, "pet-personality.js topModels ambient rule must stay regex-parsable");
  rules.push({ trigger: `topModels>=${models[1]}`, state: models[2] });
  const streak = personalitySource.match(
    /streakDays\) \|\| 0\) >= (\d+)\) choices\.push\("([a-z-]+)"\)/,
  );
  assert.ok(streak, "pet-personality.js streak ambient rule must stay regex-parsable");
  rules.push({ trigger: `streak>=${streak[1]}`, state: streak[2] });
  return rules;
}

function swiftAmbientRules() {
  const loop = companionSource.match(
    /private func startIdleVariantLoop\(\) \{[\s\S]*?\n    \}/,
  );
  assert.ok(loop, "ClawdCompanionView.swift startIdleVariantLoop must exist");
  const body = loop[0];
  const rules = [];
  for (const m of body.matchAll(
    /if tokens >= ([\d_]+) \{ variants(?:\.append\(\.(\w+)\)|\s*\+=\s*\[([^\]]+)\]) \}/g,
  )) {
    const states = m[2] ? [m[2]] : [...m[3].matchAll(/\.(\w+)/g)].map((s) => s[1]);
    for (const state of states) {
      rules.push({ trigger: `tokens>=${m[1]}`, state: kebab(state) });
    }
  }
  const models = body.match(/topModels\.count >= (\d+) \{ variants\.append\(\.(\w+)\) \}/);
  assert.ok(models, "startIdleVariantLoop topModels rule must stay regex-parsable");
  rules.push({ trigger: `topModels>=${models[1]}`, state: kebab(models[2]) });
  const streak = body.match(/streakDays \?\? 0\) >= (\d+) \{ variants\.append\(\.(\w+)\) \}/);
  assert.ok(streak, "startIdleVariantLoop streak rule must stay regex-parsable");
  rules.push({ trigger: `streak>=${streak[1]}`, state: kebab(streak[2]) });
  return rules;
}

test("ambient usage thresholds match between pet-personality.js and ClawdCompanionView.swift", () => {
  const js = jsAmbientRules();
  assert.ok(js.length >= 5, "expected at least 5 JS ambient rules");
  assert.deepEqual(swiftAmbientRules(), js);
});

test("the overheated pose never re-enters an ambient pool (it reuses the error visuals)", () => {
  const jsAmbient = personalitySource.match(
    /function pickPetAmbientState[\s\S]*?\n\}/,
  )[0];
  assert.ok(!jsAmbient.includes('choices.push("working-overheated"'),
    "working-overheated must not be an ambient choice");
  const swiftLoop = companionSource.match(
    /private func startIdleVariantLoop\(\) \{[\s\S]*?\n    \}/,
  )[0];
  assert.ok(!/variants(?:\.append\(\.workingOverheated\)|[^\n]*\.workingOverheated)/.test(swiftLoop),
    ".workingOverheated must not be an idle variant");
});

function jsAtlasRows() {
  const block = atlasJsSource.match(/const ROWS = \{([\s\S]*?)\n\};/);
  assert.ok(block, "PetAtlasAnimated.jsx ROWS must stay a literal object");
  const rows = new Map();
  for (const m of block[1].matchAll(
    /(?:"([\w-]+)"|([\w-]+)):\s*\{ row: (\d+), durations: \[([\d, ]+)\] \}/g,
  )) {
    rows.set(Number(m[3]), m[4].split(",").map((n) => Number(n.trim())));
  }
  return rows;
}

function swiftAtlasRows() {
  const rows = new Map();
  for (const m of atlasSwiftSource.matchAll(
    /AnimationSpec\(row: (\d+), durations: \[([\d, ]+)\]\)/g,
  )) {
    rows.set(Number(m[1]), m[2].split(",").map((n) => Number(n.trim())));
  }
  return rows;
}

test("atlas row timings match between PetAtlasAnimated.jsx and PetAtlasSpriteView.swift", () => {
  const js = jsAtlasRows();
  const swift = swiftAtlasRows();
  assert.ok(js.size >= 9, "expected the full 9-row JS table");
  assert.ok(swift.size >= 7, "expected the Swift AnimationSpec switch to cover 7 rows");
  // The web table additionally carries the directional running rows (1/2) that macOS
  // does not use; every row macOS renders must tick with the web's exact durations.
  for (const [row, durations] of swift) {
    assert.deepEqual(
      durations,
      js.get(row),
      `row ${row} durations diverge between Swift and JS`,
    );
  }
});

test("V2 look directions use the same 16-cell row mapping on web, macOS, and Windows", () => {
  assert.match(atlasJsSource, /9 \+ Math\.floor\(lookIndex \/ 8\)/);
  assert.match(atlasJsSource, /lookIndex % 8/);
  assert.match(atlasJsSource, /atlasRows = spriteVersionNumber === 2 \? 11 : 9/);
  assert.match(atlasSwiftSource, /return \(9 \+ normalized \/ 8, normalized % 8\)/);
  assert.match(macControllerSource, /degrees \/ 22\.5/);
  assert.match(macControllerSource, /% 16/);
  assert.match(windowsPetSource, /degrees \/ 22\.5/);
  assert.match(windowsPetSource, /% 16/);
  assert.match(windowsPetSource, /pet:look/);
});

test("Windows edge tuck keeps the sprite visible instead of hiding window padding", () => {
  // The tucked target must be based on the centered sprite's inset, not just
  // `workArea.Right - EdgePeek` (which leaves only transparent padding visible).
  assert.match(windowsPetSource, /private double SpriteLeftInset/);
  assert.match(windowsPetSource, /private double TuckedLeft\(double workAreaRight\)/);
  assert.match(
    windowsPetSource,
    /double leftX = _isRevealed \? wa\.Right - Width : TuckedLeft\(wa\.Right\)/,
  );
  assert.match(
    windowsPetSource,
    /double targetX = _isRevealed \? wa\.Right - Width : TuckedLeft\(wa\.Right\)/,
  );

  const edgePeek = 30;
  for (const [width, height] of [[150, 138], [180, 162], [210, 194]]) {
    const spriteSize = Math.max(40, Math.min(width, height - 46) - 8);
    const spriteLeftInset = (width - spriteSize) / 2;
    const tuckedLeft = 1920 - spriteLeftInset - edgePeek;
    assert.equal(tuckedLeft + spriteLeftInset, 1920 - edgePeek);
  }
});

test("macOS edge tuck keeps a visible handle and restores every preset", () => {
  assert.match(macControllerSource, /private static let edgePeek: CGFloat = 48/);

  const detect = macControllerSource.match(
    /private func detectTuckedState\(_ panel: NSPanel\) \{[\s\S]*?\n    \}/,
  )?.[0];
  assert.ok(detect, "macOS tucked-state detection must remain explicit");
  assert.match(detect, /if spriteRight > vf\.maxX/);
  assert.match(detect, /else if spriteLeft < vf\.minX/);
  assert.doesNotMatch(detect, /spriteCenter/);

  // 48pt is deliberately larger than the smallest 60pt sprite frame, so the
  // visible strip cannot consist only of the artboard's transparent edge.
  for (const spriteWidth of [60, 84, 111]) {
    assert.ok(48 < spriteWidth, `edge handle must fit inside ${spriteWidth}pt sprite`);
  }
});
