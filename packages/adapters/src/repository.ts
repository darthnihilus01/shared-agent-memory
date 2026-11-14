import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function resolveRepository(directory: string) {
  const workspace = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  let repoId: string;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ssh = remote.match(/^[^@]+@([^:]+):(.+)$/);
    const url = ssh
      ? new URL("https://" + ssh[1] + "/" + ssh[2])
      : new URL(remote);
    repoId = (url.hostname + url.pathname)
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
  } catch {
    repoId =
      "local:" +
      createHash("sha256")
        .update(
          execFileSync(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            {
              cwd: workspace,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            },
          ).trim(),
        )
        .digest("hex");
  }
  return { workspace, repoId };
}

/** Compare the physical folder across symlinks and native path spellings. */
export function canonicalWorkspace(directory: string): string {
  try { return realpathSync.native(directory); } catch { return resolve(directory); }
}
