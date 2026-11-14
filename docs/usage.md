# How to use Knitt

Knitt carries selected conversation context between coding agents working on a Git project. Connect your project, choose the chat you want to continue, review the checkpoint, and tell the destination agent what to do next.

For example: discuss a feature in Antigravity, open the same project in Codex, and use Knitt to retrieve the earlier conversation before continuing implementation.

## 1. Prepare your machine

You need Node.js **24 or newer**, npm, Git, and a Git project to connect. Check your tools:

```bash
node --version
npm --version
git --version
```

The installer includes native Linux, macOS and Windows paths. Windows hooks require built-in Windows PowerShell; macOS and Linux use POSIX hooks. Linux checks passed locally; native Windows/macOS runs still need confirmation. Client configuration support does not guarantee that every client has passed a live handoff test. See the [client support evidence](clients/support-matrix.md).

## 2. Run the package

Use the published beta through npm’s `next` channel:

```bash
npx --yes @tinchu0/knitt@next --version
```

No source checkout is needed. To test a source build instead, see [local tarball installation](clients/npm-installation.md).

## 3. Connect your project

Replace `/absolute/path/to/your-project` below with the Git repository whose conversations you want to continue. This is your working project, which may be different from the Knitt source checkout.

First preview the configuration:

```bash
npx --yes @tinchu0/knitt@next setup \
  --workspace /absolute/path/to/your-project \
  --client codex --client antigravity \
  --preview
```

Then install:

```bash
npx --yes @tinchu0/knitt@next setup \
  --workspace /absolute/path/to/your-project \
  --client codex --client antigravity
```

Review the displayed changes and confirm in the terminal. For noninteractive setup, add `--yes` after `setup`; the outer `npx --yes` only approves npx's package prompt.

Supported `--client` values are `codex`, `claude-code`, `antigravity`, and `claude-desktop`. Repeat the flag for each client you use. Running setup without `--workspace` and `--client` asks for them interactively.

Setup installs a persistent runtime matching the CLI version. Connected agents use it independently of npx's temporary cache.

Restart connected agents, open the target project, and approve their normal MCP and hook trust prompts. Claude Desktop needs an extra manual step described below.

## 4. Choose a conversation and continue

In a fresh coding-agent session in the connected project, invoke the installed skill:

```text
/knit
```

If your client does not expose slash skills, ask:

> Use Knitt's shared-memory connection to open the conversation picker. Let me choose a chat, then retrieve its checkpoint and summarize the last progress and next step.

Choose the source conversation inside your coding interface. Antigravity opens its selectable question UI; click the conversation you want. Clients supporting native forms can show those directly. No browser or separate terminal is required for a connected coding client. Knitt requires the active folder on each coding-picker call and rejects a connection for a different project. The picker shows the project folder above its choices. It discovers local **Claude Code, Codex and Antigravity histories** belonging to that repository, including linked worktrees. It excludes the agent you are using, labels each source, and offers only the four most recent matching chats, newest first. It does not browse remote Claude or ChatGPT account history.

After selection, Knitt returns bounded context in the acceptance response and the agent shows the restored checkpoint. Older servers fall back to one `get_context` call. Review it, then give a concrete instruction, for example:

> Continue the retry implementation from this checkpoint. Inspect the current branch first and run the relevant tests after making changes.

Each new session starts without a selected conversation. Choose explicitly again when opening another session or moving to another connected agent. Canceling the picker leaves the chat unselected.

If the restored summary is missing a detail, ask:

> Search the selected conversation for why we rejected the earlier approach, and retrieve the original evidence before continuing.

The agent can use `search_memory` and `get_evidence` to retrieve details beyond the bounded checkpoint.

## 5. Preserve progress

For Codex, Claude Code, and Antigravity, setup installs startup and stop hooks. After conversation selection, supported coding hooks capture available user and assistant text when the client runs them. Capture depends on client support and hook trust; an installed configuration alone does not prove capture is working.

You can also ask the agent to save a checkpoint explicitly:

> Use save_memory to record the goal, decisions and their reasons, files changed, actual test results, blockers, and next step for this selected conversation.

For ordinary chat clients, explicit tool-based saves are required. MCP does not passively capture every chat turn.

Checkpoints are reference material: inspect current files and branch state before acting on them. Knitt excludes raw tool results, images, and hidden reasoning. Credential redaction is best effort, so avoid putting secrets in saved text.

## Claude Desktop, ChatGPT, and Claude web

**Antigravity:** setup automatically registers and verifies a project-specific memory server in `~/.gemini/config/mcp_config.json`, preserving existing servers. Restart Antigravity and use `/knit` in a fresh chat. Choose a conversation inside the same coding interface. Antigravity uses its selectable question UI; clients with native MCP forms can use those. Several projects can coexist; startup hooks identify the matching server. Update, rollback and uninstall manage Knitt’s unchanged entries. Use `--antigravity-config PATH` during setup if your installation uses another location; subsequent lifecycle commands remember that path.

**Claude Desktop:** select `--client claude-desktop` during setup. Merge the generated project's `.memory/connectors/claude-desktop.json` `mcpServers` entry into Desktop's local MCP settings, then restart Desktop. Knitt generates the fragment; it does not perform this merge for you.

In a new ordinary chat, ask the agent to call `start_session`, then `choose_conversation`, wait for your selection, and summarize the returned context (or call `get_context` if using the browser fallback). Use the session ID returned for that chat. Ask for `save_memory` after substantive progress.

**ChatGPT and Claude web:** require a separately hosted HTTPS MCP endpoint and a compatible OAuth provider. Local CLI setup does not deploy that service. Follow [remote connector setup](clients/connector-setup.md) for profiles, authentication requirements, and browser picker behavior. These clients are not assumed to be live-connected by completing the local quickstart.

Local memory lives on one machine. Connecting another machine or using an identical repository name does not synchronize it; team sharing requires a shared authenticated service.

## Manage your installation

Use the same npm channel and, if configured, the same `--home /absolute/path` for all commands.

Check the installation:

```bash
npx --yes @tinchu0/knitt@next doctor
```

`configured` means local paths and managed settings passed inspection. It does not verify client login, trust approval, or a live handoff.

To install a newer local artifact, build that version, set its absolute path, and update:

```bash
KNITT_NEXT_TARBALL="/absolute/path/to/new-knitt-package.tgz"
npx --yes --package "$KNITT_NEXT_TARBALL" knitt update \
  --package "$KNITT_NEXT_TARBALL" --yes
```

Return to the previous runtime, if an earlier installation exists:

```bash
npx --yes @tinchu0/knitt@next rollback --yes
```

Disconnect one project:

```bash
npx --yes @tinchu0/knitt@next uninstall \
  --workspace /absolute/path/to/your-project --yes
```

Uninstall restores unchanged managed settings while retaining user edits, the runtime, and memory. If you manually merged a Desktop fragment, remove that entry from Desktop settings yourself. See [installation and lifecycle](clients/npm-installation.md) for storage locations and recovery details.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No shared-memory tools or `/knit` | Restart the client in the connected project. Check MCP and hook trust prompts, then run `doctor`. |
| No conversations in the picker | Confirm another coding agent has a local history for this repository or its worktrees. The current agent’s own chats are excluded. Try searching the source title. Remote account histories are not imported. |
| Client cannot show a selection form | The agent must invoke the application’s native question tool with Knitt’s returned options. A printed list is not the picker. If the question tool is unavailable, native selection is unavailable in that session. Remote web connectors may use a browser picker. |
| “No chat selected” | Open the picker and choose a conversation in this session before retrieving or saving context. |
| Missing startup session ID | Reload the project's memory connection and start a fresh session. Ordinary chat clients use `start_session`; do not invent an ID. |
| “Wrong repository” or “different conversation” | Open the intended project and choose its chat in the current session. |
| Unmanaged or modified connector conflict | Review the named configuration file. Existing legacy or manually edited settings are not automatically overwritten. See the lifecycle guide before migrating. |
| Missing runtime path after changing Node | Rerun setup using the current Node installation. Generated executable paths are absolute. |
| Recent work is absent | Check that selection happened before capture, hooks were trusted and executed, or an explicit `save_memory` call succeeded. |

### Source-checkout fallback: Antigravity to Codex

Run these commands from the Knitt source checkout with dependencies installed:

```bash
npm run memory -- list --workspace /absolute/path/to/your-project
npm run memory -- handoff --workspace /absolute/path/to/your-project --preview
npm run memory -- handoff --workspace /absolute/path/to/your-project --launch
```

The handoff command opens a terminal picker. `--preview` reports the selected handoff without importing or configuring it; `--launch` imports it, configures Codex, and launches Codex in the destination workspace. You can pass `--conversation TITLE_OR_ID` for an explicit selection.

This is a separate source-development workflow: it defaults to the checkout's `.memory/events.sqlite`, whereas npm setup uses the persistent installation's data directory. Set `MEMORY_DB` to the intended database if deliberately sharing them. Handoff applies connector settings and may report a conflict with an already managed connection; review that configuration before switching workflows.
