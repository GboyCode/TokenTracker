"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildSessionAnalytics,
  scanClaudeSession,
  scanCodexSession,
  summarizeSessions,
  listSessionsForBrowser,
  resumeCommandFor,
  sessionsToCsv,
} = require("../src/lib/session-analytics");

test("Claude session analytics retains metadata but never content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-"));
  const filePath = path.join(dir, "session.jsonl");
  const secret = "TOP-SECRET-PROMPT-CONTENT";
  const rows = [
    { type: "user", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:00:00Z", message: { content: secret } },
    { type: "assistant", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:01:00Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 10 }, content: [{ type: "tool_use", name: "Edit", input: { file_path: secret } }, { type: "tool_use", name: "Agent", input: { subagent_type: "research" } }] } },
    { type: "user", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:01:30Z", message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: secret }] } },
    { type: "assistant", sessionId: "s1", cwd: dir, timestamp: "2026-07-18T01:02:00Z", message: { id: "m2", model: "claude-test", usage: { input_tokens: 50, output_tokens: 5 }, content: [] } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.turns, 1);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.retry_turns, 0);
  assert.equal(session.one_shot, true);
  assert.equal(session.subagent_calls, 1);
  assert.equal(session.total_tokens, 185);
  assert.equal(JSON.stringify(session).includes(secret), false);

  const summary = summarizeSessions([session]);
  assert.equal(summary.summary.productive_rate, 1);
  assert.equal(summary.summary.one_shot_rate, 1);
  assert.equal(Object.hasOwn(summary.sessions[0], "project_ref"), false);
  assert.equal(sessionsToCsv(summary.sessions).includes(secret), false);
});

test("Claude session analytics counts repeated prompts as retries, not tool loops", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-retry-"));
  const filePath = path.join(dir, "session.jsonl");
  const prompt = "make the requested change";
  const rows = [
    { type: "user", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:00Z", message: { content: prompt } },
    { type: "assistant", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:01Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    { type: "user", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: "ok" }] } },
    { type: "assistant", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:03Z", message: { id: "m2", model: "claude-test", usage: { input_tokens: 8, output_tokens: 4 }, content: [] } },
    { type: "user", sessionId: "s2", cwd: dir, timestamp: "2026-07-18T02:00:04Z", message: { content: prompt } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.turns, 2);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.retry_turns, 1);
  assert.equal(session.one_shot, false);
});

test("Claude session analytics ignores synthetic model markers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-model-"));
  const filePath = path.join(dir, "session.jsonl");
  const rows = [
    { type: "user", sessionId: "s3", cwd: dir, timestamp: "2026-07-18T03:00:00Z", message: { content: "ship it" } },
    { type: "assistant", sessionId: "s3", cwd: dir, timestamp: "2026-07-18T03:00:01Z", message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    { type: "assistant", sessionId: "s3", cwd: dir, timestamp: "2026-07-18T03:00:02Z", message: { id: "m2", model: "<synthetic>", usage: { input_tokens: 2, output_tokens: 1 }, content: [] } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.model, "claude-opus-4-8");
  assert.equal(summarizeSessions([session]).by_model[0].model, "claude-opus-4-8");
});

test("Codex session analytics observes nested exec edit turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-codex-"));
  const filePath = path.join(dir, "rollout-2026-07-18T06-00-00-00000000-0000-4000-8000-000000000001.jsonl");
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const rows = [
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: "codex-1", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "implement it" } },
    { timestamp: "2026-07-18T06:00:03Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call-1", input: "await tools.apply_patch(patch); await tools.spawn_agent({ task_name: 'test' });" } },
    { timestamp: "2026-07-18T06:00:04Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100, 20), total_token_usage: usage(100, 20) } } },
    { timestamp: "2026-07-18T06:01:00Z", type: "turn_context", payload: { turn_id: "turn-2", cwd: dir, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:01:01Z", type: "event_msg", payload: { type: "user_message", message: "verify it" } },
    { timestamp: "2026-07-18T06:01:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(40, 5), total_token_usage: usage(140, 25) } } },
    { timestamp: "2026-07-18T06:01:03Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(5, 1), total_token_usage: usage(145, 26) } } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "gpt-5.6-sol");
  assert.equal(session.turns, 2);
  assert.equal(session.edit_turns, 1);
  assert.equal(session.productive, true);
  assert.equal(session.one_shot, true);
  assert.equal(session.subagent_calls, 1);
  assert.deepEqual(session.subagent_types, { spawn_agent: 1 });
});

test("Codex session analytics does not report model providers as models", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-provider-"));
  const filePath = path.join(dir, "rollout-2026-07-18T07-00-00-00000000-0000-4000-8000-000000000002.jsonl");
  const rows = [
    { timestamp: "2026-07-18T07:00:00Z", type: "session_meta", payload: { id: "codex-provider", cwd: dir, model_provider: "openai" } },
    { timestamp: "2026-07-18T07:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: dir } },
    { timestamp: "2026-07-18T07:00:02Z", type: "event_msg", payload: { type: "user_message", message: "inspect it" } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.model, "unknown");
  assert.notEqual(summarizeSessions([session]).by_model[0].model, "openai");
});

test("efficiency denominators only use sessions that contain edits", () => {
  const summary = summarizeSessions([
    {
      model: "gpt-test",
      started_at: "2026-07-18T06:00:00Z",
      productive: true,
      first_pass: true,
      one_shot: true,
      edit_turns: 1,
      retry_turns: 0,
      total_tokens: 100,
      cost_usd: 2,
    },
    {
      model: "gpt-test",
      started_at: "2026-07-18T07:00:00Z",
      productive: false,
      first_pass: false,
      one_shot: false,
      edit_turns: 0,
      retry_turns: 0,
      total_tokens: 900,
      cost_usd: 18,
    },
  ]);

  assert.equal(summary.summary.edit_session_rate, 0.5);
  assert.equal(summary.summary.first_pass_rate, 1);
  assert.equal(summary.summary.tokens_per_edit, 100);
  assert.equal(summary.summary.cost_per_edit, 2);
  assert.equal(summary.by_model[0].edit_sessions, 1);
});

test("concurrent session analytics builds share one scan", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-build-"));
  const projectDir = path.join(home, ".claude", "projects", "fixture");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: "user",
    sessionId: "s4",
    cwd: projectDir,
    timestamp: "2026-07-18T04:00:00Z",
    message: { content: "build" },
  })}\n`);
  const observerDir = path.join(
    home,
    ".claude",
    "projects",
    "-Users-test--claude-mem-observer-sessions",
  );
  fs.mkdirSync(observerDir, { recursive: true });
  fs.writeFileSync(path.join(observerDir, "observer.jsonl"), `${JSON.stringify({
    type: "assistant",
    sessionId: "observer",
    cwd: "/Users/test/.claude-mem/observer-sessions",
    timestamp: "2026-07-18T04:00:01Z",
    message: { id: "observer-message", model: "<synthetic>", usage: {}, content: [] },
  })}\n`);

  const [first, second] = await Promise.all([
    buildSessionAnalytics({ home, force: true }),
    buildSessionAnalytics({ home, force: true }),
  ]);
  assert.strictEqual(first, second);
  // Claude Memory's observer files are background bookkeeping, not coding
  // sessions, and should not dilute efficiency or appear as a model.
  assert.equal(first.length, 1);
});

test("session analytics reuses unchanged file records during an incremental rebuild", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-incremental-"));
  const writeSession = (project, sessionId, model) => {
    const projectDir = path.join(home, ".claude", "projects", project);
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const rows = [
      { type: "user", sessionId, cwd: projectDir, timestamp: "2026-07-18T05:00:00Z", message: { content: "build" } },
      { type: "assistant", sessionId, cwd: projectDir, timestamp: "2026-07-18T05:00:01Z", message: { id: `${sessionId}-message`, model, usage: { input_tokens: 10, output_tokens: 2 }, content: [] } },
    ];
    fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    return filePath;
  };
  writeSession("project-a", "session-a", "claude-a");
  const changedFile = writeSession("project-b", "session-b", "claude-b");

  await buildSessionAnalytics({ home, force: true });
  const sidecarPath = path.join(home, ".tokentracker", "tracker", "session.queue.jsonl");
  const cachedRows = fs.readFileSync(sidecarPath, "utf8").trim().split("\n").map(JSON.parse);
  cachedRows.find((row) => row.project_key === "project-a").model = "cached-proof";
  fs.writeFileSync(sidecarPath, `${cachedRows.map(JSON.stringify).join("\n")}\n`);
  fs.appendFileSync(changedFile, `${JSON.stringify({
    type: "user",
    sessionId: "session-b",
    cwd: path.dirname(changedFile),
    timestamp: "2026-07-18T05:00:02Z",
    message: { content: "changed" },
  })}\n`);

  const rebuilt = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(rebuilt.find((row) => row.project_key === "project-a").model, "cached-proof");
  assert.equal(rebuilt.find((row) => row.project_key === "project-b").turns, 2);
});

test("Claude session title uses the ai-title record, never the prompt body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-title-"));
  const filePath = path.join(dir, "session.jsonl");
  const secret = "SECRET-PROMPT-NEVER-A-TITLE";
  const rows = [
    { type: "user", sessionId: "t1", cwd: dir, timestamp: "2026-07-18T01:00:00Z", message: { content: secret } },
    { type: "assistant", sessionId: "t1", cwd: dir, timestamp: "2026-07-18T01:00:01Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    { type: "ai-title", sessionId: "t1", timestamp: "2026-07-18T01:00:02Z", aiTitle: "Refactor the auth module" },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.title, "Refactor the auth module");
  // The raw prompt body must never end up in the persisted record, including
  // as a title fallback.
  assert.equal(JSON.stringify(session).includes(secret), false);

  // Titles are local-only: stripped from the cloud/CSV summary payload.
  const summary = summarizeSessions([session]);
  assert.equal(Object.hasOwn(summary.sessions[0], "title"), false);

  // The local-only browser list keeps the title alongside a resume command.
  const browser = listSessionsForBrowser([session]);
  assert.equal(browser.sessions[0].title, "Refactor the auth module");
  assert.equal(browser.sessions[0].resume_command, resumeCommandFor("claude", session.session_id));
});

test("Claude session without an ai-title leaves the title null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-notitle-"));
  const filePath = path.join(dir, "session.jsonl");
  const rows = [
    { type: "user", sessionId: "t2", cwd: dir, timestamp: "2026-07-18T01:00:00Z", message: { content: "do the thing" } },
    { type: "assistant", sessionId: "t2", cwd: dir, timestamp: "2026-07-18T01:00:01Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 2 }, content: [] } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanClaudeSession(filePath);
  assert.equal(session.title, null);
});

test("Codex session title comes from session_index.jsonl thread_name", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-title-"));
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const rows = [
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: home, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "implement it" } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
  fs.writeFileSync(
    path.join(home, ".codex", "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Wire up billing webhook", updated_at: "2026-07-18T06:05:00Z" })}\n`,
  );

  const session = await scanCodexSession(filePath);
  assert.equal(session.title, "Wire up billing webhook");
});

test("incremental rebuild refreshes a Codex title when only session_index changes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-title-refresh-"));
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${[
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: home, model: "gpt-5.6-sol" } },
  ].map(JSON.stringify).join("\n")}\n`);
  const indexPath = path.join(home, ".codex", "session_index.jsonl");
  fs.writeFileSync(indexPath, `${JSON.stringify({ id: sessionId, thread_name: "Original title" })}\n`);

  const first = await buildSessionAnalytics({ home, force: true });
  assert.equal(first[0].title, "Original title");

  // An index update is append-like in the real client; vary its size so the
  // fixture also reflects the filesystem signal used by incremental scanning.
  fs.writeFileSync(indexPath, `${JSON.stringify({ id: sessionId, thread_name: "Renamed title with more detail" })}\n`);
  const refreshed = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(refreshed[0].title, "Renamed title with more detail");
});

test("Codex session without a session_index entry leaves the title null", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-codex-notitle-"));
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionId = "99999999-8888-7777-6666-555555555555";
  const filePath = path.join(sessionsDir, `rollout-${sessionId}.jsonl`);
  const rows = [
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: home, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "implement it" } },
  ];
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);

  const session = await scanCodexSession(filePath);
  assert.equal(session.title, null);
});

test("session browser merges same-session fragments into one resumable row", async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "tt-merge-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "tt-merge-b-"));
  // Two on-disk files carrying the SAME Claude session id (a resume + a
  // sub-agent sidechain) — they hash to the same session_hash.
  const write = async (dir, aiTitle) => {
    const filePath = path.join(dir, "session.jsonl");
    const rows = [
      { type: "user", sessionId: "shared-session", cwd: "/repo", timestamp: "2026-07-18T01:00:00Z", message: { content: "go" } },
      { type: "assistant", sessionId: "shared-session", cwd: "/repo", timestamp: "2026-07-18T01:05:00Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    ];
    if (aiTitle) rows.push({ type: "ai-title", sessionId: "shared-session", timestamp: "2026-07-18T01:06:00Z", aiTitle });
    fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    return scanClaudeSession(filePath);
  };
  const fragA = await write(dirA, null);
  const fragB = await write(dirB, "Ship the feature");
  assert.equal(fragA.session_hash, fragB.session_hash);

  const list = listSessionsForBrowser([fragA, fragB]);
  assert.equal(list.session_count, 1);
  assert.equal(list.sessions.length, 1);
  const merged = list.sessions[0];
  // Summed, non-overlapping token counts from both fragments.
  assert.equal(merged.total_tokens, fragA.total_tokens + fragB.total_tokens);
  assert.equal(merged.edit_turns, fragA.edit_turns + fragB.edit_turns);
  // Agent-authored title survives even when only one fragment carried it.
  assert.equal(merged.title, "Ship the feature");
  assert.equal(merged.resume_command, resumeCommandFor("claude", "shared-session"));
});

test("session browser source filter isolates codex from claude after merge", async () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-src-claude-"));
  const claudeFile = path.join(claudeDir, "session.jsonl");
  fs.writeFileSync(claudeFile, `${[
    { type: "user", sessionId: "c-1", cwd: "/repo", timestamp: "2026-07-18T01:00:00Z", message: { content: "hi" } },
    { type: "assistant", sessionId: "c-1", cwd: "/repo", timestamp: "2026-07-18T01:01:00Z", message: { id: "m1", model: "claude-test", usage: { input_tokens: 5, output_tokens: 1 }, content: [] } },
  ].map(JSON.stringify).join("\n")}\n`);
  const claude = await scanClaudeSession(claudeFile);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-src-codex-"));
  const codexDir = path.join(home, ".codex", "sessions", "2026", "07", "18");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexId = "22222222-3333-4444-5555-666666666666";
  const codexFile = path.join(codexDir, `rollout-${codexId}.jsonl`);
  fs.writeFileSync(codexFile, `${[
    { timestamp: "2026-07-18T06:00:00Z", type: "session_meta", payload: { id: codexId, cwd: home, model_provider: "openai" } },
    { timestamp: "2026-07-18T06:00:01Z", type: "turn_context", payload: { turn_id: "t1", cwd: home, model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-18T06:00:02Z", type: "event_msg", payload: { type: "user_message", message: "do" } },
  ].map(JSON.stringify).join("\n")}\n`);
  const codex = await scanCodexSession(codexFile);

  const all = [claude, codex];
  const codexOnly = listSessionsForBrowser(all).sessions.filter((row) => row.source === "codex");
  assert.equal(codexOnly.length, 1);
  assert.equal(codexOnly[0].source, "codex");
});

test("resume commands reject ids that could inject shell syntax", () => {
  assert.equal(resumeCommandFor("claude", "safe-session_01"), "claude --resume safe-session_01");
  assert.equal(
    resumeCommandFor("codex", "11111111-2222-3333-4444-555555555555"),
    "codex resume 11111111-2222-3333-4444-555555555555",
  );
  assert.equal(resumeCommandFor("claude", "--dangerous-flag"), null);
  assert.equal(resumeCommandFor("claude", "valid; touch /tmp/pwned"), null);
  assert.equal(resumeCommandFor("codex", "valid\nrm -rf workspace"), null);
});
