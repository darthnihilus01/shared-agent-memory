# Shared repository memory client evidence · 2026-11-12

| Client | MCP path | Capture and recall | Local evidence |
|---|---|---|---|
| Claude Desktop, Chat | Generated local stdio fragment or authenticated remote HTTP | Tool-based save/retrieval, explicit session and picker. No passive per-turn capture. | Local fragment generated; application handoff untested. |
| ChatGPT / Claude web | OAuth Streamable HTTP | Browser picker fallback and scoped checkpoint tools. | Gateway integration-tested; public deployment and OAuth setup pending. |
| Claude Desktop, local Code session | Claude Code integration | Candidate: Stop hook for capture, SessionStart for recall. Verify both on the desktop build and record trust settings. | Desktop runtime untested. |
| Claude Code CLI | Explicit MCP configuration | Stop provides session ID, transcript path and final message. Derive repository and branch from hook cwd in an opted-in checkout. | Version 2.1.322 recognizes installed project MCP configuration. Login and MCP approval pending; installer merges hooks and skill in tests. |
| Codex desktop | Plugin with trusted hooks | SessionStart can direct the agent to retrieve the briefing through MCP. Keep teammate-authored text in tool results because hook additionalContext has developer authority. | Desktop handoff untested. |
| Codex CLI | stdio or Streamable HTTP; HTTP bearer token can come from an environment variable | Same proposed startup recall as desktop. Validate capture separately before advertising reverse handoff. | Bundled CLI 0.167.0-alpha.3.2 reports stable hooks enabled and both MCP transports in help. |

| Antigravity IDE | Custom MCP plus SessionStart/Stop hooks | Capture handles transcriptPath and conversationId. Recall emits injectSteps with an MCP retrieval instruction. | CLI startup hook observed live. Quota blocked assistant response. USER_INPUT format observed; assistant formats fixture-tested. IDE UI handoff untested. |

## Test procedure

1. Use two clean checkouts of the synthetic repository. Associate the branch with retry-import and give the two test identities access to the repository. Supply the fixture facts only to the source client. Keep fixture, logs and source chat out of the receiver's checkout.
2. In the ordinary Desktop Chat test, enable the connector once. Discuss the fixture without asking Claude to save it. Inspect the service for attributable writes, including the rejected approach and its reason. If any are missing, record the outcome. Repeat independently in a Desktop Code session using a capture hook.
3. Open a fresh Codex session as the second identity and submit only the destination prompt. Check recall against each fixture fact, inspect retrieval logs, and record client versions, repo, branch and manual actions. A manually triggered save or pasted briefing fails the automatic-handoff criterion.
4. Control: repeat with memory disabled in a fresh checkout and session. Unexpected knowledge of the fixture invalidates the run. Also repeat on an unrelated feature to check isolation.

No end-to-end pass recorded. The hook-based Code path is a candidate for the pilot. Chat remains a separate compatibility target. No user conversation export or account configuration is needed for the fixture itself.

Sources: [Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities), [Desktop Code sessions](https://code.claude.com/docs/en/desktop), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex plugin trust and installation](https://developers.openai.com/plugins/build/plugins).

Adapter progress: incremental JSONL capture and a synthetic Antigravity hook-to-MCP handoff pass process integration tests. This is separate from the real two-user pilot above.

Live local result: fresh Codex sessions verified automatic Stop capture and startup-driven get_context recall. Both repository hooks were enabled through normal Codex review. Antigravity SessionStart ran, but account quota blocked the model response, so the real cross-agent handoff is pending.

## Installer operating-system evidence · 2026-11-14

| Platform | Implementation | Evidence |
|---|---|---|
| Linux | POSIX hooks and persistent npm runtime | Local full suite and packaged install, MCP, capture/recall, doctor, update, rollback, failed update and uninstall passed. |
| macOS | POSIX hooks; Application Support data location | CI configured on macos-latest; native run and live client handoff not observed in this change. |
| Windows | Native PowerShell hooks; shell-free npm JS entry point; LOCALAPPDATA storage | Windows command generation/npm discovery checked on Linux; CI configured on windows-latest. Native execution and live client handoff not yet observed. |

The matrix workflow runs Node.js 24 and Python 3.12. Python is used only by legacy source-installer tests, not the npm runtime. All runners execute type checking, the full suite and the tarball lifecycle smoke test. Configured CI is not evidence that a remote run has passed.


## Antigravity npm registration and picker · 2026-11-14

Npm setup now registers a separate MCP entry per project in Antigravity’s global config and verifies its five tools before runtime activation. Project hooks name that entry and supply the native chat ID. Antigravity shows conversation options inside the same chat because a recorded native-form request returned `selected: false` without an accepted choice. Other coding clients use native forms where supported and in-chat options otherwise. Tests exercise explicit selection, cancellation, session isolation, single-use choice IDs, preservation of unrelated settings and rollback on failed server verification. Automated process evidence does not establish that a human completed this flow inside each client. Browser pickers remain a remote HTTP connector feature.


## Cross-agent history discovery · 2026-11-14

Coding connections identify their host with MEMORY_CLIENT. The picker excludes that source before searching/limiting, merges local Claude Code project JSONL, Codex indexed/session-file history and Antigravity indexed history, labels the source and orders by timestamp newest first. Tests cover every host/source pair, same-ID collisions across agents, indexed and session-file Codex discovery, incomplete-index fallback, source/branch attribution, redaction, worktrees, unrelated projects and subagent exclusion. Local scans confirmed Claude and Codex discovery for Weave; actual rigved connections returned 16 Codex histories for Antigravity and seven Antigravity histories for Codex, without importing a choice. No local Claude history was found for rigved.

72 tests and the packaged install/update/rollback/uninstall smoke passed after the correction. Native visual behavior still depends on the host client; the test validates protocol behavior and source selection, not a human completing every client UI.
