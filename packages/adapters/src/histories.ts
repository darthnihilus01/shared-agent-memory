import { canonicalWorkspace } from './repository.ts';
import { historyTimestamp as timestamp } from './history-time.ts';
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { findConversations } from './handoff.ts';
import type { Conversation } from './handoff.ts';
import type { ClientName } from './hooks.ts';

export type HistoryRoots = Record<ClientName, string[]>;
export function defaultHistoryRoots(env: NodeJS.ProcessEnv = process.env): HistoryRoots {
  if (env.MEMORY_HISTORY_ROOTS) {
    const parsed: unknown = JSON.parse(env.MEMORY_HISTORY_ROOTS);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MEMORY_HISTORY_ROOTS must be an object');
    const roots = parsed as Record<string, unknown>;
    for (const client of ['antigravity', 'codex', 'claude']) if (!Array.isArray(roots[client]) || !(roots[client] as unknown[]).every(v => typeof v === 'string')) throw new Error('History roots must specify arrays for antigravity, codex and claude');
    return roots as HistoryRoots;
  }
  // Preserve explicit source-root overrides for isolated/legacy installations.
  if (env.MEMORY_SOURCE_ROOTS) {
    const roots: unknown = JSON.parse(env.MEMORY_SOURCE_ROOTS);
    if (!Array.isArray(roots) || !roots.every(v => typeof v === 'string')) throw new Error('MEMORY_SOURCE_ROOTS must be a string array');
    return { antigravity: roots, codex: [], claude: [] };
  }
  return {
    antigravity: ['antigravity', 'antigravity-cli', 'antigravity-ide'].map(name => join(homedir(), '.gemini', name)),
    codex: [env.CODEX_HOME ?? join(homedir(), '.codex')],
    claude: [env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')],
  };
}
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function inside(root: string, path: string) {
  if (!existsSync(path)) return false;
  const delta = relative(realpathSync(root), realpathSync(path));
  return delta !== '..' && !delta.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(delta);
}
function files(directory: string, recursive = false): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path);
    else if (recursive && entry.isDirectory()) found.push(...files(path, true));
  }
  return found;
}

// Discovery reads metadata from bounded head/tail windows, never whole API blobs.
// Importing the selected chat later reads the complete supported transcript text.
function metadata(path: string): Record<string, unknown>[] {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size, window = 256 * 1024;
    const records: Record<string, unknown>[] = [];
    const starts = size <= 2 * window ? [0] : [0, size - window];
    for (const start of starts) {
      const buffer = Buffer.alloc(Math.min(size - start, starts.length === 1 ? 2 * window : window));
      const count = readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, count).toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      if (start + count < size) text = text.slice(0, text.lastIndexOf('\n') + 1);
      for (const line of text.split('\n')) {
        try { const row: unknown = JSON.parse(line); if (object(row)) records.push(row); } catch { /* Incomplete/unsupported metadata is not conversation evidence. */ }
      }
    }
    return records;
  } finally { closeSync(fd); }
}
function mainSession(source: unknown) {
  if (object(source)) return !('subagent' in source);
  if (typeof source !== 'string') return true;
  try { const parsed: unknown = JSON.parse(source); return !object(parsed) || !('subagent' in parsed); } catch { return !source.toLowerCase().includes('subagent'); }
}
function discoverCodex(root: string): Conversation[] {
  if (!existsSync(root)) return [];
  const found: Conversation[] = [];
  const databases = readdirSync(root).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  for (const database of databases) {
    let db: DatabaseSync | undefined;
    const indexed: Conversation[] = [];
    try {
      db = new DatabaseSync(join(root, database), { readOnly: true });
      db.exec('PRAGMA busy_timeout=1000');
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => String(row.name)));
      if (!['id', 'cwd', 'rollout_path'].every(c => columns.has(c))) throw new Error('Unsupported Codex history index schema');
      const selected = ['id', 'cwd', 'rollout_path', 'title', 'name', 'first_user_message', 'updated_at_ms', 'updated_at', 'source', 'thread_source', 'git_branch'].filter(c => columns.has(c));
      for (const row of db.prepare('SELECT ' + selected.join(',') + ' FROM threads').all()) {
        if (!idValid(row.id) || typeof row.cwd !== 'string' || typeof row.rollout_path !== 'string' || !mainSession(row.source)) continue;
        if (typeof row.thread_source === 'string' && ['guardian_review', 'subagent'].some(v => String(row.thread_source).includes(v))) continue;
        const transcript = isAbsolute(row.rollout_path) ? row.rollout_path : resolve(root, row.rollout_path);
        if (!inside(root, transcript)) continue;
        const updated = timestamp(row.updated_at_ms ?? row.updated_at) || statSync(transcript).mtimeMs;
        indexed.push({ client: 'codex', id: row.id, title: String(row.title || row.name || row.first_user_message || 'Untitled Codex chat').slice(0, 256), workspace: row.cwd, root, transcript,
          modified: new Date(updated).toISOString(), ...(typeof row.git_branch === 'string' && row.git_branch ? { branch: row.git_branch } : {}) });
      }
      if (indexed.length) return indexed;
    } catch {
      // A native upgrade may leave a newer database incomplete or locked. Try
      // another supported index before discovering sessions directly.
    } finally { db?.close(); }
  }
  const titles = new Map<string, string>();
  const index = join(root, 'session_index.jsonl');
  if (existsSync(index)) for (const row of metadata(index)) if (idValid(row.id) && typeof row.thread_name === 'string') titles.set(row.id, row.thread_name);
  for (const transcript of [...files(join(root, 'sessions'), true), ...files(join(root, 'archived_sessions'), true)]) {
    if (!inside(root, transcript)) continue;
    const rows = metadata(transcript);
    const session = rows.find(row => row.type === 'session_meta');
    const meta = session?.payload;
    if (!object(meta) || !idValid(meta.id ?? meta.session_id) || typeof meta.cwd !== 'string' || !mainSession(meta.source)) continue;
    const id = String(meta.id ?? meta.session_id);
    const times = rows.map(row => timestamp(row.timestamp)).filter(Boolean);
    const git = object(meta.git) ? meta.git : {};
    found.push({ client: 'codex', id, title: titles.get(id) ?? 'Untitled Codex chat', workspace: meta.cwd, root, transcript,
      modified: new Date(times.length ? Math.max(...times) : statSync(transcript).mtimeMs).toISOString(), ...(typeof git.branch === 'string' ? { branch: git.branch } : {}) });
  }
  return found;
}
function discoverClaude(root: string): Conversation[] {
  const projects = join(root, 'projects');
  if (!existsSync(projects)) return [];
  const found: Conversation[] = [];
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const transcript of files(join(projects, project.name))) {
      if (!inside(root, transcript)) continue;
      const rows = metadata(transcript);
      const messages = rows.filter(row => ['user', 'assistant'].includes(String(row.type)) && row.isSidechain !== true);
      if (!messages.length) continue;
      const latest = [...messages].reverse().find(row => typeof row.cwd === 'string' && idValid(row.sessionId));
      if (!latest || typeof latest.cwd !== 'string' || !idValid(latest.sessionId)) continue;
      const titleRow = [...rows].reverse().find(row => (row.type === 'ai-title' && typeof row.aiTitle === 'string') || (row.type === 'custom-title' && typeof row.customTitle === 'string') || (row.type === 'summary' && typeof row.summary === 'string'));
      const message = object(messages[0].message) ? messages[0].message : {};
      const firstText = typeof message.content === 'string' ? message.content : '';
      const times = messages.map(row => timestamp(row.timestamp)).filter(Boolean);
      found.push({ client: 'claude', id: latest.sessionId, title: String(titleRow?.customTitle ?? titleRow?.aiTitle ?? titleRow?.summary ?? (firstText.slice(0, 120) || 'Untitled Claude chat')),
        workspace: latest.cwd, root, transcript, modified: new Date(times.length ? Math.max(...times) : statSync(transcript).mtimeMs).toISOString(),
        ...(typeof latest.gitBranch === 'string' && latest.gitBranch ? { branch: latest.gitBranch } : {}) });
    }
  }
  return found;
}
export function discoverHistories(options: { roots: HistoryRoots; workspace?: string; destination?: ClientName | 'web' }): Conversation[] {
  const repositories = new Map<string, string | null>();
  const common = (directory: string) => {
    if (!repositories.has(directory)) {
      try { repositories.set(directory, execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: directory, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
      catch { repositories.set(directory, null); }
    }
    return repositories.get(directory);
  };
  const expected = options.workspace ? common(options.workspace) : null;
  const matches = (directory: string) => !options.workspace || canonicalWorkspace(directory) === canonicalWorkspace(options.workspace) || (!!expected && common(directory) === expected);
  const found = new Map<string, Conversation>();
  const add = (conversations: Conversation[]) => {
    for (const conversation of conversations) {
      if (conversation.client === options.destination || !matches(conversation.workspace)) continue;
      const key = conversation.client + ':' + conversation.id;
      const previous = found.get(key);
      if (!previous || timestamp(conversation.modified) > timestamp(previous.modified)) found.set(key, conversation);
    }
  };
  if (options.destination !== 'antigravity') add(findConversations(options.roots.antigravity, options.workspace).map(c => ({ ...c, client: 'antigravity' })));
  if (options.destination !== 'codex') for (const root of options.roots.codex) add(discoverCodex(root));
  if (options.destination !== 'claude') for (const root of options.roots.claude) add(discoverClaude(root));
  return [...found.values()].sort((a, b) => timestamp(b.modified) - timestamp(a.modified) || String(a.client).localeCompare(String(b.client)) || a.id.localeCompare(b.id));
}
