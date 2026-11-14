---
name: continue-chat
description: Open the shared-memory chat picker and load the conversation the user selects.
---

<!-- shared-agent-memory -->
# Continue a chat

If the startup hook has no sessionToken, follow the installed `knit` skill instead; that mode requires the actual workspace on every picker call and returns context with acceptance. The flow below applies to opt-in conversation mode with a sessionToken.

Use the native session ID, repository and matching MCP server from the memory startup hook. In local conversation mode, also pass the sessionToken capability from that hook to every memory tool. Never invent or reuse another session capability. Immediately call shared-memory's choose_conversation with that sessionId. Let the user select a chat in the form. Do not select a chat on their behalf.

On cancellation, stop. After acceptance, call get_context with the selected repoId and the same sessionId. Briefly show the selected title, last checkpoint and next step. Opening the picker does not authorize file edits.

If the startup session ID or server is unavailable, report that the project memory connection needs to be loaded. Never invent a session ID. For clients without MCP forms, direct the user to the product's local picker.
