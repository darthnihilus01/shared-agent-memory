import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { historyFixture } from './fixtures/history.ts';

for (const [destination, expected] of [
  ['antigravity', ['codex', 'claude']], ['codex', ['claude', 'antigravity']], ['claude', ['codex', 'antigravity']],
] as const) test(destination + ' picker shows only other agents in newest-first order and imports the chosen source', async () => {
  const fixture = historyFixture();
  const client = new Client({ name: 'cross-agent-picker', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('apps/server/src/main.ts')], env: {
      ...process.env as Record<string, string>, MEMORY_DB: join(fixture.root, 'events.sqlite'), MEMORY_REPO: 'repo', MEMORY_WORKSPACE: fixture.workspace,
      MEMORY_SESSION_SELECTION: '1', MEMORY_PICKER_MODE: 'chat', MEMORY_CLIENT: destination, MEMORY_HISTORY_ROOTS: JSON.stringify(fixture.roots),
    } }));
    const missingScope = await client.callTool({ name: 'choose_conversation', arguments: { sessionId: 'native-session' } });
    assert.equal(missingScope.isError, true, 'Coding picker must require the active folder instead of trusting a global default');
    const wrongProject = await client.callTool({ name: 'choose_conversation', arguments: { sessionId: 'native-session', workspace: fixture.root } });
    assert.equal(wrongProject.isError, true, 'A global connection for another project must not expose its histories');
    const result = await client.callTool({ name: 'choose_conversation', arguments: { sessionId: 'native-session', workspace: fixture.workspace } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal((result.structuredContent as { workspace: string }).workspace, realpathSync(fixture.workspace));
    const ui = (result.structuredContent as { presentation: string; nativeQuestion: { tool: string; arguments: { questions: unknown[] } } });
    assert.equal(ui.presentation, 'native_question');
    assert.equal(ui.nativeQuestion.tool, { antigravity: 'ask_question', codex: 'request_user_input_async', claude: 'AskUserQuestion' }[destination]);
    assert.equal(ui.nativeQuestion.arguments.questions.length, 1);
    const options = (result.structuredContent as { options: { client: string; label: string; choiceId: string }[] }).options;
    assert.ok(Array.isArray(options), 'Picker must discover the other agents’ histories');
    assert.deepEqual(options.map(c => c.client), [...expected]);
    assert.ok(options.every(c => c.label.toLowerCase().includes(c.client)));
    const selected = await client.callTool({ name: 'choose_conversation', arguments: { sessionId: 'native-session', workspace: fixture.workspace, choiceId: options[0].choiceId } });
    assert.ok(!selected.isError, JSON.stringify(selected));
    assert.equal((selected.structuredContent as { featureId: string }).featureId, expected[0] + ':same-id');
    const resumed = selected.structuredContent as { context?: { events: { content: string }[]; total: number; contentTrust: string }; client?: string };
    assert.equal(resumed.client, expected[0]);
    assert.ok(resumed.context, 'Selection must deliver context without another agent/tool round trip');
    assert.ok(resumed.context.total > 0);
    assert.equal(resumed.context.contentTrust, 'untrusted_reference');
    assert.ok(resumed.context.events.some(event => event.content.includes(expected[0] === 'codex' ? 'Codex decision' : 'Claude decision')));
    assert.ok(!JSON.stringify(resumed.context).includes('PRIVATE OTHER PROJECT'));
    const context = await client.callTool({ name: 'get_context', arguments: { sessionId: 'native-session', repoId: 'repo' } });
    assert.ok(!context.isError, JSON.stringify(context));
    assert.deepEqual(resumed.context.events, (context.structuredContent as { events: unknown[] }).events);
  } finally { await client.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('native selector offers only the four most recent project chats', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { writeFileSync } = await import('node:fs');
  const fixture = historyFixture();
  const client = new Client({ name: 'native-pagination', version: '1' });
  try {
    const db = new DatabaseSync(join(fixture.roots.codex[0], 'state_5.sqlite'));
    for (let i = 0; i < 4; i++) {
      const path = join(fixture.roots.codex[0], 'sessions/extra-' + i + '.jsonl');
      writeFileSync(path, JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Extra chat ' + i }] } }) + '\n');
      db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run('extra-' + i, 'Extra chat ' + i, fixture.workspace, path, 1794646800 + i, 'cli', 'main');
    }
    db.close();
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('apps/server/src/main.ts')], env: {
      ...process.env as Record<string, string>, MEMORY_DB: join(fixture.root, 'events.sqlite'), MEMORY_REPO: 'repo', MEMORY_WORKSPACE: fixture.workspace,
      MEMORY_SESSION_SELECTION: '1', MEMORY_PICKER_MODE: 'native_question', MEMORY_CLIENT: 'claude', MEMORY_HISTORY_ROOTS: JSON.stringify(fixture.roots),
    } }));
    const list = async (page: number) => {
      const result = await client.callTool({ name: 'choose_conversation', arguments: { sessionId: 'native-pages', workspace: fixture.workspace, page } });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent as { page: number; pages: number; options: { choiceId: string; title: string }[]; nativeQuestion: { navigation: { page: number }; arguments: { questions: { options: unknown[] }[] } } };
    };
    const first = await list(0);
    assert.equal(first.pages, 1);
    assert.equal(first.nativeQuestion.arguments.questions[0].options.length, 4);
    assert.deepEqual(first.options.map(c => c.title), ['Extra chat 3', 'Extra chat 2', 'Extra chat 1', 'Extra chat 0']);
    const second = await list(0);
    const stale = await client.callTool({ name: 'choose_conversation', arguments: { sessionId: 'native-pages', workspace: fixture.workspace, choiceId: first.options[0].choiceId } });
    assert.equal(stale.isError, true);
    const selected = await client.callTool({ name: 'choose_conversation', arguments: { sessionId: 'native-pages', workspace: fixture.workspace, choiceId: second.options[0].choiceId } });
    assert.ok(!selected.isError, JSON.stringify(selected));
    assert.equal((selected.structuredContent as { selected: boolean }).selected, true);
  } finally { await client.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});
