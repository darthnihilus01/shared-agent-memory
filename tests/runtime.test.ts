import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { npmCommand } from '../packages/installer/src/platform.ts';
import {
  runtimePaths,
  withInstallLock,
  installRuntime,
  activateRuntime,
  readInstallation,
} from '../packages/installer/src/runtime.ts';

test('runtime install is durable, versioned and does not replace active version on failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'durable runtime ü '));
  const home = join(root, 'home');
  const makePackage = (version: string) => {
    const dir = join(root, version);
    mkdirSync(join(dir, 'dist/apps/server/src'), { recursive: true });
    mkdirSync(join(dir, 'dist/packages/installer/src'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@tinchu0/knitt', version, type: 'module' }),
    );
    writeFileSync(join(dir, 'dist/apps/server/src/main.js'), 'export {};');
    writeFileSync(
      join(dir, 'dist/packages/installer/src/cli.js'),
      "console.log('runtime ok');",
    );
    const npm = npmCommand(['pack', '--json', '--pack-destination', root]);
    const result = JSON.parse(
      execFileSync(npm.command, npm.args, {
        cwd: dir,
        encoding: 'utf8',
      }),
    );
    return join(
      root,
      (Array.isArray(result) ? result[0] : (Object.values(result)[0] as any))
        .filename,
    );
  };
  try {
    const archive = makePackage('0.1.0');
    const first = installRuntime(home, archive);
    activateRuntime(home, first, []);
    rmSync(archive);
    assert.equal(
      execFileSync(
        process.execPath,
        [join(first.appRoot, 'packages/installer/src/cli.js')],
        { encoding: 'utf8' },
      ).trim(),
      'runtime ok',
    );
    const next = installRuntime(home, makePackage('0.2.0'));
    activateRuntime(home, next, []);
    assert.equal(readInstallation(home)?.previous?.version, '0.1.0');
    assert.throws(() => installRuntime(home, join(root, 'missing.tgz')));
    assert.equal(readInstallation(home)?.current.version, '0.2.0');
    assert.equal(existsSync(runtimePaths(home).data), true);
    await withInstallLock(home, async () => {
      await assert.rejects(
        withInstallLock(home, async () => {}),
        /installation.*running/i,
      );
    });
    assert.equal(existsSync(join(home, 'install.lock')), false);
    assert.ok(
      readFileSync(join(home, 'installation.json'), 'utf8').includes('0.2.0'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime downgrade refuses newer database before changing installation', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { assertRuntimeCompatibility } =
    await import('../packages/installer/src/runtime.ts');
  const root = mkdtempSync(join(tmpdir(), 'knitt-downgrade-'));
  const database = join(root, 'events.sqlite');
  try {
    const db = new DatabaseSync(database);
    db.exec('PRAGMA user_version=3');
    db.close();
    const old = { version: '0.1.0', appRoot: root, node: process.execPath };
    const project = {
      workspace: root,
      repoId: 'r',
      database,
      clients: ['codex'],
    };
    assert.throws(
      () => assertRuntimeCompatibility(old, [project]),
      /schema|compatible/,
    );
    writeFileSync(
      join(root, 'memory-schema.json'),
      JSON.stringify({ supportedSchema: 3 }),
    );
    assert.doesNotThrow(() => assertRuntimeCompatibility(old, [project]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
