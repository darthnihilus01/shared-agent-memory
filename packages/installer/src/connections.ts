import { antigravityServerName } from '../../adapters/src/server-name.ts';
import { hookCommand, isManagedHook } from './platform.ts';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';

export const clients = [
  'codex',
  'claude-code',
  'antigravity',
  'claude-desktop',
] as const;
const begin = '# BEGIN shared-agent-memory',
  end = '# END shared-agent-memory';
const statePath = '.memory/npm-connection.json';
type Snapshot = { before: string | null; after: string };
type State = { schema: 1; files: Record<string, Snapshot> };
export type ConnectionOptions = {
  workspace: string;
  appRoot: string;
  database: string;
  repoId: string;
  clients: string[];
  node?: string;
  captureNewSessions?: boolean;
};
export type ConnectionPlan = {
  workspace: string;
  changes: Record<string, string | null>;
  expected: Record<string, string | null>;
};
const read = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8') : null;
const dump = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const object = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Revert just our changes; later independent additions remain. Modified scalar
// values stay user-owned rather than being overwritten by an uninstall.
function restore(before: any, after: any, current: any): any {
  if (equal(current, after)) return before;
  if (
    object(after) &&
    object(current) &&
    typeof after.command === 'string' &&
    Array.isArray(after.args)
  )
    return current;
  if (
    object(after) &&
    object(current) &&
    (before === undefined || object(before))
  ) {
    const result = { ...current };
    for (const key of new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after),
    ])) {
      if (equal(before?.[key], after[key])) continue;
      const value = restore(before?.[key], after[key], current[key]);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    return Object.keys(result).length === 0 && before === undefined
      ? undefined
      : result;
  }
  if (
    Array.isArray(after) &&
    Array.isArray(current) &&
    (before === undefined || Array.isArray(before))
  ) {
    const previous = before ?? [];
    const added = after.filter((v) => !previous.some((p: any) => equal(p, v)));
    const result = current.filter((v) => !added.some((a) => equal(a, v)));
    for (const v of previous)
      if (!after.some((a) => equal(a, v)) && !result.some((a) => equal(a, v)))
        result.push(v);
    return result.length === 0 && before === undefined ? undefined : result;
  }
  return current;
}

export function readConnectionState(workspace: string): State {
  const text = read(join(workspace, statePath));
  if (!text) return { schema: 1, files: {} };
  const value = JSON.parse(text);
  if (value.schema !== 1 || !object(value.files))
    throw new Error('Unsupported connector state');
  for (const [file, snapshot] of Object.entries(value.files)) {
    if (
      ![
        '.mcp.json',
        '.codex/config.toml',
        '.codex/hooks.json',
        '.agents/hooks.json',
        '.agents/mcp_config.json',
        '.agents/skills/continue-chat/SKILL.md',
        '.agents/skills/knit/SKILL.md',
        '.claude/settings.local.json',
        '.claude/skills/continue-chat/SKILL.md',
        '.claude/skills/knit/SKILL.md',
        '.memory/connectors/claude-desktop.json',
        '.memory/connectors/antigravity.json',
      ].includes(file) ||
      !object(snapshot) ||
      typeof snapshot.after !== 'string' ||
      !(snapshot.before === null || typeof snapshot.before === 'string')
    )
      throw new Error('Invalid connector state');
  }
  return value;
}

export function planConnection(opts: ConnectionOptions): ConnectionPlan {
  const workspace = realpathSync.native(opts.workspace),
    app = resolve(opts.appRoot),
    node = opts.node ?? process.execPath;
  if (
    !opts.clients.length ||
    opts.clients.some((c) => !clients.includes(c as any))
  )
    throw new Error('Choose a supported client');
  const extension = existsSync(join(app, 'apps/server/src/main.js'))
    ? 'js'
    : 'ts';
  const server = join(app, 'apps/server/src/main.' + extension),
    runner = join(app, 'packages/adapters/src/cli.' + extension);
  if (!existsSync(server) || !existsSync(runner))
    throw new Error('Runtime files missing');
  const state = readConnectionState(workspace),
    changes: Record<string, string> = {},
    expected: Record<string, string | null> = {};
  const get = (path: string) => {
    const content = read(join(workspace, path));
    expected[path] = content;
    return content;
  };
  const json = (path: string) => {
    const v = JSON.parse(get(path) ?? '{}');
    if (!object(v)) throw new Error(path + ' must be an object');
    return v;
  };
  const env = {
    MEMORY_DB: resolve(opts.database),
    MEMORY_REPO: opts.repoId,
    MEMORY_WORKSPACE: workspace,
    MEMORY_SESSION_SELECTION: '1',
    ...(opts.captureNewSessions
      ? { MEMORY_CONVERSATION_MODE: '1', MEMORY_CAPTURE_NEW_SESSIONS: '1' }
      : {}),
  };
  const handler = (client: string, action: string) => ({
    type: 'command',
    timeout: 10,
    command: hookCommand(
      {
        ...env,
        ...(client === 'antigravity'
          ? { MEMORY_MCP_SERVER: antigravityServerName(workspace) }
          : {}),
        MEMORY_QUEUE: join(dirname(opts.database), 'queue', client),
        MEMORY_MANAGED: 'shared-agent-memory',
      },
      node,
      [runner, action, client],
    ),
  });
  const connection = (desktop = false, client = 'claude') => {
    const clientEnv: Record<string, string> = {
      ...env,
      MEMORY_CLIENT: client,
      ...(client === 'antigravity' && !opts.captureNewSessions ? { MEMORY_PICKER_MODE: 'native_question' } : {}),
      ...(desktop ? { MEMORY_CHAT_CLIENT: 'claude-desktop' } : {}),
      ...(!desktop && opts.captureNewSessions ? { MEMORY_CLIENT: client } : {}),
    };
    if (desktop) {
      delete clientEnv.MEMORY_CONVERSATION_MODE;
      delete clientEnv.MEMORY_CAPTURE_NEW_SESSIONS;
    }
    return { command: node, args: [server], env: clientEnv };
  };
  function owned(path: string, location: string[], current: any) {
    if (current === undefined) return;
    const prior = state.files[path];
    const previous = prior
      ? location.reduce((v, key) => v?.[key], JSON.parse(prior.after))
      : undefined;
    if (!equal(current, previous))
      throw new Error('Unmanaged or modified connector conflict in ' + path);
  }
  function mcp(path: string, desktop = false, client = 'claude') {
    const value = json(path);
    value.mcpServers ??= {};
    owned(
      path,
      ['mcpServers', 'shared-memory'],
      value.mcpServers['shared-memory'],
    );
    value.mcpServers['shared-memory'] = connection(desktop, client);
    changes[path] = dump(value);
  }
  function hooks(path: string, client: string) {
    const value = json(path);
    value.hooks ??= {};
    const prior = state.files[path]
      ? JSON.parse(state.files[path].after).hooks
      : {};
    for (const [event, action] of [
      ['SessionStart', 'recall'],
      ['Stop', 'capture'],
    ]) {
      const old = prior?.[event] ?? [];
      const groups = value.hooks[event] ?? [];
      if (!Array.isArray(groups)) throw new Error('Invalid hooks in ' + path);
      // Only remove exact previously generated handlers. Edited handlers remain;
      // reject if they mention our runner to avoid duplicate capture.
      const oldOwned = old.filter((g: any) =>
        g.hooks?.some((h: any) => isManagedHook(h.command)),
      );
      const kept = groups.filter(
        (g: any) => !oldOwned.some((p: any) => equal(p, g)),
      );
      if (
        kept.some((g: any) =>
          g.hooks?.some((h: any) => isManagedHook(h.command)),
        )
      )
        throw new Error('Modified hook conflict in ' + path);
      value.hooks[event] = [...kept, { hooks: [handler(client, action)] }];
    }
    changes[path] = dump(value);
  }
  function skill(path: string) {
    const current = get(path);
    if (current && current !== state.files[path]?.after)
      throw new Error('Unmanaged or modified skill conflict');
    changes[path] = readFileSync(join(app, 'skills', path.includes('continue-chat') ? 'continue-chat' : 'knit', 'SKILL.md'), 'utf8');
  }
  const hasKnit = existsSync(join(app, 'skills/knit/SKILL.md'));
  const hasContinue = existsSync(join(app, 'skills/continue-chat/SKILL.md'));
  const skillNames = [...(hasKnit ? ['knit'] : []), ...(hasContinue ? ['continue-chat'] : [])];
  if (!skillNames.length) throw new Error('Target runtime has no continuation skill');
  for (const name of skillNames) {
    if (opts.clients.some(client => client === 'codex' || client === 'antigravity')) skill('.agents/skills/' + name + '/SKILL.md');
    if (opts.clients.includes('claude-code')) skill('.claude/skills/' + name + '/SKILL.md');
  }
  for (const client of opts.clients) {
    if (client === 'claude-code') {
      mcp('.mcp.json');
      hooks('.claude/settings.local.json', 'claude');
    }
    if (client === 'claude-desktop')
      mcp('.memory/connectors/claude-desktop.json', true);
    if (client === 'antigravity') {
      mcp('.agents/mcp_config.json', false, 'antigravity');
      mcp('.memory/connectors/antigravity.json', false, 'antigravity');
      const path = '.agents/hooks.json',
        value = json(path);
      owned(path, ['shared-memory'], value['shared-memory']);
      value['shared-memory'] = {
        SessionStart: [handler('antigravity', 'recall')],
        Stop: [handler('antigravity', 'capture')],
      };
      changes[path] = dump(value);
    }
    if (client === 'codex') {
      hooks('.codex/hooks.json', 'codex');
      const path = '.codex/config.toml',
        current = get(path) ?? '';
      const parsed = parseToml(current);
      let base = current;
      if (current.includes(begin)) {
        const previous = state.files[path];
        const block = current.slice(
          current.indexOf(begin),
          current.indexOf(end) + end.length,
        );
        if (!previous || !previous.after.includes(block))
          throw new Error('Modified or unmanaged Codex config conflict');
        base = current.replace(block, '');
      } else if ((parsed.mcp_servers as any)?.['shared-memory'])
        throw new Error('Unmanaged Codex server conflict');
      changes[path] =
        base.trimEnd() +
        '\n\n' +
        begin +
        '\n[mcp_servers.shared-memory]\ndefault_tools_approval_mode = "writes"\ncommand = ' +
        JSON.stringify(node) +
        '\nargs = ' +
        JSON.stringify([server]) +
        '\ncwd = ' +
        JSON.stringify(workspace) +
        '\nenv = { ' +
        Object.entries({ ...env, MEMORY_CLIENT: 'codex' })
          .map(([k, v]) => k + ' = ' + JSON.stringify(v))
          .join(', ') +
        ' }\ntools.choose_conversation.approval_mode = "approve"\n' +
        end +
        '\n';
      parseToml(changes[path]);
    }
  }
  for (const [path, after] of Object.entries(changes))
    state.files[path] = {
      before: state.files[path]
        ? unapply(path, state.files[path], expected[path] ?? null)
        : (expected[path] ?? null),
      after,
    };
  expected[statePath] = read(join(workspace, statePath));
  changes[statePath] = dump(state);
  return { workspace, changes, expected };
}

export function applyConnectionPlan(plan: ConnectionPlan) {
  // Optimistic concurrency prevents applying a preview over later user edits.
  for (const [path, expected] of Object.entries(plan.expected))
    if (read(join(plan.workspace, path)) !== expected)
      throw new Error('Configuration changed since preview: ' + path);
  const written: string[] = [];
  try {
    for (const [path, content] of Object.entries(plan.changes)) {
      if (content === null) rmSync(join(plan.workspace, path), { force: true });
      else atomicWrite(join(plan.workspace, path), content);
      written.push(path);
    }
  } catch (error) {
    for (const path of written.reverse()) {
      const old = plan.expected[path];
      if (old === null || old === undefined)
        rmSync(join(plan.workspace, path), { force: true });
      else atomicWrite(join(plan.workspace, path), old);
    }
    throw error;
  }
  try {
    const git = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: plan.workspace,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    const path = join(git, 'info/exclude'),
      current = read(path) ?? '';
    const entries = [
      '/.memory/',
      ...Object.keys(plan.changes)
        .filter((p) => !p.startsWith('.memory/'))
        .map((p) => '/' + p),
    ];
    atomicWrite(
      path,
      current +
        '\n' +
        entries.filter((p) => !current.split('\n').includes(p)).join('\n') +
        '\n',
    );
  } catch {
    /* Non-Git projects can use the planner; CLI validates Git separately. */
  }
}

function unapply(
  path: string,
  snapshot: Snapshot,
  current: string | null,
): string | null {
  const { before, after } = snapshot;
  if (current === null || current === after)
    return current === null ? null : before;
  if (path.endsWith('.json')) {
    const restored = restore(
      before === null ? undefined : JSON.parse(before),
      JSON.parse(after),
      JSON.parse(current),
    );
    return restored === undefined ? null : dump(restored);
  }
  if (path.endsWith('.toml')) {
    const block = after.slice(
      after.indexOf(begin),
      after.indexOf(end) + end.length,
    );
    if (current.includes(block))
      return current.replace(block, '').trim() || before;
  }
  return current;
}

// Verification may await while users add unrelated JSON settings. Undo only our
// generated values rather than dropping those additions or abandoning rollback.
export function rollbackConnectionPlan(plan: ConnectionPlan) {
  for (const [path, before] of Object.entries(plan.expected).reverse()) {
    if (!(path in plan.changes)) continue;
    const after = plan.changes[path],
      target = join(plan.workspace, path),
      current = read(target);
    let restored: string | null;
    if (current === after) restored = before;
    else if (after !== null && current !== null)
      restored = unapply(path, { before, after }, current);
    else continue; // A new user-created value owns a file we removed.
    if (restored === current) continue;
    if (restored === null) rmSync(target, { force: true });
    else atomicWrite(target, restored);
  }
}

export function planUninstall(workspace: string): ConnectionPlan {
  const state = readConnectionState(workspace),
    changes: Record<string, string | null> = {},
    expected: Record<string, string | null> = {};
  for (const [path, snapshot] of Object.entries(state.files)) {
    const current = read(join(workspace, path));
    expected[path] = current;
    changes[path] = unapply(path, snapshot, current);
  }
  expected[statePath] = read(join(workspace, statePath));
  changes[statePath] = null;
  return { workspace, changes, expected };
}
export function uninstallConnections(workspace: string) {
  applyConnectionPlan(planUninstall(workspace));
}
