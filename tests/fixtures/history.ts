import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export function historyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cross-history-'));
  const workspace = join(root, 'project'); mkdirSync(workspace);
  const roots = { antigravity: [join(root, 'agy')], codex: [join(root, 'codex')], claude: [join(root, 'claude')] };
  for (const directories of Object.values(roots)) mkdirSync(directories[0]);
  const ag = new DatabaseSync(join(roots.antigravity[0], 'conversation_summaries.db'));
  ag.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,last_modified_time TEXT)');
  ag.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?)').run('same-id', 'Antigravity chat', JSON.stringify([pathToFileURL(workspace).href]), '2026-11-14T12:00:00+05:30');
  ag.close();
  const agLog = join(roots.antigravity[0], 'brain/same-id/.system_generated/logs'); mkdirSync(agLog, { recursive: true });
  writeFileSync(join(agLog, 'transcript.jsonl'), JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Antigravity decision' }) + '\n');
  const rollout = join(roots.codex[0], 'sessions/rollout.jsonl'); mkdirSync(join(roots.codex[0], 'sessions'));
  writeFileSync(rollout, [
    { type: 'session_meta', payload: { id: 'same-id', cwd: workspace, source: 'cli' } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Codex decision api_key=secret-value' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'PRIVATE TOOL OUTPUT' } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const codex = new DatabaseSync(join(roots.codex[0], 'state_5.sqlite'));
  codex.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,source TEXT,git_branch TEXT)');
  const insert = codex.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)');
  insert.run('same-id', 'Codex chat', workspace, rollout, Date.parse('2026-11-14T08:00:00Z') / 1000, 'cli', 'feature/code');
  insert.run('other', 'PRIVATE OTHER PROJECT', root, rollout, Date.now() / 1000, 'cli', 'other');
  insert.run('child', 'PRIVATE SUBAGENT', workspace, rollout, Date.now() / 1000, '{"subagent":{"other":"guardian"}}', 'other');
  codex.close();
  const claudeProject = join(roots.claude[0], 'projects/encoded-project'); mkdirSync(claudeProject, { recursive: true });
  const claudeLog = join(claudeProject, 'same-id.jsonl');
  writeFileSync(claudeLog, [
    { type: 'user', sessionId: 'same-id', cwd: workspace, timestamp: '2026-11-14T07:00:00Z', message: { role: 'user', content: 'Claude question' } },
    { type: 'assistant', sessionId: 'same-id', cwd: workspace, timestamp: '2026-11-14T07:15:00Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: 'Claude decision' }] } },
    { type: 'ai-title', aiTitle: 'Claude chat', sessionId: 'same-id' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(claudeProject, 'other.jsonl'), JSON.stringify({ type: 'user', sessionId: 'other', cwd: root, timestamp: '2026-11-14T12:00:00Z', message: { role: 'user', content: 'PRIVATE OTHER PROJECT' } }) + '\n');
  return { root, roots, workspace };
}
