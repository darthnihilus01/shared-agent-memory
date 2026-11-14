import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

for (const mode of ['chat', 'auto']) test(mode + ': coding chat picker returns inline choices and accepts only a current session choice after explicit selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inline-picker-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const index = new DatabaseSync(join(root, 'conversation_summaries.db'));
  index.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,last_modified_time TEXT)');
  index.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?)').run('a', 'Chat a', JSON.stringify([pathToFileURL(workspace).href]), '2026-11-14');
  index.close();
  const transcript = join(root, 'brain/a/.system_generated/logs');
  mkdirSync(transcript, { recursive: true });
  writeFileSync(join(transcript, 'transcript.jsonl'), JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Inline picker checkpoint' }) + '\n');
  const client = new Client({ name: 'inline-picker-test', version: '1' }, { capabilities: mode === 'chat' ? { elicitation: { form: {} } } : {} });
  if (mode === 'chat') client.setRequestHandler(ElicitRequestSchema, () => { throw new Error('Antigravity chat mode must keep choices in chat instead of requesting its unreliable form'); });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('apps/server/src/main.ts')], env: {
      ...process.env as Record<string, string>, MEMORY_DB: join(root, 'events.sqlite'), MEMORY_REPO: 'repo', MEMORY_WORKSPACE: workspace,
      MEMORY_SESSION_SELECTION: '1', MEMORY_CLIENT: 'codex', MEMORY_PICKER_MODE: mode, MEMORY_SOURCE_ROOTS: JSON.stringify([root]),
    } }));
    const choose = (sessionId: string, extra = {}) => client.callTool({ name: 'choose_conversation', arguments: { sessionId, workspace, ...extra } });
    const result = await choose('native-a');
    assert.ok(!result.isError, JSON.stringify(result));
    const data = result.structuredContent as { pickerUrl?: string; selectionRequired: boolean; options: { choiceId: string; title: string }[] };
    assert.equal(data.selectionRequired, true);
    assert.equal(data.pickerUrl, undefined, 'Coding selection must stay inside the chat');
    assert.equal(data.options[0].title, 'Chat a');
    assert.ok(data.options[0].choiceId);
    assert.equal((await client.callTool({ name: 'get_context', arguments: { repoId: 'repo', sessionId: 'native-a' } })).isError, true);
    const choiceId = data.options[0].choiceId;
    assert.equal((await choose('native-b', { choiceId })).isError, true, 'Cannot use another session’s displayed choice');
    const selected = await choose('native-a', { choiceId });
    assert.equal((selected.structuredContent as { selected: boolean }).selected, true);
    assert.equal((await choose('native-a', { choiceId })).isError, true, 'Choice is single use');
    const context = await client.callTool({ name: 'get_context', arguments: { repoId: 'repo', sessionId: 'native-a' } });
    assert.ok(JSON.stringify(context.structuredContent).includes('Inline picker checkpoint'));
    const second = await choose('native-b');
    const staleChoice = (second.structuredContent as typeof data).options[0].choiceId;
    await choose('native-b', { cancel: true });
    assert.equal((await choose('native-b', { choiceId: staleChoice })).isError, true);
    assert.equal((await client.callTool({ name: 'get_context', arguments: { repoId: 'repo', sessionId: 'native-b' } })).isError, true);
    const old = await choose('native-c');
    await choose('native-c', { query: 'no matching title' });
    assert.equal((await choose('native-c', { choiceId: (old.structuredContent as typeof data).options[0].choiceId })).isError, true);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});
