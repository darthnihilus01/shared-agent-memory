# Native Platforms Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support the existing npm lifecycle on Linux, macOS and native Windows.
**Architecture:** Small platform module owns npm command discovery and hook serialization; existing installer retains configuration ownership and lifecycle logic.
**Tech Stack:** Node.js >=24, TypeScript, node:test, GitHub Actions.
**Spec:** docs/superpowers/specs/2026-11-14-native-platforms-design.md

## Global Constraints
- One npm package; preserve uncommitted user work.
- No shell interpolation of npm arguments; preserve hook stdin, output and exit status.
- Preserve managed ownership checks and user memory through lifecycle operations.

## Review Focus
- Paths containing spaces, apostrophes, Unicode and shell metacharacters.
- Windows npm.cmd cannot be launched with execFile.
- PowerShell encoding and native-process stdin/stdout forwarding.
- Git reports Windows paths with forward slashes; normalize repository identity.
- Legacy Python setup checks need Python 3.11+ on each CI runner.

### Task 1: Portable runtime and hooks
Files: packages/installer/src/platform.ts, runtime.ts, connections.ts; tests/platform.test.ts, installer.test.ts.
Interfaces: npmCommand returns command and args; hookCommand serializes env and executable argv for the platform; isManagedHook recognizes legacy and new commands.
- [x] Write and run failing tests for native Windows plans, hook execution/round-trip, ownership and shell-free npm discovery.
- [x] Implement platform module, remove blockers, integrate npm discovery and hook command generation.
- [x] Run targeted tests and TypeScript check.

### Task 2: Package and CI verification
Files: scripts/package-smoke.ts, .github/workflows/ci.yml, tests/setup.test.ts, tests/connector-setup.test.ts, docs/clients/npm-installation.md, README.md.
- [x] Make package smoke invoke npm without shell and execute hooks via each platform's native shell; exercise recall/capture with Unicode and spaces.
- [x] Add Windows CI and explicit Python setup; make legacy Python invocations portable if needed.
- [x] Update platform instructions and support evidence without claiming unobserved OS runs.
- [x] Run full tests, type check and tarball lifecycle smoke. Review diff for preservation of existing changes.

## Execution record
Planning: compact; context depth: dependency; verification depth: impact; delegation: none. Implement in the existing feature branch with user changes preserved. User explicitly approved implementation; no additional approval checkpoint needed.

## Verification results
- 2026-11-14: `npm test` — 54 passed, zero failures/skips on Linux.
- `npm run check` — passed.
- `npm run test:package` — passed after final source changes, including persistent MCP, Unicode capture/recall, doctor, update, rollback, failed update preservation and uninstall.
- `git diff --check` — passed.
- New platform tests initially failed because the platform module did not exist. The review regression for edited Windows launcher options failed before the ownership fix and passed afterward.
- Independent read-only review found two important issues: a remaining direct npm call in runtime tests, and launcher-option edits bypassing Windows hook ownership detection. Both were fixed and the full suite/package checks rerun.
- Native Windows/macOS execution and remote CI results have not been observed. Their CI matrix jobs and host-shell integration tests are configured; this is not a claim they have passed.

VERDICT: PASS — local implementation checks; native Windows/macOS verification remains pending.
