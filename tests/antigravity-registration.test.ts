import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConnectionPlan } from '../packages/installer/src/connections.ts';
import { planAntigravity, verifyAntigravity } from '../packages/installer/src/antigravity.ts';
import { antigravityServerName } from '../packages/adapters/src/server-name.ts';

const connection = (workspace: string, repoId = 'repo') => ({ workspace, repoId, database: join(workspace, 'events.sqlite'), clients: ['antigravity'] });

test('global registration previews without writes, supports two projects, updates and removes only owned servers', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-global-'));
  try {
    const config = join(root, 'mcp_config.json'), home = join(root, 'installation');
    writeFileSync(config, JSON.stringify({ otherSetting: true, mcpServers: { stitch: { command: 'keep' } } }));
    const a = connection(join(root, 'a')), b = connection(join(root, 'b'), 'repo-b');
    const opts = { configPath: config, installationHome: home, appRoot: process.cwd(), node: process.execPath, projects: [a, b] };
    const plan = planAntigravity(opts);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(config, 'utf8')).mcpServers), ['stitch']);
    applyConnectionPlan(plan);
    const saved = JSON.parse(readFileSync(config, 'utf8'));
    assert.equal(saved.otherSetting, true);
    const aKey = antigravityServerName(a.workspace), bKey = antigravityServerName(b.workspace);
    assert.notEqual(aKey, bKey);
    assert.equal(saved.mcpServers[aKey].env.MEMORY_WORKSPACE, a.workspace);
    assert.equal(saved.mcpServers[bKey].env.MEMORY_REPO, 'repo-b');
    applyConnectionPlan(planAntigravity({ ...opts, node: '/new/runtime/node' }));
    assert.equal(JSON.parse(readFileSync(config, 'utf8')).mcpServers[aKey].command, '/new/runtime/node');
    const current = JSON.parse(readFileSync(config, 'utf8'));
    current.mcpServers.later = { command: 'also keep' };
    writeFileSync(config, JSON.stringify(current));
    applyConnectionPlan(planAntigravity({ ...opts, projects: [b] }));
    const remaining = JSON.parse(readFileSync(config, 'utf8')).mcpServers;
    assert.equal(remaining[aKey], undefined);
    assert.ok(remaining[bKey]);
    applyConnectionPlan(planAntigravity({ ...opts, projects: [] }));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(config, 'utf8')).mcpServers).sort(), ['later', 'stitch']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('global registration rejects unmanaged names, modified settings and stale previews; uninstall preserves user edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-conflict-'));
  try {
    const configPath = join(root, 'mcp_config.json'), project = connection(root);
    const key = antigravityServerName(root);
    const opts = { configPath, installationHome: join(root, 'install'), appRoot: process.cwd(), projects: [project] };
    writeFileSync(configPath, JSON.stringify({ mcpServers: { [key]: { command: 'user-owned' } } }));
    assert.throws(() => planAntigravity(opts), /conflict/i);
    rmSync(configPath);
    const preview = planAntigravity(opts);
    writeFileSync(configPath, '{}');
    assert.throws(() => applyConnectionPlan(preview), /changed since preview/);
    applyConnectionPlan(planAntigravity(opts));
    const current = JSON.parse(readFileSync(configPath, 'utf8'));
    current.mcpServers[key].command = 'user-edited';
    writeFileSync(configPath, JSON.stringify(current));
    assert.throws(() => planAntigravity(opts), /modified|conflict/i);
    applyConnectionPlan(planAntigravity({ ...opts, projects: [] }));
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers[key].command, 'user-edited');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('registered Antigravity server exposes real memory tools and broken runtime verification fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-tools-'));
  try {
    const opts = { configPath: join(root, 'mcp_config.json'), installationHome: root, appRoot: process.cwd(), projects: [connection(root)] };
    assert.equal(existsSync(opts.configPath), false);
    applyConnectionPlan(planAntigravity(opts));
    await verifyAntigravity(opts);
    const current = JSON.parse(readFileSync(opts.configPath, 'utf8'));
    current.mcpServers[antigravityServerName(root)].args = [join(root, 'missing.js')];
    writeFileSync(opts.configPath, JSON.stringify(current));
    await assert.rejects(verifyAntigravity(opts), /Antigravity.*(connect|tools|server)/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uninstalling one project preserves another project user-edited global server', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-uninstall-'));
  try {
    const configPath = join(root, 'mcp_config.json'), a = connection(join(root, 'a')), b = connection(join(root, 'b'));
    const opts = { configPath, installationHome: root, appRoot: process.cwd(), projects: [a, b] };
    applyConnectionPlan(planAntigravity(opts));
    const current = JSON.parse(readFileSync(configPath, 'utf8'));
    current.mcpServers[antigravityServerName(b.workspace)].disabled = true;
    writeFileSync(configPath, JSON.stringify(current));
    applyConnectionPlan(planAntigravity({ ...opts, projects: [b], removeOnly: true }));
    const result = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(result.mcpServers[antigravityServerName(a.workspace)], undefined);
    assert.equal(result.mcpServers[antigravityServerName(b.workspace)].disabled, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed verification rollback removes new registrations while retaining concurrent unrelated additions', async () => {
  const { rollbackConnectionPlan } = await import('../packages/installer/src/connections.ts');
  const root = mkdtempSync(join(tmpdir(), 'agy-rollback-'));
  try {
    const configPath = join(root, 'mcp_config.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: { stitch: { command: 'keep' } } }));
    const plan = planAntigravity({ configPath, installationHome: root, appRoot: process.cwd(), projects: [connection(root)] });
    applyConnectionPlan(plan);
    const current = JSON.parse(readFileSync(configPath, 'utf8'));
    current.mcpServers.concurrent = { command: 'added-during-verification' };
    writeFileSync(configPath, JSON.stringify(current));
    rollbackConnectionPlan(plan);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers).sort(), ['concurrent', 'stitch']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('global Antigravity registration preserves opt-in conversation mode and verifies its tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-capture-'));
  try {
    const project = { ...connection(root), captureNewSessions: true };
    const opts = { configPath: join(root, 'mcp_config.json'), installationHome: root, appRoot: process.cwd(), projects: [project] };
    applyConnectionPlan(planAntigravity(opts));
    const entry = JSON.parse(readFileSync(opts.configPath, 'utf8')).mcpServers[antigravityServerName(root)];
    assert.equal(entry.env.MEMORY_CONVERSATION_MODE, '1');
    assert.equal(entry.env.MEMORY_CAPTURE_NEW_SESSIONS, '1');
    await verifyAntigravity(opts);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('global server identity is stable across physical workspace aliases', async () => {
  const { symlinkSync, mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'agy-alias-'));
  try {
    const workspace = join(root, 'project'), alias = join(root, 'alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(antigravityServerName(alias), antigravityServerName(workspace));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('global server identity matches the repository folder returned by native Git', async () => {
  const { execFileSync } = await import('node:child_process');
  const { realpathSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'agy-git-root-'));
  try {
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(antigravityServerName(root), antigravityServerName(gitRoot), JSON.stringify({ root, gitRoot, realpath: realpathSync(root), nativeRealpath: realpathSync.native(root) }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
