import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Scope } from "./hooks.ts";

export function resolveConnection(payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const repoId = env.MEMORY_REPO;
  if (!repoId) throw new Error("Set MEMORY_REPO for the connected repository");
  const workspacePaths = payload.workspacePaths;
  const workspace = typeof payload.cwd === "string" ? payload.cwd :
    Array.isArray(workspacePaths) && workspacePaths.length === 1 && typeof workspacePaths[0] === "string"
      ? workspacePaths[0] : process.cwd();
  if (env.MEMORY_WORKSPACE && realpathSync.native(workspace) !== realpathSync.native(env.MEMORY_WORKSPACE)) {
    const commonGitDir = (cwd: string) => execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    let matches = false;
    try { matches = commonGitDir(workspace) === commonGitDir(env.MEMORY_WORKSPACE); } catch { /* Non-Git folders can only match by their canonical path. */ }
    if (!matches) {
      throw new Error("Wrong workspace. This memory connection belongs to " + env.MEMORY_WORKSPACE + ". Use the connection for the current project " + workspace + ". No memory was recalled or captured.");
    }
  }
  return { repoId, workspace };
}

export function resolveScope(payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Scope {
  const { repoId, workspace } = resolveConnection(payload, env);
  let branch = env.MEMORY_BRANCH;
  if (!branch && !env.MEMORY_FEATURE) {
    branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: workspace, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }
  const featureId = env.MEMORY_FEATURE ?? branch;
  if (!featureId) throw new Error("Detached HEAD requires an explicit MEMORY_FEATURE");
  return { repoId, featureId, ...(branch ? { branch } : {}) };
}
