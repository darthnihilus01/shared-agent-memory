import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ErrorRequestHandler } from "express";
import { createMemoryServer } from "./server.ts";
import { WebPicker, pickerHtml, pickerJs } from "./web-picker.ts";
import { z } from "zod";

export function createGateway(options: {
  resource: URL; repoId: string; workspace: string; database: string;
  metadata: OAuthMetadata; verifier: OAuthTokenVerifier; sourceRoots?: string[];
}) {
  const origin = options.resource.origin;
  const allowedOrigins = new Set([origin, "https://chatgpt.com", "https://claude.ai"]);
  const app = createMcpExpressApp({ allowedHosts: [options.resource.hostname, "127.0.0.1", "localhost", "[::1]"] });
  const picker = new WebPicker(options.database);
  app.set("env", "production");
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const requestOrigin = req.headers.origin;
    if (requestOrigin && !allowedOrigins.has(requestOrigin)) { res.status(403).json({ error: "Origin not allowed" }); return; }
    if (requestOrigin && req.path === "/mcp") {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-Id");
    }
    next();
  });
  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });
  app.use(mcpAuthMetadataRouter({
    oauthMetadata: options.metadata, resourceServerUrl: options.resource,
    scopesSupported: ["memory:read", "memory:write"], resourceName: "Shared Agent Memory",
  }));
  app.get("/pick", (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.type("html").send(pickerHtml);
  });
  app.get("/picker.js", (_req, res) => { res.type("application/javascript").send(pickerJs); });
  const ticketInput = z.object({ ticket: z.string().min(32).max(128), key: z.string().max(4).optional() });
  for (const action of ["options", "select", "cancel"] as const) {
    app.post("/picker/" + action, (req, res) => {
      if (req.headers.origin && req.headers.origin !== origin) { res.status(403).json({ error: "Open the picker on its original site" }); return; }
      try {
        const input = ticketInput.parse(req.body);
        if (action === "options") res.json({ choices: picker.options(input.ticket) });
        else if (action === "select") res.json(picker.select(input.ticket, input.key ?? ""));
        else { picker.cancel(input.ticket); res.json({ cancelled: true }); }
      } catch { res.status(400).json({ error: "Picker unavailable or invalid selection. Request a fresh picker in your chat." }); }
    });
  }
  app.options("/mcp", (_req, res) => { res.sendStatus(204); });
  app.use("/mcp", requireBearerAuth({
    verifier: options.verifier, requiredScopes: ["memory:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.resource), expectedResource: options.resource,
  }));
  app.post("/mcp", async (req, res) => {
    if (Array.isArray(req.body)) { res.status(400).json({ error: "Batch requests are not supported" }); return; }
    if (req.body?.method === "tools/call" && req.body?.params?.name === "save_memory" && !req.auth?.scopes.includes("memory:write")) {
      res.status(403).json({ error: "memory:write scope required" }); return;
    }
    const ownerId = req.auth?.extra?.ownerId;
    if (typeof ownerId !== "string" || !req.auth?.expiresAt) { res.status(401).json({ error: "Authenticated identity required" }); return; }
    const memory = createMemoryServer({
      MEMORY_DB: options.database, MEMORY_REPO: options.repoId, MEMORY_WORKSPACE: options.workspace,
      MEMORY_SESSION_SELECTION: "1", MEMORY_CLIENT: "web",
      ...(options.sourceRoots ? { MEMORY_SOURCE_ROOTS: JSON.stringify(options.sourceRoots) } : {}),
    }, {
      ownerId, canWrite: req.auth.scopes.includes("memory:write"),
      pickerLink: (sessionId, conversations) => picker.create(options.resource, {
        repoId: options.repoId, ownerId, sessionId, conversations,
      }, req.auth!.expiresAt!),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void memory.server.close().finally(() => memory.close()).catch(() => {});
    };
    res.on("close", close);
    try {
      await memory.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "Connector request failed" });
      close();
    }
  });
  app.all("/mcp", (_req, res) => { res.setHeader("Allow", "POST"); res.sendStatus(405); });
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json({ error: "Invalid request" }); };
  app.use(errors);
  return app;
}
