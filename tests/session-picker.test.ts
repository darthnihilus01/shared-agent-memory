import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

test("native user picker keeps concurrent sessions separate and cancellation imports nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-picker-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const index = new DatabaseSync(join(root, "conversation_summaries.db"));
  index.exec("CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,last_modified_time TEXT)");
  for (const id of ["a", "b"]) {
    index.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?)").run(id, "Chat " + id, JSON.stringify([pathToFileURL(workspace).href]), id === "a" ? "2026-11-12" : "2026-11-11");
    const path = join(root, "brain", id, ".system_generated/logs");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "transcript.jsonl"), JSON.stringify({ type: "PLANNER_RESPONSE", content: "Decision from chat " + id }) + "\n");
  }
  index.close();
  const env = { ...process.env, MEMORY_DB: join(root, "events.sqlite"), MEMORY_REPO: "repo", MEMORY_SESSION_SELECTION: "1", MEMORY_CLIENT: "codex", MEMORY_WORKSPACE: workspace, MEMORY_SOURCE_ROOTS: JSON.stringify([root]) };
  delete (env as Record<string, string | undefined>).NODE_TEST_CONTEXT;
  const client = new Client({ name: "user-picker-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  const choices = ["1", "0", "cancel"];
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompts++;
    assert.ok(JSON.stringify(request).includes("Chat a"));
    assert.ok(JSON.stringify(request).includes("Chat b"));
    const choice = choices.shift();
    return choice === "cancel" ? { action: "cancel" } : { action: "accept", content: { conversation: choice! } };
  });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("apps/server/src/main.ts")], env }));
    const before = await client.callTool({ name: "get_context", arguments: { repoId: "repo", sessionId: "session-a" } });
    assert.equal(before.isError, true);
    for (const sessionId of ["session-a", "session-b"]) {
      const selected = await client.callTool({ name: "choose_conversation", arguments: { sessionId, workspace } });
      assert.ok(!selected.isError, JSON.stringify(selected));
    }
    const a = await client.callTool({ name: "get_context", arguments: { repoId: "repo", sessionId: "session-a" } });
    const b = await client.callTool({ name: "get_context", arguments: { repoId: "repo", sessionId: "session-b" } });
    assert.ok(JSON.stringify(a.structuredContent).includes("Decision from chat b"));
    assert.ok(!JSON.stringify(a.structuredContent).includes("Decision from chat a"));
    assert.ok(JSON.stringify(b.structuredContent).includes("Decision from chat a"));
    const { MemoryStore } = await import("../packages/memory/src/store.ts");
    const lookup = new MemoryStore(env.MEMORY_DB);
    let otherEvidence;
    try { otherEvidence = lookup.context({ repoId: "repo", featureId: "antigravity:a" }).events[0].eventId; }
    finally { lookup.close(); }
    const forbiddenEvidence = await client.callTool({ name: "get_evidence", arguments: { repoId: "repo", sessionId: "session-a", eventId: otherEvidence } });
    assert.equal(forbiddenEvidence.isError, true);
    const wrong = await client.callTool({ name: "get_context", arguments: { repoId: "repo", sessionId: "session-a", featureId: "antigravity:a" } });
    assert.equal(wrong.isError, true);
    const cancelled = await client.callTool({ name: "choose_conversation", arguments: { sessionId: "session-c", workspace } });
    assert.deepEqual(cancelled.structuredContent, { selected: false, selectionRequired: true });
    const unselected = await client.callTool({ name: "get_context", arguments: { repoId: "repo", sessionId: "session-c" } });
    assert.equal(unselected.isError, true);
    assert.equal(prompts, 3);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup requires a picker until a choice is bound to the native session", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { MemoryStore } = await import("../packages/memory/src/store.ts");
  const root = mkdtempSync(join(tmpdir(), "session-hook-"));
  execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
  const env = {
    ...process.env, MEMORY_DB: join(root, "events.sqlite"), MEMORY_REPO: "repo",
    MEMORY_SESSION_SELECTION: "1", MEMORY_CLIENT: "codex", MEMORY_WORKSPACE: root,
  };
  delete (env as Record<string, string | undefined>).NODE_TEST_CONTEXT;
  const invoke = (session: string, launch?: string) => spawnSync(process.execPath, [resolve("packages/adapters/src/cli.ts"), "recall", "codex"], {
    env: { ...env, ...(launch ? { MEMORY_LAUNCH_FEATURE: launch, MEMORY_LAUNCH_TITLE: launch } : {}) },
    input: JSON.stringify({ session_id: session, cwd: root }), encoding: "utf8",
  });
  try {
    const first = invoke("a");
    assert.equal(first.status, 0, first.stderr);
    assert.ok(JSON.parse(first.stdout).hookSpecificOutput.additionalContext.includes("choose_conversation"));
    const selected = invoke("a", "antigravity:chosen-a");
    assert.ok(JSON.parse(selected.stdout).hookSpecificOutput.additionalContext.includes('"sessionId":"a"'));
    invoke("b", "antigravity:chosen-b");
    assert.ok(JSON.parse(invoke("a").stdout).hookSpecificOutput.additionalContext.includes("antigravity:chosen-a"));
    const store = new MemoryStore(env.MEMORY_DB);
    try {
      assert.equal(store.sessionSelection("repo", "a")?.featureId, "antigravity:chosen-a");
      assert.equal(store.sessionSelection("repo", "b")?.featureId, "antigravity:chosen-b");
    } finally { store.close(); }
    assert.ok(JSON.parse(invoke("c").stdout).hookSpecificOutput.additionalContext.includes("choose_conversation"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
