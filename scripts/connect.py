"""Prepare or apply repository-scoped Antigravity and Codex connections."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tomllib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--workspace", type=Path, default=Path.cwd())
parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parents[1])
parser.add_argument("--node", required=True)
parser.add_argument("--repo-id", required=True)
parser.add_argument("--apply", action="store_true")
parser.add_argument("--client", choices=["both", "codex", "antigravity", "claude-code", "claude-desktop"], default="both")
parser.add_argument("--feature-id")
parser.add_argument("--session-selection", action="store_true")
parser.add_argument("--database", type=Path)
args = parser.parse_args()
if args.session_selection and args.feature_id:
    sys.exit("Choose session selection or a fixed feature, not both")
workspace = args.workspace.resolve()
app = args.app_root.resolve()
node = str(Path(args.node).resolve())
runner = str(app / "packages/adapters/src/cli.ts")
server = str(app / "apps/server/src/main.ts")
database = str(args.database.resolve() if args.database else app / ".memory/events.sqlite")
if not workspace.is_dir() or not Path(node).is_file() or not Path(server).is_file():
    sys.exit("Workspace, Node executable and memory application must exist")
if not 0 < len(args.repo_id) <= 256:
    sys.exit("repo-id must contain between 1 and 256 characters")

def hook(client, action):
    feature = ["MEMORY_FEATURE=" + args.feature_id] if args.feature_id else []
    selection = ["MEMORY_SESSION_SELECTION=1"] if args.session_selection else []
    return shlex.join(["env", *feature, *selection, "MEMORY_REPO=" + args.repo_id,
        "MEMORY_WORKSPACE=" + str(workspace), "MEMORY_DB=" + database, "MEMORY_QUEUE=" + str(app / ".memory/queue" / client),
        node, runner, action, client])

def handler(client, action):
    return {"type": "command", "command": hook(client, action), "timeout": 10}

def existing(relative):
    path = workspace / relative
    return path.read_text() if path.exists() else None

def json_file(relative):
    text = existing(relative)
    value = json.loads(text) if text is not None else {}
    if not isinstance(value, dict):
        raise ValueError(str(relative) + " must contain a JSON object")
    return value

def is_ours(item):
    return isinstance(item, dict) and runner in item.get("command", "")

def dump(data):
    return json.dumps(data, indent=2) + "\n"

try:
    changes = {}
    if args.client in ["both", "antigravity"]:
        antigravity = json_file(".agents/hooks.json")
        previous = antigravity.get("shared-memory")
        if previous and not all(is_ours(h) for event in ["SessionStart", "Stop"] for h in previous.get(event, [])):
            raise ValueError("An unrelated Antigravity shared-memory hook already exists")
        antigravity["shared-memory"] = {
            "SessionStart": [handler("antigravity", "recall")],
            "Stop": [handler("antigravity", "capture")],
        }
        changes[".agents/hooks.json"] = dump(antigravity)

        mcp = json_file(".agents/mcp_config.json")
        servers = mcp.setdefault("mcpServers", {})
        connection = {"command": node, "args": [server], "cwd": str(workspace), "env": {"MEMORY_CLIENT": "antigravity", "MEMORY_PICKER_MODE": "native_question", "MEMORY_DB": database, "MEMORY_REPO": args.repo_id, "MEMORY_WORKSPACE": str(workspace), **({"MEMORY_SESSION_SELECTION": "1"} if args.session_selection else {}), **({"MEMORY_FEATURE": args.feature_id} if args.feature_id else {})}}
        if "shared-memory" in servers and servers["shared-memory"].get("args") != [server]:
            raise ValueError("An unrelated Antigravity shared-memory server already exists")
        servers["shared-memory"] = connection
        changes[".agents/mcp_config.json"] = dump(mcp)
        changes[".memory/connectors/antigravity.json"] = dump({"mcpServers": {"shared-memory": connection}})

    if args.client in ["both", "codex", "antigravity"]:
        skill_path = ".agents/skills/knit/SKILL.md"
        skill_text = (app / "skills/knit/SKILL.md").read_text()
        current_skill = existing(skill_path)
        if current_skill and "<!-- shared-agent-memory -->" not in current_skill:
            raise ValueError("An unrelated knit skill already exists")
        changes[skill_path] = skill_text

    if args.client in ["both", "codex"]:
        codex = json_file(".codex/hooks.json")
        hooks = codex.setdefault("hooks", {})
        for event, action in [("SessionStart", "recall"), ("Stop", "capture")]:
            groups = []
            for group in hooks.get(event, []):
                remaining = [h for h in group.get("hooks", []) if not is_ours(h)]
                if remaining:
                    groups.append({**group, "hooks": remaining})
            groups.append({"hooks": [handler("codex", action)]})
            hooks[event] = groups
        changes[".codex/hooks.json"] = dump(codex)

        original = existing(".codex/config.toml") or ""
        start, end = "# BEGIN shared-agent-memory", "# END shared-agent-memory"
        if start in original and end in original:
            begin, rest = original.split(start, 1)
            _, tail = rest.split(end, 1)
            original = begin.rstrip() + tail
        elif "shared-memory" in tomllib.loads(original).get("mcp_servers", {}):
            raise ValueError("An unmanaged Codex shared-memory server already exists")
        block = (
            start + "\n[mcp_servers.shared-memory]\ndefault_tools_approval_mode = \"writes\"\n"
            + "command = " + json.dumps(node) + "\n"
            + "args = " + json.dumps([server]) + "\n"
            + "cwd = " + json.dumps(str(workspace)) + "\n"
            + 'env = { MEMORY_CLIENT = "codex", MEMORY_DB = ' + json.dumps(database) + ", MEMORY_REPO = " + json.dumps(args.repo_id)
            + ", MEMORY_WORKSPACE = " + json.dumps(str(workspace))
            + (", MEMORY_FEATURE = " + json.dumps(args.feature_id) if args.feature_id else "")
            + (", MEMORY_SESSION_SELECTION = \"1\"" if args.session_selection else "") + " }\n"
            + ('tools.choose_conversation.approval_mode = "approve"\n' if args.session_selection else "") + end + "\n"
        )
        new_toml = original.rstrip() + "\n\n" + block
        tomllib.loads(new_toml)
        changes[".codex/config.toml"] = new_toml

    if args.client == "claude-code":
        mcp = json_file(".mcp.json")
        servers = mcp.setdefault("mcpServers", {})
        if "shared-memory" in servers and servers["shared-memory"].get("args") != [server]:
            raise ValueError("An unrelated Claude shared-memory server already exists")
        servers["shared-memory"] = {
            "command": node, "args": [server],
            "env": {"MEMORY_CLIENT": "claude", "MEMORY_DB": database, "MEMORY_REPO": args.repo_id, "MEMORY_WORKSPACE": str(workspace),
                    **({"MEMORY_SESSION_SELECTION": "1"} if args.session_selection else {}),
                    **({"MEMORY_FEATURE": args.feature_id} if args.feature_id else {})},
        }
        changes[".mcp.json"] = dump(mcp)
        settings = json_file(".claude/settings.local.json")
        hooks = settings.setdefault("hooks", {})
        for event, action in [("SessionStart", "recall"), ("Stop", "capture")]:
            groups = []
            for group in hooks.get(event, []):
                remaining = [h for h in group.get("hooks", []) if not is_ours(h)]
                if remaining:
                    groups.append({**group, "hooks": remaining})
            groups.append({"hooks": [handler("claude", action)]})
            hooks[event] = groups
        changes[".claude/settings.local.json"] = dump(settings)
        skill_path = ".claude/skills/knit/SKILL.md"
        if existing(skill_path) and "<!-- shared-agent-memory -->" not in existing(skill_path):
            raise ValueError("An unrelated Claude knit skill already exists")
        changes[skill_path] = (app / "skills/knit/SKILL.md").read_text()

    if args.client == "claude-desktop":
        name = "shared-memory-" + hashlib.sha256(args.repo_id.encode()).hexdigest()[:8]
        changes[".memory/connectors/claude-desktop.json"] = dump({"mcpServers": {name: {
            "command": node, "args": [server],
            "env": {"MEMORY_CLIENT": "claude", "MEMORY_DB": database, "MEMORY_REPO": args.repo_id, "MEMORY_WORKSPACE": str(workspace),
                    "MEMORY_SESSION_SELECTION": "1", "MEMORY_CHAT_CLIENT": "claude-desktop"},
        }}})

    if args.client in ["both", "antigravity"]:
        print("Antigravity: merge .memory/connectors/antigravity.json into ~/.gemini/config/mcp_config.json, then restart. This connection is bound to this project.")

    for relative, content in changes.items():
        print(("update " if existing(relative) != content else "unchanged ") + str(workspace / relative))
    if args.apply:
        private = workspace / ".memory"
        private.mkdir(mode=0o700, exist_ok=True)
        backup = private / "connection-backup.json"
        if not backup.exists():
            with backup.open("x") as f:
                os.chmod(backup, 0o600)
                json.dump({relative: existing(relative) for relative in changes}, f, indent=2)
        written = []
        before = {relative: existing(relative) for relative in changes}
        try:
            for relative, content in changes.items():
                if before[relative] == content:
                    continue
                path = workspace / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix(path.suffix + ".shared-memory-tmp")
                temporary.write_text(content)
                os.chmod(temporary, 0o600)
                os.replace(temporary, path)
                written.append(relative)
        except Exception:
            for relative in reversed(written):
                path = workspace / relative
                if before[relative] is None:
                    path.unlink()
                else:
                    path.write_text(before[relative])
            raise
        git_dir = subprocess.run(["git", "-C", str(workspace), "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True)
        if git_dir.returncode == 0:
            exclude = Path(git_dir.stdout.strip()) / "info/exclude"
            exclude.parent.mkdir(exist_ok=True)
            ignored = exclude.read_text() if exclude.exists() else ""
            entries = ["/.memory/", *["/" + name for name in changes]]
            additions = [entry for entry in entries if entry not in ignored.splitlines()]
            if additions:
                with exclude.open("a") as f:
                    f.write("\n# Local shared-agent-memory connection\n" + "\n".join(additions) + "\n")
        if args.client == "claude-code":
            print("Installed. Start a fresh Claude Code session and approve its project MCP connection.")
        elif args.client == "claude-desktop":
            print("Prepared the local Claude Desktop config fragment. Merge it into the desktop MCP configuration and restart the app.")
        else:
            print("Installed. Review Codex hooks in /hooks or Settings > Hooks. Start fresh agent sessions.")
    else:
        print("Preview only. Add --apply to install these repository-scoped entries.")
except (ValueError, OSError, TypeError, KeyError) as error:
    sys.exit(str(error))
