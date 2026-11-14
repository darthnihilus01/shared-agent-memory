# Knitt

Carry selected repository conversation context between coding agents. Choose the chat you want to continue, retrieve its checkpoint through MCP, and capture new progress using supported coding hooks.

## Installation

Knitt is published as `@tinchu0/knitt`. Node.js 24+ and Git are required.

```bash
npx @tinchu0/knitt@latest setup
```

To enable independent local session capture and checkpoint handoffs for a project:

```bash
npx @tinchu0/knitt@latest setup \
  --workspace /absolute/path/to/project --client codex --client claude-code \
  --capture-new-sessions
```

Setup shows configuration changes before applying them and installs a persistent runtime in your user data directory. Restart agents and approve their normal MCP/hook trust prompts. The npm installation path does not require Python or a source checkout. Version `0.1.0-beta.3` remains a preview; `latest` and `next` identify the current preview release.

The installer includes native Linux, macOS and Windows paths. Windows hooks use built-in Windows PowerShell; macOS and Linux use POSIX hooks. CI runs the full suite and packaged lifecycle checks on all three operating systems. Live application handoffs still require client-specific validation. Claude Desktop currently receives a configuration fragment requiring a manual merge into Desktop settings. No universal client compatibility is claimed.

See [npm installation and lifecycle](docs/clients/npm-installation.md) and [remote connector setup](docs/clients/connector-setup.md).

## What gets connected

- **Codex, Claude Code, Antigravity:** repository MCP settings and startup/stop hooks. Restart clients and approve MCP/hook trust normally.
- **Claude Desktop:** a generated local MCP fragment; chat checkpoints use tool calls rather than coding hooks.
- **ChatGPT / Claude web:** authenticated HTTP MCP is implemented, but requires your own public HTTPS endpoint and compatible OAuth provider. Local CLI setup does not provision a shared server.

The continue-chat skill calls the user picker. New sessions begin unselected. Legacy connections discover local Antigravity conversations. Opt-in local conversation mode also lists stored Knitt conversations and supported Codex/Claude Code JSONL histories, scoped to the connected repository and linked worktrees. It does not access arbitrary Claude or ChatGPT account histories. Ordinary chat MCP clients must explicitly call memory tools to save checkpoints; MCP alone cannot passively capture every chat turn.

Local memory is local to one machine. Team sharing requires a shared authenticated service; identical repository names do not synchronize databases.

## Memory behavior

The tools are `choose_conversation`, `get_context`, `search_memory`, `get_evidence` and `save_memory`; ordinary chat profiles also expose `start_session`. Local conversation mode additionally exposes `save_checkpoint` and requires the startup-issued session capability. Repository/session checks prevent one session from silently choosing another session's feature. The HTTP gateway validates JWT issuer, audience, expiry, subjects and scopes. Allowed users of a repository service share its feature evidence; finer team roles remain future work.

Evidence stores supported user/assistant text, with stable IDs for deduplication. Raw tool results, images and hidden reasoning are excluded. Bounded context reports truncation; search/evidence tools retrieve older detail. Recalled material can be stale or conflicting and is reference material, not authorization to edit files. Basic credential redaction is best effort.

## Development

```bash
npm ci
npm run check
npm test
npm run test:package
```

`test:package` builds and installs a real tarball, deletes the bootstrap copy, and verifies persistent MCP/hook execution, doctor, update, rollback, failed-install preservation and uninstall. It requires network access for production dependencies and an environment permitting child-process pipes.

The legacy Python development installer remains available under `scripts/connect.py`. Published CLI setup and handoff installation use the Node-only planner.

Knitt remains a preview. Automated and installed-package checks do not establish live compatibility with every client or platform. Building or packing alone does not publish to npm.

## License

Knitt is licensed under the [Apache License 2.0](LICENSE).


## Local conversation memory preview

Opt-in `setup --capture-new-sessions` adds independent coding-session histories, explicit continuation links and cited checkpoint-first recall. Existing connections remain compatible. See [local memory setup and recovery](docs/clients/local-agent-memory.md).

## Cross-agent continuation

Use `/knit` to choose one of the four most recent chats from other coding agents in the current project. The native picker preserves explicit selection and returns bounded context with acceptance, avoiding an extra context tool call. Search by title to find older chats.

See [the usage guide](docs/usage.md) for setup and supported clients. Existing opt-in local memory, checkpoints and evidence retrieval remain available through `/continue-chat`; that mode keeps its capability-scoped picker and context flow.
