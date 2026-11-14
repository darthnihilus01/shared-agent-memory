# Antigravity package registration fix

Intent: npm setup must make Knitt's MCP tools available in Antigravity without a manual configuration merge.

Planning: compact; context: owning modules and lifecycle callers; verification: lifecycle, package integration, type check; delegation: review only when the review skill requires it.

Design: register one global MCP entry per project, with a stable project-derived name and matching startup-hook instruction. Keep separate ownership snapshots per installation beside Antigravity's config. Preserve unrelated servers and user edits. Include global configuration in preview, optimistic concurrency, rollback, update and uninstall. Verify tools before activating a newly installed runtime. Persist the config location for update/rollback; provide an explicit config-path override for isolated tests. Claude Desktop retains its manual fragment workflow.

Acceptance:
- [x] Setup registers real global MCP entries and supplies native chat IDs.
- [x] Multiple projects coexist and hooks identify their correct server.
- [x] Preview is read-only; stale plans and unmanaged collisions fail safely.
- [x] Update/rollback/uninstall preserve unrelated servers and user edits.
- [x] Failed MCP verification restores config and active installation metadata.
- [x] Doctor detects missing/modified global registration.
- [x] Full tests, typecheck and packed lifecycle smoke pass.
- [ ] Versioned npm package is published to the existing next channel and verified.

Scope: preserve existing local feature/platform changes, incorporate them in the package artifact as required by the current working tree, and do not commit machine-specific connection files.

Screenshot follow-up: native form returned selected:false. Added loopback browser picker for Antigravity; link is shown to the user and selection/cancellation remain explicit. Existing remote picker ownership checks are reused.

Verification before publication: 63 tests pass; TypeScript and diff whitespace checks pass; packed install exercises global registration, native session IDs, browser selection, doctor missing-server detection, update, rollback after broken MCP verification and uninstall. Independent review found two lifecycle issues (uninstall of another edited project; concurrent JSON additions during rollback), both reproduced, fixed and re-reviewed clean. No live Antigravity browser interaction or native Windows/macOS run is claimed.

Publication status: package archive /tmp/tinchu0-knitt-0.1.0-beta.5.tgz is built and verified. Automatic approval review rejected public npm publish because the user authorized package integration but did not explicitly authorize this exact public publication. No publication was attempted after the rejection. Await explicit approval to publish @tinchu0/knitt@0.1.0-beta.5 with tag next and public access.

User correction: all coding selections must remain inside their coding interface. Removed the local browser picker. Antigravity uses returned in-chat choices, while other coding clients use native forms when available and in-chat choices otherwise. Opaque single-use choice IDs are bound to session and expire; the agent waits for explicit user choice before importing. Remote HTTP browser picker behavior is unchanged. The previously built release archive must be rebuilt before any publication.

Final correction verification: 64 tests pass; TypeScript and whitespace checks pass; packed lifecycle smoke passes with in-chat selection and automatic registration. Independent review found no actionable issues in the revised selection flow. The actual configured local server returned six in-chat options for the screenshot’s native session; no conversation was selected or imported. Local Antigravity global settings and managed /knit instructions were updated with backups. Rebuilt /tmp/tinchu0-knitt-0.1.0-beta.5.tgz excludes the removed local browser-picker module. Public npm release remains unapproved and unpublished.
