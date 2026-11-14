import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { npmCommand } from './platform.ts';
import { atomicWrite, type ConnectionOptions } from './connections.ts';
export const packageName = '@tinchu0/knitt';
export type Runtime = { version: string; appRoot: string; node: string };
export type Project = Pick<
  ConnectionOptions,
  'workspace' | 'repoId' | 'clients' | 'database' | 'captureNewSessions'
>;
export type Installation = {
  schema: 1;
  current: Runtime;
  previous?: Runtime;
  projects: Project[];
  antigravityConfig?: string;
};
export function defaultHome() {
  if (process.env.SHARED_MEMORY_HOME)
    return resolve(process.env.SHARED_MEMORY_HOME);
  if (process.platform === 'darwin')
    return join(homedir(), 'Library/Application Support/SharedAgentMemory');
  if (process.platform === 'win32')
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'),
      'SharedAgentMemory',
    );
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'),
    'shared-agent-memory',
  );
}
export function runtimePaths(home: string) {
  return {
    data: join(home, 'data'),
    versions: join(home, 'versions'),
    state: join(home, 'installation.json'),
  };
}
export function readInstallation(home: string): Installation | null {
  const path = runtimePaths(home).state;
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    value.schema !== 1 ||
    !value.current?.appRoot ||
    !Array.isArray(value.projects)
  )
    throw new Error('Invalid installation metadata');
  return value;
}
export async function withInstallLock<T>(
  home: string,
  work: () => Promise<T>,
): Promise<T> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, 'install.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      'Another installation is running, or a stale install.lock remains. Check for a running setup process before removing ' +
        lock,
    );
  }
  try {
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
      { mode: 0o600 },
    );
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
export function installRuntime(home: string, spec: string): Runtime {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Node.js 24 or newer is required');
  const paths = runtimePaths(home);
  mkdirSync(paths.versions, { recursive: true, mode: 0o700 });
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(paths.versions, '.staging-'));
  try {
    writeFileSync(
      join(staging, 'package.json'),
      JSON.stringify({ name: 'shared-memory-runtime', private: true }),
      { mode: 0o600 },
    );
    // Arguments are passed directly; no shell interpolation or install lifecycle scripts.
    const npm = npmCommand([
      'install',
      '--prefix',
      staging,
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '--',
      spec,
    ]);
    execFileSync(npm.command, npm.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });
    const root = join(staging, 'node_modules', packageName);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (
      pkg.name !== packageName ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)
    )
      throw new Error('Unexpected runtime package');
    for (const file of [
      'apps/server/src/main.js',
      'packages/installer/src/cli.js',
    ])
      if (!existsSync(join(root, 'dist', file)))
        throw new Error('Incomplete runtime: ' + file);
    execFileSync(
      process.execPath,
      [join(root, 'dist/packages/installer/src/cli.js'), '--version'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const destination = join(paths.versions, pkg.version + '-' + randomUUID());
    renameSync(staging, destination);
    return {
      version: pkg.version,
      node: process.execPath,
      appRoot: join(destination, 'node_modules', packageName, 'dist'),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
export function activateRuntime(
  home: string,
  current: Runtime,
  projects: Project[],
  antigravityConfig?: string,
) {
  const previous = readInstallation(home);
  atomicWrite(
    runtimePaths(home).state,
    JSON.stringify(
      {
        schema: 1,
        current,
        previous: previous?.current,
        projects,
        antigravityConfig: antigravityConfig ?? previous?.antigravityConfig,
      } satisfies Installation,
      null,
      2,
    ) + '\n',
  );
}

export function assertRuntimeCompatibility(
  runtime: Runtime,
  projects: Project[],
): void {
  const marker = join(runtime.appRoot, 'memory-schema.json');
  const supported = existsSync(marker)
    ? JSON.parse(readFileSync(marker, 'utf8')).supportedSchema
    : 0;
  if (!Number.isInteger(supported) || supported < 0)
    throw new Error('Invalid runtime schema compatibility metadata');
  for (const database of new Set(projects.map((p) => p.database))) {
    if (!existsSync(database)) continue;
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const actual = Number(
        db.prepare('PRAGMA user_version').get()!.user_version,
      );
      if (actual > supported)
        throw new Error(
          'Runtime is incompatible with memory schema ' +
            actual +
            '. Use a compatible runtime or explicitly restore a consistent backup; no data was changed.',
        );
    } finally {
      db.close();
    }
  }
}
