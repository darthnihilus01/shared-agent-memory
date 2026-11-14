import { canonicalWorkspace } from "./repository.ts";
import { historyTimestamp } from "./history-time.ts";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { captureTranscript, splitText } from "./transcript.ts";
import type { ClientName } from "./hooks.ts";
import { openQueue, flush, redact } from "./hooks.ts";
import { eventSchema } from "../../contracts/src/events.ts";
import type { MemoryStore } from "../../memory/src/store.ts";

export type Conversation = { id: string; title: string; workspace: string; root: string; modified: string; client?: ClientName; transcript?: string; branch?: string };

function workspaces(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = [value]; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === "string" && !!v).map(v =>
    v.startsWith("file:") ? fileURLToPath(v) : resolve(v));
}

export function findConversations(roots: string[], workspace?: string): Conversation[] {
  const found = new Map<string, Conversation>();
  const repositories = new Map<string, string | null>();
  const commonDirectory = (path: string) => {
    if (!repositories.has(path)) {
      try {
        repositories.set(path, execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          cwd: path, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
        }).trim());
      } catch { repositories.set(path, null); }
    }
    return repositories.get(path);
  };
  const expectedRepository = workspace ? commonDirectory(workspace) : null;
  for (const root of roots) {
    const path = join(root, "conversation_summaries.db");
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("SELECT conversation_id,title,workspace_uris,last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC").all();
      for (const row of rows) {
        const id = String(row.conversation_id);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
        for (const directory of workspaces(String(row.workspace_uris))) {
          if (workspace && canonicalWorkspace(directory) !== canonicalWorkspace(workspace) && (!expectedRepository || commonDirectory(directory) !== expectedRepository)) continue;
          const conversation = { id, title: String(row.title), workspace: directory, root, modified: String(row.last_modified_time) };
          const key = id + ":" + directory;
          const previous = found.get(key);
          if (!previous || historyTimestamp(conversation.modified) > historyTimestamp(previous.modified)) found.set(key, conversation);
        }
      }
    } finally { db.close(); }
  }
  return [...found.values()].sort((a, b) => historyTimestamp(b.modified) - historyTimestamp(a.modified));
}

export function selectConversation(conversations: Conversation[], query: string): Conversation {
  const matches = conversations.filter(c => c.id === query || c.title.toLowerCase() === query.toLowerCase());
  if (!matches.length) throw new Error("Conversation not found. Use the list command to find its exact title or ID.");
  if (matches.length > 1) throw new Error("Conversation title is ambiguous. Select its ID and workspace.");
  return matches[0];
}

export function importConversation(options: { conversation: Conversation; repoId: string; directory: string; store: MemoryStore }) {
  const { conversation, repoId, directory, store } = options;
  const client = conversation.client ?? "antigravity";
  const featureId = client + ":" + conversation.id;
  const scope = { repoId, featureId, ...(conversation.branch ? { branch: conversation.branch } : {}) };
  const transcript = conversation.transcript ?? join(conversation.root, "brain", conversation.id, ".system_generated/logs/transcript.jsonl");
  let source = "transcript";
  let captured = 0;
  if (existsSync(transcript)) {
    if (relative(realpathSync(conversation.root), realpathSync(transcript)).startsWith("..")) throw new Error("Transcript escapes the source data directory");
    let previousOffset = -1;
    for (;;) {
      const report = captureTranscript({ directory, client, scope, sessionId: conversation.id, path: transcript });
      captured += report.events;
      if (report.remainingBytes === 0 || report.offset === previousOffset) break;
      previousOffset = report.offset;
    }
  } else {
    if (client !== "antigravity") throw new Error("Selected conversation transcript is unavailable. Refresh the history list.");
    source = "conversation_index";
    const index = new DatabaseSync(join(conversation.root, "conversation_summaries.db"), { readOnly: true });
    const queue = openQueue(directory);
    try {
      const hasText = index.prepare("SELECT name FROM sqlite_master WHERE name='conversations_fts'").get();
      if (!hasText) throw new Error("This conversation has neither a readable transcript nor indexed text");
      queue.exec("BEGIN IMMEDIATE");
      try {
        const rows = index.prepare("SELECT chunk_index,user_body,agent_body FROM conversations_fts WHERE conversation_id=? ORDER BY CAST(chunk_index AS INTEGER)").iterate(conversation.id);
        for (const row of rows) {
          for (const [field, role] of [["user_body", "user"], ["agent_body", "assistant"]]) {
            if (typeof row[field] !== "string" || !row[field]) continue;
            const parts = splitText(redact(role + ": " + row[field]));
            for (const [part, content] of parts.entries()) {
              const sourceRef = "antigravity:index:chunk=" + row.chunk_index + ":" + field + ":part=" + part;
              const eventId = createHash("sha256").update(JSON.stringify({ scope, session: conversation.id, sourceRef, content })).digest("hex");
              const event = eventSchema.parse({ ...scope, sessionId: conversation.id, kind: "progress", content, eventId, source: sourceRef });
              queue.prepare("INSERT OR IGNORE INTO pending VALUES(?,?)").run(eventId, JSON.stringify(event));
              captured++;
            }
          }
        }
        if (!captured) throw new Error("No indexed conversation text was found");
        queue.exec("COMMIT");
      } catch (error) { queue.exec("ROLLBACK"); throw error; }
    } finally { queue.close(); index.close(); }
  }
  let delivered = 0;
  for (;;) {
    const report = flush(directory, e => { store.save(e); });
    delivered += report.delivered;
    if (report.pending === 0) break;
    if (report.delivered === 0) throw new Error("Memory delivery failed; imported events remain safely queued");
  }
  const total = store.context(scope).total;
  if (!total) throw new Error("No supported conversation text was imported");
  return { featureId, source, captured, delivered, total };
}
