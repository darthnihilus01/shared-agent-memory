import { existsSync, readFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { antigravityServerName } from '../../adapters/src/server-name.ts';
import type { ConnectionOptions, ConnectionPlan } from './connections.ts';

type Options = { configPath: string; installationHome: string; appRoot: string; node?: string; removeOnly?: boolean; projects: Pick<ConnectionOptions, 'workspace' | 'repoId' | 'database' | 'clients' | 'captureNewSessions'>[] };
type Entry = { command: string; args: string[]; env: Record<string, string> };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : null;
const dump = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function defaultAntigravityConfig() {
  return resolve(process.env.KNITT_ANTIGRAVITY_CONFIG ?? join(homedir(), '.gemini/config/mcp_config.json'));
}
function entries(opts: Options): Record<string, Entry> {
  const extension = existsSync(join(opts.appRoot, 'apps/server/src/main.js')) ? 'js' : 'ts';
  return Object.fromEntries(opts.projects.filter(p => p.clients.includes('antigravity')).map(p => {
    const name = antigravityServerName(p.workspace);
    return [name, { command: opts.node ?? process.execPath, args: [join(opts.appRoot, 'apps/server/src/main.' + extension)], env: {
      MEMORY_CLIENT: 'antigravity', MEMORY_DB: resolve(p.database), MEMORY_REPO: p.repoId, MEMORY_WORKSPACE: p.workspace,
      MEMORY_SESSION_SELECTION: '1', MEMORY_MCP_SERVER: name,
      ...(p.captureNewSessions ? { MEMORY_CONVERSATION_MODE: '1', MEMORY_CAPTURE_NEW_SESSIONS: '1' } : { MEMORY_PICKER_MODE: 'native_question' }),
    } }];
  }));
}

// State is separate per installation, so another installation cannot claim these
// names or remove our entries. No path from the snapshot is used as a write target.
export function planAntigravity(opts: Options): ConnectionPlan {
  const workspace = dirname(resolve(opts.configPath)), configFile = basename(opts.configPath);
  const owner = createHash('sha256').update(resolve(opts.installationHome)).digest('hex').slice(0, 12);
  const stateFile = '.knitt-' + owner + '.json';
  const current = read(join(workspace, configFile)), stateText = read(join(workspace, stateFile));
  const state = stateText ? JSON.parse(stateText) : { schema: 1, servers: {} };
  if (state.schema !== 1 || !object(state.servers) || Object.keys(state.servers).some(k => !/^shared-memory-[a-f0-9]{12}$/.test(k))) throw new Error('Invalid Antigravity ownership state');
  const desired = entries(opts);
  // Non-Antigravity installations must not touch the global config directory.
  if (!Object.keys(desired).length && !stateText) return { workspace, expected: {}, changes: {} };
  const value = current ? JSON.parse(current) : {};
  if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers))) throw new Error('Antigravity mcp_config.json must contain an object with an mcpServers object');
  value.mcpServers ??= {};
  for (const [name, old] of Object.entries(state.servers)) {
    if (!(name in desired) && equal(value.mcpServers[name], old)) delete value.mcpServers[name];
  }
  const nextServers: Record<string, Entry> = {};
  for (const [name, entry] of Object.entries(desired)) {
    if (opts.removeOnly) {
      if (state.servers[name]) nextServers[name] = state.servers[name];
      continue;
    }
    const existing = value.mcpServers[name];
    if (existing !== undefined && (!state.servers[name] || !equal(existing, state.servers[name]))) throw new Error('Unmanaged or modified Antigravity server conflict: ' + name);
    value.mcpServers[name] = entry;
    nextServers[name] = entry;
  }
  return { workspace, expected: { [configFile]: current, [stateFile]: stateText }, changes: {
    [configFile]: dump(value), [stateFile]: Object.keys(nextServers).length ? dump({ schema: 1, servers: nextServers }) : null,
  } };
}

export async function verifyAntigravity(opts: Options) {
  const desired = entries(opts);
  if (!Object.keys(desired).length) return;
  const config = JSON.parse(readFileSync(opts.configPath, 'utf8'));
  for (const name of Object.keys(desired)) {
    const entry = config.mcpServers?.[name];
    const client = new Client({ name: 'knitt-setup-check', version: '1' });
    try {
      if (!entry || !equal(entry, desired[name])) throw new Error('Missing or modified server registration');
      await client.connect(new StdioClientTransport({ ...entry, env: { ...process.env as Record<string, string>, ...entry.env }, stderr: 'pipe' }), { timeout: 10_000 });
      const tools = (await client.listTools(undefined, { timeout: 10_000 })).tools;
      for (const tool of ['choose_conversation', 'get_context', 'get_evidence', 'search_memory', entry.env.MEMORY_CONVERSATION_MODE === '1' ? 'save_checkpoint' : 'save_memory']) {
        if (!tools.some(t => t.name === tool)) throw new Error('Missing tool ' + tool);
      }
    } catch (error) {
      throw new Error('Antigravity server connection/tools check failed for ' + name + ': ' + (error instanceof Error ? error.message : String(error)));
    } finally { await client.close(); }
  }
}
