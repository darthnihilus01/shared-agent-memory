import type { Conversation } from "./handoff.ts";

export function conversationLabel(conversation: Omit<Conversation, "client"> & { client?: string }): string {
  const name = conversation.client ? { codex: "Codex", claude: "Claude", antigravity: "Antigravity" }[conversation.client as "codex" | "claude" | "antigravity"] : undefined;
  return [(name ? "[" + name + "] " : "") + (conversation.title || "(untitled)"), conversation.workspace, conversation.modified]
    .join(" · ").replace(/[\x00-\x1f\x7f]/g, " ");
}

export async function pickConversation<T extends Omit<Conversation, "client"> & { client?: string }>(conversations: T[], io: {
  ask: (prompt: string) => Promise<string>; write: (text: string) => void;
}): Promise<T | null> {
  let query = "";
  let page = 0;
  for (;;) {
    const matches = conversations.filter(c => conversationLabel(c).toLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(matches.length / 15));
    page = Math.min(page, pages - 1);
    const visible = matches.slice(page * 15, page * 15 + 15);
    io.write("\nChoose the chat to continue. Page " + (page + 1) + "/" + pages + "\n");
    visible.forEach((conversation, i) => io.write(String(i + 1) + ". " + conversationLabel(conversation) + "\n"));
    if (!visible.length) io.write("No matching chats. Search again or cancel.\n");
    const answer = (await io.ask("Number, s <search>, n/p for pages, or Enter to cancel: ")).trim();
    if (!answer || answer.toLowerCase() === "q") return null;
    if (answer.startsWith("s ")) { query = answer.slice(2).trim().toLowerCase(); page = 0; continue; }
    if (answer === "n") { page = Math.min(page + 1, pages - 1); continue; }
    if (answer === "p") { page = Math.max(0, page - 1); continue; }
    if (/^[1-9][0-9]*$/.test(answer)) {
      const selected = visible[Number(answer) - 1];
      if (selected) return selected;
    }
    io.write("Choose a displayed number. Nothing has been selected.\n");
  }
}
