# Connector setup

Run commands from the memory product checkout with Node 24+ and dependencies installed (`npm ci`). Replace `/path/to/repository` with the project you want to continue. These commands configure that repository, not the memory product itself.

## Claude Code

```bash
npm run connect -- --client claude-code --workspace /path/to/repository
```

This merges project MCP configuration, SessionStart/Stop hooks and the knit skill while preserving unrelated settings. Start a fresh Claude Code session in the target project, log in and approve the project MCP connection. Invoke `/knit`, select a conversation, and review the restored checkpoint before asking for implementation. Capture begins after selection. Hook execution depends on the client's trust settings.

## Claude Desktop local MCP

```bash
npm run connect -- --client claude-desktop --workspace /path/to/repository
```

The installer writes a configuration fragment to the project's `.memory/connectors/claude-desktop.json`. Merge its `mcpServers` entry into Claude Desktop's local MCP configuration on the same machine, then restart Desktop. Absolute executable, application and database paths must exist on that machine. This command prepares the fragment; it does not modify or verify the Desktop application.

The server instructs the agent to call `start_session`, then `choose_conversation`. Choose explicitly in the form when supported. The local fallback is the terminal handoff picker. Local Desktop chat uses tool-based saves; coding hooks do not capture ordinary Desktop chats.

## ChatGPT and Claude web

Generate a private setup profile:

```bash
npm run connect -- --client chatgpt --workspace /path/to/repository
npm run connect -- --client claude-web --workspace /path/to/repository
```

Without deployment values, these profiles report `configuration_required`. They do not establish a live connection. Complete a profile by rerunning with your actual values:

```bash
npm run connect -- --client chatgpt --workspace /path/to/repository \
  --public-url https://memory.example.com/mcp \
  --issuer https://identity.example.com \
  --subject YOUR_OAUTH_USER_SUBJECT
```

Repeat `--subject` to allow teammates. Use `--preview` to inspect setup without writing files. Profiles are stored under the product's ignored `.memory/connectors/` directory. The generated output supplies the exact command to start the server:

```bash
npm run serve:http -- --profile /absolute/path/to/generated-profile.json
```

The gateway listens on `127.0.0.1:8787`. Forward the entire dedicated HTTPS hostname through a reverse proxy or tunnel, including `/mcp`, discovery and picker routes. This release uses local SQLite: keep the database on durable storage beside the running service. It is not a stateless Cloud Run deployment recipe.

Configure an external OAuth/OIDC provider with authorization-code flow and PKCE S256. Its discovery document must identify the exact configured issuer and an HTTPS JWKS endpoint. Access tokens must be signed JWTs (RS256 or ES256), with an expiry, an allowlisted subject, audience equal to the public `/mcp` URL, and `memory:read` scope. Add `memory:write` for checkpoint saves. The provider must support the target client's registration or preconfigured client credentials and redirect URLs; this service does not implement an authorization server or dynamic client registration itself. Opaque access tokens are unsupported.

Add the public MCP URL as a custom remote connector in the chosen client and complete OAuth there. Provider setup and a live client login are required in addition to running this gateway. One gateway profile binds one repository; allowed users share selected feature evidence in that repository.

## Selecting and continuing

For ordinary chat clients, the flow is `start_session` → `choose_conversation` → explicit user selection → `get_context`. The server supplies instructions and returns the identifiers needed for later calls. A new chat must start a new session; another chat's selection is never chosen automatically. Session ownership is enforced for remote authenticated users.

When form elicitation is unavailable on the HTTP connection, `choose_conversation` returns a browser picker link. Open it, choose a chat, then return to the agent to retrieve context. Links expire after at most ten minutes and can be used once. The picker discovers local Claude Code, Codex and Antigravity histories in the connected repository, including its linked worktrees, newest first. Coding connections exclude the current agent. Remote web connectors can browse all three local sources, but do not browse remote ChatGPT or Claude account history.

Coding hooks capture supported user/assistant text. Ordinary chat connectors cannot passively export every conversation turn through MCP: the agent must call `save_memory` to store useful checkpoints. Restored evidence can omit images, raw tool output and hidden reasoning; it must not be treated as fresh permission to edit files.

## Verification status

The automated suite exercises real MCP HTTP connections, OAuth validation, explicit selection, single-use picker links, independent chat sessions, user ownership and write scopes. Local Claude Code configuration is installed and recognized by the CLI, pending login and MCP approval. Desktop configuration is generated but the application is untested. ChatGPT and Claude web are not live-connected: public HTTPS and OAuth configuration are still required. Browser picker endpoints are tested; visual rendering has not been independently verified.
