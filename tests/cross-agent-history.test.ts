import { historyFixture } from './fixtures/history.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { discoverHistories } from '../packages/adapters/src/histories.ts';
import { importConversation } from '../packages/adapters/src/handoff.ts';
import { MemoryStore } from '../packages/memory/src/store.ts';


test('all host agents see only other agents, newest first by actual timestamp, with no cross-project or subagent leakage', () => {
  const fixture = historyFixture();
  try {
    for (const [destination, expected] of [
      ['antigravity', ['codex', 'claude']], ['codex', ['claude', 'antigravity']], ['claude', ['codex', 'antigravity']],
    ] as const) {
      const chats = discoverHistories({ roots: fixture.roots, workspace: fixture.workspace, destination });
      assert.deepEqual(chats.map(c => c.client), [...expected]);
      assert.ok(chats.every(c => c.client !== destination));
      assert.ok(!JSON.stringify(chats).includes('PRIVATE'));
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('selected Claude and Codex histories import once with source identity, branch attribution and text-only redaction', () => {
  const fixture = historyFixture(); const store = new MemoryStore(':memory:');
  try {
    const chats = discoverHistories({ roots: fixture.roots, workspace: fixture.workspace, destination: 'antigravity' });
    for (const chat of chats) {
      const opts = { conversation: chat, repoId: 'repo', directory: join(fixture.root, 'queue', chat.client!), store };
      const report = importConversation(opts);
      assert.equal(report.featureId, chat.client + ':same-id');
      assert.ok(report.delivered > 0);
      assert.equal(importConversation(opts).delivered, 0);
      const saved = store.context({ repoId: 'repo', featureId: report.featureId });
      assert.ok(saved.events.every(e => e.source?.startsWith(chat.client + ':')));
      assert.ok(!JSON.stringify(saved).includes('secret-value'));
      assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
      if (chat.client === 'codex') assert.ok(saved.events.every(e => e.branch === 'feature/code'));
    }
  } finally { store.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('Codex session files remain discoverable without its SQLite index, and Claude sidechains are excluded', async () => {
  const { writeFileSync } = await import('node:fs');
  const fixture = historyFixture();
  try {
    rmSync(join(fixture.roots.codex[0], 'state_5.sqlite'));
    writeFileSync(join(fixture.roots.codex[0], 'session_index.jsonl'), JSON.stringify({ id: 'same-id', thread_name: 'Fallback Codex title', updated_at: '2026-11-14T08:00:00Z' }) + '\n');
    writeFileSync(join(fixture.roots.claude[0], 'projects/encoded-project/agent-child.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'child', isSidechain: true, cwd: fixture.workspace, timestamp: '2026-11-14T10:00:00Z', message: { role: 'assistant', content: 'PRIVATE CHILD CHAT' } }) + '\n');
    const chats = discoverHistories({ roots: fixture.roots, workspace: fixture.workspace, destination: 'antigravity' });
    assert.equal(chats.filter(c => c.client === 'codex').length, 1);
    assert.equal(chats.find(c => c.client === 'codex')?.title, 'Fallback Codex title');
    assert.equal(chats.filter(c => c.client === 'claude').length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('cross-agent discovery includes the same repository’s linked worktrees', async () => {
  const { execFileSync } = await import('node:child_process');
  const fixture = historyFixture();
  try {
    execFileSync('git', ['init', '--initial-branch=main', fixture.workspace], { stdio: 'ignore' });
    execFileSync('git', ['-C', fixture.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
    const linked = join(fixture.root, 'linked');
    execFileSync('git', ['-C', fixture.workspace, 'worktree', 'add', '-b', 'linked', linked], { stdio: 'ignore' });
    const chats = discoverHistories({ roots: fixture.roots, workspace: linked, destination: 'antigravity' });
    assert.deepEqual(chats.map(c => c.client), ['codex', 'claude']);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('an incomplete newer Codex index cannot hide supported older indexes or the other agents', () => {
  const fixture = historyFixture();
  try {
    const empty = new DatabaseSync(join(fixture.roots.codex[0], 'state_99.sqlite')); empty.close();
    let chats = discoverHistories({ roots: fixture.roots, workspace: fixture.workspace, destination: 'antigravity' });
    assert.deepEqual(chats.map(c => c.client), ['codex', 'claude']);
    assert.equal(chats[0].title, 'Codex chat');
    rmSync(join(fixture.roots.codex[0], 'state_5.sqlite'));
    chats = discoverHistories({ roots: fixture.roots, workspace: fixture.workspace, destination: 'antigravity' });
    assert.equal(chats.filter(c => c.client === 'codex').length, 1);
    assert.equal(chats.filter(c => c.client === 'claude').length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('history discovery recognizes aliases of the same physical workspace without Git metadata', async () => {
  const { symlinkSync } = await import('node:fs');
  const fixture = historyFixture();
  try {
    const alias = join(fixture.root, 'project-alias');
    symlinkSync(fixture.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const chats = discoverHistories({ roots: fixture.roots, workspace: alias, destination: 'claude' });
    assert.deepEqual(chats.map(c => c.client), ['codex', 'antigravity']);
    assert.ok(!chats.some(c => c.title.includes('PRIVATE')));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
