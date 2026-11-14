#!/usr/bin/env node
import { readCaptureStatuses } from '../../adapters/src/status.ts';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname, basename } from 'node:path';
import {
  existsSync,
  readFileSync,
  accessSync,
  constants,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  planConnection,
  applyConnectionPlan,
  planUninstall,
  clients,
  atomicWrite,
  readConnectionState,
  rollbackConnectionPlan,
  type ConnectionPlan,
} from './connections.ts';
import {
  installRuntime,
  readInstallation,
  defaultHome,
  runtimePaths,
  withInstallLock,
  activateRuntime,
  assertRuntimeCompatibility,
  packageName,
  type Project,
  type Runtime,
} from './runtime.ts';
import {
  planAntigravity,
  verifyAntigravity,
  defaultAntigravityConfig,
} from './antigravity.ts';
import { antigravityServerName } from '../../adapters/src/server-name.ts';
import { resolveRepository } from '../../adapters/src/repository.ts';
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = existsSync(join(appRoot, 'package.json'))
  ? appRoot
  : dirname(appRoot);
const metadata = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
);
const version = metadata.version as string;

async function confirm(text: string, yes = false) {
  if (yes) return true;
  if (!process.stdin.isTTY)
    throw new Error(
      'Use --yes for noninteractive apply, or --preview to inspect without changes',
    );
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return /^y(es)?$/i.test((await reader.question(text + ' [y/N] ')).trim());
  } finally {
    reader.close();
  }
}
async function ask(prompt: string) {
  if (!process.stdin.isTTY)
    throw new Error('Pass --workspace and --client for noninteractive setup');
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}
function preview(plan: ConnectionPlan, contents = true) {
  for (const [path, content] of Object.entries(plan.changes)) {
    if (path.includes('npm-connection')) continue;
    console.log(
      (content === null ? 'remove ' : 'merge ') + join(plan.workspace, path),
    );
    if (contents && content !== null && content !== plan.expected[path])
      console.log(content);
  }
}
async function applyAll(
  plans: ConnectionPlan[],
  commit: () => void,
  verify: () => Promise<void> = async () => {},
) {
  const done: ConnectionPlan[] = [];
  try {
    for (const plan of plans) {
      applyConnectionPlan(plan);
      done.push(plan);
    }
    await verify();
    commit();
  } catch (error) {
    for (const plan of done.reverse()) rollbackConnectionPlan(plan);
    throw error;
  }
}
function plansFor(runtime: Runtime, projects: Project[]) {
  return projects.map((project) =>
    planConnection({
      ...project,
      appRoot: runtime.appRoot,
      node: runtime.node,
    }),
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      session: { type: 'string' },
      workspace: { type: 'string' },
      client: { type: 'string', multiple: true },
      home: { type: 'string' },
      package: { type: 'string' },
      yes: { type: 'boolean' },
      preview: { type: 'boolean' },
      'capture-new-sessions': { type: 'boolean' },
      'antigravity-config': { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.version) {
    console.log(version);
    return;
  }
  const action = positionals[0];
  if (!action || values.help) {
    console.log(
      'Knitt ' +
        version +
        '\nCommands: setup, doctor, update, rollback, uninstall, serve, continue\nOptions: --workspace PATH --client codex|claude-code|antigravity|claude-desktop (repeatable)\n         --antigravity-config PATH --capture-new-sessions --preview --yes --home PATH --package TARBALL_OR_VERSION_SPEC\nSetup configures a persistent local runtime; remote/team service is configured separately.',
    );
    return;
  }
  const home = resolve(values.home ?? defaultHome()),
    paths = runtimePaths(home);
  if (action === 'continue') {
    if (!values.workspace)
      throw new Error('Pass --workspace for the connected project');
    const common = (cwd: string) =>
      execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    const expected = common(resolve(values.workspace));
    const state = readInstallation(home);
    const project = state?.projects.find((p) => {
      try {
        return common(p.workspace) === expected;
      } catch {
        return false;
      }
    });
    if (!project?.captureNewSessions)
      throw new Error(
        'This project has not opted into local conversation mode; run setup --capture-new-sessions first',
      );
    process.env.MEMORY_DB = project.database;
    process.env.MEMORY_REPO = project.repoId;
    process.env.MEMORY_CONVERSATION_MODE = '1';
    await import('../../adapters/src/command.ts');
    return;
  }
  const initialState = readInstallation(home);
  const configPath = resolve(
    values['antigravity-config'] ??
      initialState?.antigravityConfig ??
      defaultAntigravityConfig(),
  );
  const globalOptions = (runtime: Runtime, projects: Project[]) => ({
    configPath,
    installationHome: home,
    appRoot: runtime.appRoot,
    node: runtime.node,
    projects,
  });
  if (
    initialState?.antigravityConfig &&
    configPath !== resolve(initialState.antigravityConfig)
  )
    throw new Error(
      'This installation already manages another Antigravity config. Use its existing path: ' +
        initialState.antigravityConfig,
    );
  if (action === 'serve') {
    process.env.MEMORY_DB ??= join(paths.data, 'events.sqlite');
    await import('../../../apps/server/src/main.ts');
    return;
  }
  if (action === 'doctor') {
    const state = readInstallation(home),
      problems: string[] = [];
    if (Number(process.versions.node.split('.')[0]) < 24)
      problems.push('Install Node.js 24+');
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      problems.push('Install Git and add it to PATH');
    }
    if (!state) problems.push('No persistent runtime installed. Run setup.');
    else {
      for (const file of [
        state.current.node,
        join(state.current.appRoot, 'apps/server/src/main.js'),
      ])
        if (!existsSync(file))
          problems.push('Missing runtime path: ' + file + '. Run setup again.');
      try {
        accessSync(paths.data, constants.W_OK);
      } catch {
        problems.push('Data directory is not writable: ' + paths.data);
      }
      try {
        const globalPlan = planAntigravity(
          globalOptions(state.current, state.projects),
        );
        const before = globalPlan.expected[basename(configPath)];
        const servers = before ? (JSON.parse(before).mcpServers ?? {}) : {};
        for (const project of state.projects.filter((p) =>
          p.clients.includes('antigravity'),
        )) {
          if (!servers[antigravityServerName(project.workspace)])
            problems.push('Missing Antigravity server: ' + project.workspace);
        }
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      for (const project of state.projects) {
        try {
          const managed = readConnectionState(project.workspace);
          if (!Object.keys(managed.files).length)
            problems.push('Missing connector state: ' + project.workspace);
          for (const [path, snapshot] of Object.entries(managed.files)) {
            const current = readFileSync(join(project.workspace, path), 'utf8');
            if (current !== snapshot.after)
              problems.push(
                'Configuration changed; review before setup: ' +
                  join(project.workspace, path),
              );
          }
        } catch {
          problems.push(
            'Missing or invalid project configuration: ' + project.workspace,
          );
        }
      }
    }
    const capture = (state?.projects ?? [])
      .filter((p) => p.captureNewSessions)
      .map((project) => {
        const observations = project.clients
          .flatMap((client) =>
            readCaptureStatuses(
              join(
                dirname(project.database),
                'queue',
                client === 'claude-code' ? 'claude' : client,
              ),
            ),
          )
          .filter((s) => s.session.repoId === project.repoId);
        return {
          workspace: project.workspace,
          captureObserved: observations.some((s) => s.lastCaptureAt !== null),
          startupObserved: observations.length > 0,
          sessions: observations,
        };
      });
    console.log(
      JSON.stringify(
        {
          capture,
          status: problems.length ? 'attention_required' : 'configured',
          runtime: state?.current.version,
          problems,
          note: 'Configuration check only; agent login/trust and live handoff are not verified.',
        },
        null,
        2,
      ),
    );
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (!['setup', 'update', 'rollback', 'uninstall'].includes(action))
    throw new Error('Unknown command: ' + action);
  let project: Project | undefined;
  if (action === 'setup') {
    const directory = values.workspace ?? (await ask('Project folder: '));
    const selected =
      values.client ??
      (await ask('Agents (comma separated: ' + clients.join(', ') + '): '))
        .split(',')
        .map((v) => v.trim());
    const { workspace, repoId } = resolveRepository(resolve(directory));
    project = {
      workspace,
      repoId,
      clients: selected,
      database: join(paths.data, 'events.sqlite'),
      ...(values['capture-new-sessions'] ? { captureNewSessions: true } : {}),
    };
    // Validate and show changes before installing dependencies or writing settings.
    const previousProject = readInstallation(home)?.projects.find(
      (p) => p.workspace === workspace,
    );
    if (previousProject) project.repoId = previousProject.repoId;
    const plan = planConnection({ ...project, appRoot });
    preview(plan);
    const projects = [
      ...(initialState?.projects ?? []).filter(
        (p) => p.workspace !== project!.workspace,
      ),
      {
        ...project,
        clients: [
          ...new Set([
            ...(initialState?.projects.find(
              (p) => p.workspace === project!.workspace,
            )?.clients ?? []),
            ...project.clients,
          ]),
        ],
      },
    ];
    preview(
      planAntigravity(
        globalOptions({ version, appRoot, node: process.execPath }, projects),
      ),
      false,
    );
    if (values.preview) {
      console.log('Preview only. No runtime or configuration installed.');
      return;
    }
  } else {
    const state = readInstallation(home);
    if (!state) throw new Error('No installation found. Run setup first.');
    if (action === 'uninstall') {
      const target = values.workspace
        ? resolveRepository(resolve(values.workspace)).workspace
        : null;
      if (!target)
        throw new Error(
          'Pass --workspace to uninstall one project; memory data is always retained',
        );
      if (!state.projects.some((p) => p.workspace === target))
        throw new Error('Project is not managed by this installation');
      preview(planUninstall(target));
      preview(
        planAntigravity({
          ...globalOptions(
            state.current,
            state.projects.filter((p) => p.workspace !== target),
          ),
          removeOnly: true,
        }),
        false,
      );
    } else
      console.log(
        action +
          ' runtime for ' +
          state.projects.length +
          ' project(s); user memory is retained.',
      );
    if (values.preview) return;
  }
  if (!(await confirm('Apply ' + action + '?', values.yes))) {
    console.log('Cancelled. No changes applied.');
    return;
  }
  await withInstallLock(home, async () => {
    const state = readInstallation(home);
    if (action === 'uninstall') {
      const target = resolveRepository(resolve(values.workspace!)).workspace;
      const plan = planUninstall(target);
      const remaining = state!.projects.filter((p) => p.workspace !== target);
      await applyAll(
        [
          plan,
          planAntigravity({
            ...globalOptions(state!.current, remaining),
            removeOnly: true,
          }),
        ],
        () =>
          atomicWrite(
            paths.state,
            JSON.stringify({ ...state!, projects: remaining }, null, 2),
          ),
      );
      console.log(
        'Project connectors removed where unchanged. User-edited settings and all memory retained. Runtime retained for other projects.',
      );
      return;
    }
    if (project) {
      const existing = state?.projects.find(
        (p) => p.workspace === project!.workspace,
      );
      if (existing) {
        project.repoId = existing.repoId;
        project.clients = [
          ...new Set([...existing.clients, ...project.clients]),
        ];
        if (existing.captureNewSessions) project.captureNewSessions = true;
      }
    }
    const projects = project
      ? [
          ...(state?.projects ?? []).filter(
            (p) => p.workspace !== project.workspace,
          ),
          project,
        ]
      : state!.projects;
    if (action !== 'rollback' && metadata.private && !values.package)
      throw new Error(
        'This package is unpublished. Pass --package /absolute/path/to/the-built.tgz; registry installation is disabled until release.',
      );
    const runtime =
      action === 'rollback'
        ? state?.previous
        : installRuntime(
            home,
            values.package ??
              packageName +
                '@' +
                (action === 'update'
                  ? version.includes('-')
                    ? 'next'
                    : 'latest'
                  : version),
          );
    if (!runtime) throw new Error('No previous runtime available');
    assertRuntimeCompatibility(runtime, projects);
    const plans = plansFor(runtime, projects);
    plans.push(planAntigravity(globalOptions(runtime, projects)));
    await applyAll(
      plans,
      () =>
        activateRuntime(
          home,
          runtime,
          projects,
          projects.some((p) => p.clients.includes('antigravity'))
            ? configPath
            : state?.antigravityConfig,
        ),
      () => verifyAntigravity(globalOptions(runtime, projects)),
    );
    console.log(
      'Installed runtime ' + runtime.version + '. Data: ' + paths.data,
    );
    console.log(
      'Restart connected agents and review MCP/hook trust prompts. ' +
        (existsSync(join(runtime.appRoot, 'skills/knit/SKILL.md')) ? 'Use /continue-chat for projects with --capture-new-sessions; use /knit for other projects.' : 'Use /continue-chat with this runtime.'),
    );
    if (projects.some((p) => p.clients.includes('antigravity')))
      console.log(
        'Antigravity: project memory servers registered in ' +
          configPath +
          ' and tool connections verified. Restart Antigravity and open a fresh project chat.',
      );
    if (projects.some((p) => p.clients.includes('claude-desktop')))
      console.log(
        'Claude Desktop: merge the generated project .memory/connectors/claude-desktop.json fragment into Desktop MCP settings, then restart.',
      );
  });
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
