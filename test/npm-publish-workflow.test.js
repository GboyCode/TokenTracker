const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "npm-publish.yml"
);

function loadWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("npm-publish workflow file exists", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH), "workflow file should exist");
});

test("workflow triggers only after canonical CI completes on main", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_run:"), "should trigger from workflow_run");
  assert.ok(content.includes("workflows: [CI]"), "should depend on canonical CI");
  assert.ok(content.includes("types: [completed]"), "should wait for CI completion");
  assert.ok(
    content.includes("branches: [main]"),
    "should target main branch only"
  );
});

test("publish job builds/publishes on Node.js 20 to match the engines floor", () => {
  const content = loadWorkflow();
  const publishIdx = content.indexOf("\n  publish:");
  assert.ok(publishIdx > 0, "should have a publish job");
  const publishSection = content.slice(publishIdx);
  assert.ok(
    publishSection.includes("node-version: 20"),
    "publish job should build/publish on Node 20 (engines: >=20)"
  );
});

test("successful push CI gates publish and the exact tested SHA is checked out", () => {
  const content = loadWorkflow();
  assert.ok(content.includes("workflow_run.conclusion == 'success'"));
  assert.ok(content.includes("workflow_run.event == 'push'"));
  assert.ok(content.includes("workflow_run.head_branch == 'main'"));
  assert.ok(
    content.includes("ref: ${{ github.event.workflow_run.head_sha }}"),
    "publish must build the exact commit that passed CI"
  );
  assert.ok(!content.includes("\n  test:"), "must not maintain a weaker duplicate test job");
});

test("workflow sets npm registry URL", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("registry-url: https://registry.npmjs.org"),
    "should configure npm registry"
  );
});

test("workflow checks version before publishing", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("npm view tokentracker-cli"),
    "should check if version already exists on npm"
  );
});

test("workflow builds dashboard before publish", () => {
  const content = loadWorkflow();
  const buildIndex = content.indexOf("dashboard:build");
  const publishIndex = content.indexOf("run: npm publish");
  assert.ok(buildIndex > 0, "should build dashboard");
  assert.ok(publishIndex > 0, "should run npm publish");
  assert.ok(
    buildIndex < publishIndex,
    "dashboard build must come before npm publish"
  );
});

test("workflow uses NPM_TOKEN secret", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("secrets.NPM_TOKEN"),
    "should reference NPM_TOKEN secret for authentication"
  );
});

test("workflow skips all steps when version already published", () => {
  const content = loadWorkflow();
  const conditionalSteps = (content.match(/if:.*version-check.*false/g) || [])
    .length;
  // install root, install dashboard, build, publish = 4 conditional steps
  assert.ok(
    conditionalSteps >= 4,
    `should have at least 4 steps gated on version check, found ${conditionalSteps}`
  );
});

test("workflow has concurrency guard to prevent parallel publishes", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("concurrency:"),
    "should have concurrency config"
  );
  assert.ok(
    content.includes("cancel-in-progress: false"),
    "should not cancel in-progress publish"
  );
});

test("workflow installs dashboard dependencies separately", () => {
  const content = loadWorkflow();
  assert.ok(
    content.includes("npm ci --prefix dashboard"),
    "should install dashboard deps with --prefix"
  );
});

test("package.json files array includes dashboard/dist", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  assert.ok(
    pkg.files.includes("dashboard/dist/"),
    "published package must include dashboard/dist/"
  );
});
