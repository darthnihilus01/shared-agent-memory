import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryStore } from "../../memory/src/store.ts";
import { findConversations, importConversation } from "./handoff.ts";
import { captureTranscript } from "./transcript.ts";
import { flush } from "./hooks.ts";
import { discoverJsonl } from "./providers/jsonl.ts";
import type { Conversation as LegacyConversation } from "./handoff.ts";
export type DiscoveredConversation = Omit<LegacyConversation, "client"> & {
  client: string;
  sourceId: string;
  storedId?: string;
  transcript?: string;
};
export type DiscoveryRoots = {
  codex: string;
  claude: string;
  antigravity: string[];
};
export function discoverConversations(
  store: MemoryStore,
  repoId: string,
  workspace: string,
  roots: DiscoveryRoots = {
    codex: join(homedir(), ".codex/sessions"),
    claude: join(homedir(), ".claude/projects"),
    antigravity: ["antigravity", "antigravity-cli", "antigravity-ide"].map(
      (n) => join(homedir(), ".gemini", n),
    ),
  },
) {
  const conversations: DiscoveredConversation[] = store
    .listConversations(repoId)
    .map((c) => ({
      id: c.conversationId,
      title: c.title,
      workspace,
      root: "",
      modified: "",
      client: c.client,
      sourceId: c.conversationId,
      storedId: c.conversationId,
    }));
  const diagnostics: string[] = [];
  for (const [client, root] of [
    ["codex", roots.codex],
    ["claude", roots.claude],
  ] as const) {
    const result = discoverJsonl(client, root, workspace);
    conversations.push(...result.conversations);
    diagnostics.push(...result.diagnostics);
  }
  try {
    conversations.push(
      ...findConversations(roots.antigravity, workspace).map((c) => ({
        ...c,
        id: "antigravity:" + c.id,
        sourceId: c.id,
        client: "antigravity",
      })),
    );
  } catch {
    diagnostics.push("Antigravity history unavailable or unsupported");
  }
  const seen = new Set<string>();
  const unique = conversations.filter((c) => {
    if (!c.storedId) {
      try {
        store.sessionConversation({
          repoId,
          client: c.client,
          nativeSessionId: c.sourceId,
        });
        return false;
      } catch {
        /* external conversation not captured yet */
      }
    }
    const identity = c.storedId ?? c.client + ":" + c.sourceId;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return { conversations: unique, diagnostics };
}
export function importDiscovered(
  store: MemoryStore,
  repoId: string,
  source: DiscoveredConversation,
  directory: string,
): string {
  if (source.storedId) {
    if (
      !store
        .listConversations(repoId)
        .some((c) => c.conversationId === source.storedId)
    )
      throw new Error("Unknown stored conversation");
    return source.storedId;
  }
  const key = {
    repoId,
    client: source.client,
    nativeSessionId: source.sourceId,
  };
  try {
    return store.sessionConversation(key).conversationId;
  } catch {
    /* Import only previously uncaptured sources. */
  }
  const conversation = store.ensureSession(key, {
    workspace: source.workspace,
  });
  const queue = join(
    directory,
    createHash("sha256").update(source.id).digest("hex"),
  );
  if (source.client === "antigravity") {
    const report = importConversation({
      conversation: { ...source, id: source.sourceId, client: "antigravity" },
      repoId,
      directory: queue,
      store,
    });
    store.importLegacyEvidence(key, report.featureId);
  } else {
    if (!source.transcript || !["codex", "claude"].includes(source.client))
      throw new Error("Unsupported history provider");
    let previous = -1;
    for (;;) {
      const report = captureTranscript({
        directory: queue,
        client: source.client as "codex" | "claude",
        scope: { repoId, featureId: conversation.conversationId },
        sessionId: source.sourceId,
        path: source.transcript,
        session: key,
      });
      if (report.remainingBytes === 0 || report.offset === previous) break;
      previous = report.offset;
    }
    for (;;) {
      const report = flush(queue, (event) => {
        store.appendEvidence(key, event);
      });
      if (!report.pending) break;
      if (!report.delivered)
        throw new Error("History remains queued; delivery failed");
    }
  }
  return conversation.conversationId;
}
