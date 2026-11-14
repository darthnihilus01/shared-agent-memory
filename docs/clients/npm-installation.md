# npm installation and runtime lifecycle

## Install the beta

```bash
npx --yes @tinchu0/knitt@next setup --workspace /path/to/project --client antigravity
```

Setup registers Antigravity’s global MCP server and verifies its memory tools automatically. Restart Antigravity and use `/knit` in a fresh chat. Choose a conversation inside the same coding interface. Antigravity uses its selectable question UI; clients with native MCP forms can use those.

## Test a local build

Build and pack from the repository:

```bash
npm ci
npm run check
npm run build
npm pack
```

Then use the tarball (absolute paths work from any directory):

```bash
npx --yes --package ./tinchu0-knitt-0.1.0-beta.5.tgz knitt setup \
  --workspace /path/to/project --client codex --client claude-code \
  --package /absolute/path/to/tinchu0-knitt-0.1.0-beta.5.tgz
```

The outer `--package` tells npx which CLI to run. The `--package` after `setup` tells setup which exact artifact to install persistently. For a local build, pass this second argument to setup/update so the persistent runtime uses your local artifact. For a published CLI, omitting it installs the CLI's exact published version. `update` follows the `next` registry tag for prerelease CLIs and `latest` for stable CLIs.

Use `--preview` to inspect changes without creating installation/configuration files. Interactive setup asks before applying; automation must pass `--yes`. Repeat `--client` for several agents. Setup requires Git repository metadata to derive a stable repository identity.

## Native platform setup

Install Node.js 24+ (including npm) and Git, and ensure both are on PATH. Use the same package on all platforms. Windows hooks use built-in Windows PowerShell 5.1 (`powershell.exe` on PATH); no WSL or Python is needed for npm setup. macOS and Linux hooks use their existing POSIX shell.

For a local build, pack the tarball as above, then run from its directory. Windows PowerShell example (one line, with quoted paths):

```powershell
npx --yes --package .\tinchu0-knitt-0.1.0-beta.5.tgz knitt setup --workspace "C:\Users\you\My Project" --client codex --client claude-code --package "C:\Downloads\tinchu0-knitt-0.1.0-beta.5.tgz"
```

macOS example:

```sh
npx --yes --package ./tinchu0-knitt-0.1.0-beta.5.tgz knitt setup --workspace "$HOME/Projects/My Project" --client codex --client claude-code --package "$HOME/Downloads/tinchu0-knitt-0.1.0-beta.5.tgz"
```

Replace the artifact path with its actual location. The existing lifecycle commands below work on each platform. Restart clients and approve their normal hook/MCP trust prompts. For Claude Desktop, merge the generated fragment into Desktop settings manually. For Antigravity, setup registers a separate server for each project in `~/.gemini/config/mcp_config.json`, preserving existing servers, and verifies its tool connection. Project `.agents/mcp_config.json` alone does not activate it. Override the global config location with `--antigravity-config PATH` during setup; the installer remembers it for later commands. `KNITT_ANTIGRAVITY_CONFIG` is an alternative override for isolated environments.

## Durable installation

The default installation directory is:

- Linux: `$XDG_DATA_HOME/shared-agent-memory` or `~/.local/share/shared-agent-memory`.
- macOS: `~/Library/Application Support/SharedAgentMemory`.
- Windows: `%LOCALAPPDATA%\SharedAgentMemory`, falling back to `~\AppData\Local\SharedAgentMemory`.

Override with `SHARED_MEMORY_HOME` or `--home /absolute/path`. The directory contains private `data/`, versioned runtime installations and `installation.json`. Node and runtime paths in generated settings are absolute. Upgrading/removing Node itself can invalidate the executable path; rerun setup with the new Node installation.

The setup process uses npm to install production dependencies in staging with dependency lifecycle scripts disabled. It verifies the packaged executable before rebinding connectors. The temporary npx cache can then be removed without breaking installed connections. Installation metadata uses an exclusive lock; after a crash, inspect the PID in `install.lock/owner.json` before removing a stale lock.

The project-local `.memory/npm-connection.json` records original and generated settings. Keep it until uninstall. Do not commit this private file. Existing Git excludes are extended for local generated settings. Existing Python-installed connections are considered unmanaged by the new CLI: they are not silently adopted or overwritten. Use a fresh project for the release candidate, or restore the legacy connector backups before migrating deliberately.

## Commands

Run commands through `npx --yes @tinchu0/knitt@next` or the local tarball CLI above:

```text
knitt setup --workspace PATH --client codex --preview
knitt doctor
knitt update --yes
knitt rollback --yes
knitt uninstall --workspace PATH --yes
knitt serve
```

Use the same `--home` for every lifecycle command if you customized it. `doctor` checks local installation/configuration, not account login or a live model handoff. Changed settings are reported for review.

Update installs another runtime before changing project connections. Failed dependency installation leaves the active installation metadata and bindings untouched. Rollback switches managed projects to the previous runtime, preserving memory. Old runtime directories remain available; garbage collection is not implemented.

Uninstall restores unchanged managed values and preserves independent additions or user edits. It removes one project's bindings and registry entry while retaining the runtime and all memory. It does not recursively delete the application directory or memory. Antigravity’s unchanged global entries are removed automatically; user-edited entries remain. The `.knitt-*.json` ownership file beside its MCP config is retained until the last managed entry is removed. Claude Desktop fragments must be removed manually from Desktop settings if previously merged there. Older manually merged Antigravity entries are not adopted or removed automatically.

## Release gates

The npm package is `@tinchu0/knitt`; prereleases use the `next` tag. Knitt is licensed under Apache-2.0; LICENSE ships in the archive. Linux tarball lifecycle checks cover automatic Antigravity registration, native session IDs, MCP tool discovery, updates, rollback after failed server verification and uninstall. CI is configured for Linux, macOS and Windows; native macOS/Windows runs and live client behavior remain unverified until observed.

ChatGPT, Claude web and teammate machines require a separately reachable authenticated service. Packaging a CLI does not supply hosting, authentication accounts or background synchronization.

### Optional local conversation mode

Add `--capture-new-sessions` to setup to opt a connected project into independent session capture and explicit continuation links. The preference survives subsequent setup/update operations. Existing connections keep their previous semantics until opted in. This mode upgrades the database using consistent SQLite backups; the updated installer blocks incompatible runtime downgrade rather than restoring data automatically. Use `doctor` for content-free capture status. See [setup and recovery](local-agent-memory.md).
