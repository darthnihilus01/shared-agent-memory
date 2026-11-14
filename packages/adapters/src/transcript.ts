import type { SessionKey } from "../../contracts/src/conversations.ts";
import { sessionKeySchema } from "../../contracts/src/conversations.ts";
import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { openQueue, redact } from "./hooks.ts";
import type { ClientName, Scope } from "./hooks.ts";
import { eventSchema } from "../../contracts/src/events.ts";

type CaptureOptions = {
  directory: string;
  client: ClientName;
  scope: Scope;
  sessionId: string;
  path: string;
  session?: SessionKey;
};
const windowBytes = 4 * 1024 * 1024;
const maxLineBytes = 1024 * 1024;
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) => {
      if (
        block &&
        typeof block === "object" &&
        typeof block.text === "string" &&
        (!block.type ||
          ["text", "input_text", "output_text"].includes(block.type))
      )
        return [block.text];
      return [];
    })
    .join("\n");
}

function messageText(row: Record<string, any>): string | null {
  if (row.isSidechain === true) return null;
  if (row.type === "USER_INPUT" && typeof row.content === "string") {
    const request = row.content.match(
      /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/,
    );
    return "user: " + (request ? request[1].trim() : row.content);
  }
  if (
    ["PLANNER_RESPONSE", "ASSISTANT_MESSAGE"].includes(row.type) &&
    typeof row.content === "string"
  ) {
    return "assistant: " + row.content;
  }
  const message =
    row.type === "response_item" ? row.payload : (row.message ?? row);
  if (!message || typeof message !== "object") return null;
  const role =
    message.role ??
    (["user", "assistant"].includes(row.type) ? row.type : undefined);
  if (!["user", "assistant", "model"].includes(role)) return null;
  const text = textBlocks(message.content ?? message.parts);
  const blocks = message.content ?? message.parts;
  const onlyNonText =
    Array.isArray(blocks) &&
    blocks.every(
      (block) =>
        block &&
        typeof block === "object" &&
        [
          "tool_use",
          "tool_result",
          "thinking",
          "redacted_thinking",
          "image",
        ].includes(block.type),
    );
  if (!text && !onlyNonText)
    throw new Error("Unsupported transcript message shape for role " + role);
  return text ? role + ": " + text : null;
}

export function splitText(text: string): string[] {
  const result: string[] = [];
  let part = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 6000) {
      result.push(part);
      part = "";
      bytes = 0;
    }
    part += char;
    bytes += size;
  }
  if (part) result.push(part);
  return result;
}

/** Queue complete JSONL records and their cursor atomically. Never advance past an unfinished line. */
export function captureTranscript(options: CaptureOptions) {
  const { directory, client, scope, sessionId } = options;
  if (!sessionId) throw new Error("Transcript has no session identity");
  const path = resolve(options.path);
  const fd = openSync(path, "r");
  const queue = openQueue(directory);
  let transaction = false;
  try {
    queue.exec(
      "CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY, offset INTEGER NOT NULL, prefix TEXT NOT NULL)",
    );
    queue.exec("BEGIN IMMEDIATE");
    transaction = true;
    if (options.session) {
      sessionKeySchema.parse(options.session);
      if (
        options.session.repoId !== scope.repoId ||
        options.session.client !== client ||
        options.session.nativeSessionId !== sessionId
      )
        throw new Error("Queued session identity mismatch");
    }
    const identityScope = options.session
      ? { repoId: scope.repoId, featureId: scope.featureId }
      : scope;
    const key = hash(
      JSON.stringify({ client, scope: identityScope, sessionId, path }),
    );
    const previous = queue
      .prepare("SELECT offset,prefix FROM cursors WHERE id=?")
      .get(key);
    const size = fstatSync(fd).size;
    let offset = previous ? Number(previous.offset) : 0;
    const prefix = (length: number) => {
      const buffer = Buffer.alloc(Math.min(length, 128));
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      return hash(buffer.subarray(0, count));
    };
    if (offset > size || (previous && prefix(offset) !== previous.prefix))
      offset = 0;
    const buffer = Buffer.alloc(Math.min(size - offset, windowBytes));
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    let start = 0;
    let events = 0;
    let records = 0;
    while (start < read && records < 500) {
      const end = buffer.indexOf(10, start);
      if (end < 0 || end >= read) break;
      if (end - start > maxLineBytes)
        throw new Error("Transcript line exceeds 1 MiB");
      const line = buffer.subarray(start, end).toString("utf8").trim();
      if (line) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          throw new Error(
            "Invalid transcript JSON at byte " + (offset + start),
          );
        }
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw new Error("Invalid transcript record");
        const text = messageText(row);
        if (text) {
          const contentParts = splitText(redact(text));
          for (const [index, content] of contentParts.entries()) {
            const event = eventSchema.parse({
              ...scope,
              sessionId,
              kind: "progress",
              content,
              eventId: hash(
                JSON.stringify({
                  client,
                  scope: identityScope,
                  sessionId,
                  byte: offset + start,
                  index,
                  content,
                }),
              ),
              source:
                client +
                ":transcript:line-byte=" +
                (offset + start) +
                ":part=" +
                index,
            });
            queue
              .prepare("INSERT OR IGNORE INTO pending VALUES(?,?)")
              .run(event.eventId, JSON.stringify(event));
            if (options.session)
              queue
                .prepare("INSERT OR IGNORE INTO pending_sessions VALUES(?,?)")
                .run(event.eventId, JSON.stringify(options.session));
            events++;
          }
        }
      }
      records++;
      start = end + 1;
    }
    if (read - start > maxLineBytes && records < 500)
      throw new Error("Transcript line exceeds 1 MiB");
    const nextOffset = offset + start;
    queue
      .prepare(
        "INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset,prefix=excluded.prefix",
      )
      .run(key, nextOffset, prefix(nextOffset));
    queue.exec("COMMIT");
    transaction = false;
    return {
      events,
      records,
      offset: nextOffset,
      remainingBytes: size - nextOffset,
    };
  } finally {
    if (transaction) queue.exec("ROLLBACK");
    queue.close();
    closeSync(fd);
  }
}
