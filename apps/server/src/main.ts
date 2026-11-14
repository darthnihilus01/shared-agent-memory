import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryServer } from "./server.ts";

const ownerId = process.env.MEMORY_CHAT_CLIENT ? 'local:' + process.env.MEMORY_CHAT_CLIENT : undefined;
const app = createMemoryServer(process.env, {
  ...(ownerId ? { ownerId } : {}), inChatPicker: true,
  preferChatPicker: ['chat', 'native_question'].includes(process.env.MEMORY_PICKER_MODE ?? ''),
});
await app.server.connect(new StdioServerTransport());
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.server.close();
  app.close();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

process.stdin.on('end', () => { void shutdown(); });
