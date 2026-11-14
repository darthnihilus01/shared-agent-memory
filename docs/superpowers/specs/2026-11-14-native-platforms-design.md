# Native Windows and macOS support

Approved scope: one npm package and setup command across Linux, macOS and native Windows. Installation, agent hooks, update, rollback and uninstall retain existing ownership/conflict checks and memory preservation. Node.js >=24 and Git remain prerequisites; Windows hooks use built-in Windows PowerShell.

Approaches: retain a single portable Node runtime (chosen by the user), or maintain separate OS installers (additional release and maintenance work). Use platform-specific hook serialization and shell-free npm invocation, preserving POSIX hooks on Linux/macOS. Keep the existing macOS data location and add Windows instructions for LOCALAPPDATA. No new UI or separate installers.

Automated checks run on ubuntu-latest, macos-latest and windows-latest. Package smoke checks exercise durable runtime installation, MCP and hook execution, updates, rollback, failed update preservation and uninstall. Local Linux verification cannot establish live macOS/Windows agent compatibility; distinguish configured CI from observed runs.
