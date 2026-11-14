import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { planConnection, applyConnectionPlan } from "../packages/installer/src/connections.ts";
import { createHash } from "node:crypto";
import { resolveRepository } from "../packages/adapters/src/repository.ts";

function secureUrl(value: string, name: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(name + " must be a clean HTTPS URL");
  return url;
}
try {
  const { values } = parseArgs({ options: {
    client: { type: "string" }, workspace: { type: "string", default: process.cwd() },
    "public-url": { type: "string" }, issuer: { type: "string" },
    subject: { type: "string", multiple: true }, preview: { type: "boolean", default: false },
  } });
  const client = values.client;
  if (!client || !["claude-code", "claude-desktop", "chatgpt", "claude-web"].includes(client)) {
    throw new Error("Choose --client claude-code, claude-desktop, chatgpt or claude-web");
  }
  const app = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const { workspace, repoId } = resolveRepository(resolve(values.workspace));
  if (client === "claude-code" || client === "claude-desktop") {
    const plan = planConnection({ workspace, appRoot: app, database: process.env.MEMORY_DB ?? join(app, ".memory/events.sqlite"), repoId, clients: [client] });
    for (const path of Object.keys(plan.changes)) console.log("merge " + join(workspace, path));
    if (!values.preview) applyConnectionPlan(plan);
    console.log(client === "claude-code"
      ? "Start a fresh Claude Code session in this workspace, approve its MCP connection if prompted, and use /knit."
      : "Merge the generated .memory/connectors/claude-desktop.json entry into Claude Desktop's local MCP configuration, restart Claude Desktop, then call start_session and choose_conversation.");
  } else {
    const publicUrl = values["public-url"] ? secureUrl(values["public-url"], "Public URL") : null;
    if (publicUrl) {
      if (!["/", "/mcp"].includes(publicUrl.pathname)) throw new Error("Use a dedicated HTTPS host or its /mcp endpoint");
      publicUrl.pathname = "/mcp";
    }
    if (values.issuer) secureUrl(values.issuer, "OAuth issuer");
    const missing = [
      ...(!publicUrl ? ["public HTTPS URL"] : []),
      ...(!values.issuer ? ["OAuth issuer"] : []),
      ...(!values.subject?.length ? ["allowed OAuth subject(s)"] : []),
    ];
    const profile = {
      client, status: missing.length ? "configuration_required" : "ready_to_serve", missing,
      server: {
        repoId, workspace, database: process.env.MEMORY_DB ?? join(app, ".memory/events.sqlite"),
        publicUrl: publicUrl?.href ?? null, issuer: values.issuer ?? null, allowedSubjects: values.subject ?? [],
      },
      connection: {
        name: "Shared Memory — " + workspace.split("/").at(-1),
        mcpUrl: publicUrl?.href ?? null, authentication: "OAuth 2.1",
        setup: client === "chatgpt" ? "Add a custom MCP connector in ChatGPT's developer/connector settings."
          : "Add a custom remote connector in Claude's connector settings.",
      },
      capture: "Tool-based saves. Ordinary chat clients do not expose coding-session capture hooks.",
    };
    const path = join(app, ".memory/connectors", client + "-" + createHash("sha256").update(repoId).digest("hex").slice(0, 8) + ".json");
    if (!values.preview) {
      mkdirSync(join(app, ".memory/connectors"), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
    }
    console.log(JSON.stringify({ path, ...profile }, null, 2));
    if (!missing.length) console.log("Start the authenticated gateway with: npm run serve:http -- --profile " + JSON.stringify(path));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
