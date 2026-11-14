import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planConnection, applyConnectionPlan, uninstallConnections } from '../packages/installer/src/connections.ts';

test('Node installer previews, merges, repeats and uninstalls while retaining unrelated edits', () => {
  const workspace = mkdtempSync(join(tmpdir(), "npm project ' ü "));
  try {
    execFileSync('git', ['init', workspace], { stdio: 'ignore' });
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'keep' } } }));
    const options = { workspace, appRoot: process.cwd(), database: join(workspace, '.memory/events.sqlite'), repoId: 'repo', clients: ['claude-code', 'codex', 'antigravity'] };
    const plan = planConnection(options);
    assert.equal(existsSync(join(workspace, '.codex/config.toml')), false);
    applyConnectionPlan(plan);
    const initial = readFileSync(join(workspace, '.claude/settings.local.json'), 'utf8');
    applyConnectionPlan(planConnection(options));
    assert.equal(readFileSync(join(workspace, '.claude/settings.local.json'), 'utf8'), initial);
    const mcp = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8'));
    mcp.mcpServers.later = { command: 'added after setup' };
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify(mcp));
    uninstallConnections(workspace);
    const remaining = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(remaining.mcpServers).sort(), ['existing', 'later']);
    assert.equal(existsSync(join(workspace, '.codex/config.toml')), false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Node installer rejects unmanaged collisions and edited managed entries', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'npm-conflict-'));
  try {
    writeFileSync(join(workspace, '.mcp.json'), '{"mcpServers":{"shared-memory":{"command":"other"}}}');
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] };
    assert.throws(() => planConnection(opts), /unmanaged|conflict/i);
    rmSync(join(workspace, '.mcp.json'));
    applyConnectionPlan(planConnection(opts));
    const mcp = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8'));
    mcp.mcpServers['shared-memory'].command = 'user-edited';
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify(mcp));
    assert.throws(() => planConnection(opts), /modified|conflict/i);
    uninstallConnections(workspace);
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8')).mcpServers['shared-memory'], mcp.mcpServers['shared-memory']);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('stale preview cannot overwrite settings edited before apply', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'stale-preview-'));
  try {
    const plan = planConnection({ workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] });
    writeFileSync(join(workspace, '.mcp.json'), '{"user":"later edit"}');
    assert.throws(() => applyConnectionPlan(plan), /changed since preview/);
    assert.equal(readFileSync(join(workspace, '.mcp.json'), 'utf8'), '{"user":"later edit"}');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('failed configuration write restores earlier files and does not persist ownership metadata', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'apply-failure-'));
  try {
    const original = '{"mcpServers":{"existing":{"command":"keep"}}}';
    writeFileSync(join(workspace, '.mcp.json'), original);
    const plan = planConnection({ workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] });
    writeFileSync(join(workspace, '.claude'), 'blocks directory creation');
    assert.throws(() => applyConnectionPlan(plan));
    assert.equal(readFileSync(join(workspace, '.mcp.json'), 'utf8'), original);
    assert.equal(existsSync(join(workspace, '.memory/npm-connection.json')), false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('updates reject a modified managed hook instead of duplicating it', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'edited-hook-'));
  try {
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] };
    applyConnectionPlan(planConnection(opts));
    const path = join(workspace, '.claude/settings.local.json');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    settings.hooks.Stop[0].hooks[0].command += ' user-change';
    writeFileSync(path, JSON.stringify(settings));
    assert.throws(() => planConnection(opts), /modified hook conflict/i);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('unrelated additions survive setup again followed by uninstall', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'rebase-backup-'));
  try {
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] };
    applyConnectionPlan(planConnection(opts));
    const mcpPath = join(workspace, '.mcp.json');
    const current = JSON.parse(readFileSync(mcpPath, 'utf8'));
    current.mcpServers.userAdded = { command: 'keep-new' };
    writeFileSync(mcpPath, JSON.stringify(current));
    applyConnectionPlan(planConnection(opts));
    uninstallConnections(workspace);
    assert.equal(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.userAdded.command, 'keep-new');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('an unrelated MEMORY_QUEUE hook survives repeated setup', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'queue-hook-'));
  try {
    mkdirSync(join(workspace, '.claude'));
    const path = join(workspace, '.claude/settings.local.json');
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'env MEMORY_QUEUE=other unrelated-tool' }] }] } }));
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] };
    applyConnectionPlan(planConnection(opts)); applyConnectionPlan(planConnection(opts));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop.length, 2);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('upgrading to a different runtime rejects a user-extended managed hook group', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'extended-hook-'));
  try {
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] };
    applyConnectionPlan(planConnection(opts));
    const path = join(workspace, '.claude/settings.local.json');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    settings.hooks.Stop[0].hooks.push({ type: 'command', command: 'keep-user-hook' });
    writeFileSync(path, JSON.stringify(settings));
    const app = join(workspace, 'new app');
    for (const file of ['apps/server/src/main.ts', 'packages/adapters/src/cli.ts', 'skills/knit/SKILL.md']) {
      const target = join(app, file); mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, file.endsWith('.md') ? readFileSync(join(process.cwd(), file)) : 'export {};');
    }
    assert.throws(() => planConnection({ ...opts, appRoot: app }), /modified hook conflict/i);
    assert.ok(readFileSync(path, 'utf8').includes('keep-user-hook'));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('customized managed skill is never silently overwritten on setup', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'edited-skill-'));
  try {
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['claude-code'] };
    applyConnectionPlan(planConnection(opts));
    const path = join(workspace, '.claude/skills/knit/SKILL.md');
    writeFileSync(path, readFileSync(path, 'utf8') + '\nUser customization\n');
    assert.throws(() => planConnection(opts), /modified skill conflict/i);
    assert.ok(readFileSync(path, 'utf8').includes('User customization'));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Antigravity-only setup installs the knit slash skill and removes it on uninstall', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'antigravity-knit-'));
  try {
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['antigravity'] };
    applyConnectionPlan(planConnection(opts));
    const path = join(workspace, '.agents/skills/knit/SKILL.md');
    assert.ok(existsSync(path), 'Antigravity setup must install /knit without requiring Codex');
    assert.match(readFileSync(path, 'utf8'), /name: knit/);
    applyConnectionPlan(planConnection(opts));
    uninstallConnections(workspace);
    assert.equal(existsSync(path), false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Antigravity setup prepares a global MCP fragment with session selection and manages its lifecycle', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'antigravity-mcp-'));
  try {
    const opts = { workspace, appRoot: process.cwd(), database: join(workspace, 'db'), repoId: 'repo', clients: ['antigravity'] };
    const fragment = join(workspace, '.memory/connectors/antigravity.json');
    applyConnectionPlan(planConnection(opts));
    const first = readFileSync(fragment, 'utf8');
    const server = JSON.parse(first).mcpServers['shared-memory'];
    assert.equal(server.env.MEMORY_REPO, 'repo');
    assert.equal(server.env.MEMORY_WORKSPACE, realpathSync(workspace));
    assert.equal(server.env.MEMORY_SESSION_SELECTION, '1');
    assert.ok(existsSync(server.command));
    assert.ok(existsSync(server.args[0]));
    applyConnectionPlan(planConnection(opts));
    assert.equal(readFileSync(fragment, 'utf8'), first);
    uninstallConnections(workspace);
    assert.equal(existsSync(fragment), false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('rollback can bind a compatible older runtime that ships only continue-chat', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-runtime-skill-'));
  try {
    const workspace = join(root, 'project'), app = join(root, 'beta3');
    mkdirSync(workspace);
    execFileSync('git', ['init', workspace], { stdio: 'ignore' });
    const opts = { workspace, appRoot: process.cwd(), database: join(root, 'db'), repoId: 'repo', clients: ['codex', 'claude-code', 'antigravity'] };
    applyConnectionPlan(planConnection(opts));
    for (const file of ['apps/server/src/main.js', 'packages/adapters/src/cli.js', 'skills/continue-chat/SKILL.md']) {
      const target = join(app, file); mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, file.endsWith('.md') ? 'Older runtime continuation instructions' : 'export {};');
    }
    applyConnectionPlan(planConnection({ ...opts, appRoot: app }));
    assert.equal(readFileSync(join(workspace, '.agents/skills/continue-chat/SKILL.md'), 'utf8'), 'Older runtime continuation instructions');
    assert.equal(readFileSync(join(workspace, '.claude/skills/continue-chat/SKILL.md'), 'utf8'), 'Older runtime continuation instructions');
    assert.ok(JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8')).mcpServers['shared-memory'].args[0].startsWith(app));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
