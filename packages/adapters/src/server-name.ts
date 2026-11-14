import { canonicalWorkspace } from './repository.ts';
import { createHash } from 'node:crypto';

// Antigravity's MCP registry is global; each project needs an independent name.
export function antigravityServerName(workspace: string) {
  return 'shared-memory-' + createHash('sha256').update(canonicalWorkspace(workspace)).digest('hex').slice(0, 12);
}
