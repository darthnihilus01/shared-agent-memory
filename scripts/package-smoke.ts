import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { npmCommand } from '../packages/installer/src/platform.ts';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { antigravityServerName } from '../packages/adapters/src/server-name.ts';
import { MemoryStore } from '../packages/memory/src/store.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const root = mkdtempSync(join(tmpdir(), "memory package ' ü "));
const originalConfigOverride = process.env.KNITT_ANTIGRAVITY_CONFIG;
const antigravityConfig = join(root, 'antigravity global/mcp_config.json');
process.env.KNITT_ANTIGRAVITY_CONFIG = antigravityConfig;
const run = (command: string, args: string[], cwd = root) => {
  const invocation = command === 'npm' ? npmCommand(args) : { command, args };
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
  });
};
const hookShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const hookArgs = (command: string) =>
  process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
const runHook = (command: string, cwd: string, payload: unknown) => {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-c', command];
  const result = spawnSync(shell, args, {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
try {
  const report = JSON.parse(
    run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
      process.cwd(),
    ),
  );
  const packed = Array.isArray(report)
    ? report[0]
    : (Object.values(report)[0] as any);
  const files = packed.files.map((f: any) => f.path) as string[];
  assert.ok(files.includes('dist/packages/installer/src/cli.js'));
  assert.ok(
    files.includes('LICENSE'),
    'Apache license missing from npm archive',
  );
  assert.ok(files.includes('dist/skills/knit/SKILL.md'));
  assert.ok(
    !files.some(
      (p) =>
        /(^|\/)(\.memory|tests|node_modules)(\/|$)/.test(p) ||
        /\.(sqlite|py|ts)$/.test(p),
    ),
  );
  for (const file of files) {
    const source = resolve(file);
    if (existsSync(source))
      assert.ok(
        !/(?:\/home\/[^/\s]+\/|\/Users\/[^/\s]+\/)/.test(
          readFileSync(source, 'utf8'),
        ),
        'Personal path in package: ' + file,
      );
  }
  const archive = join(root, packed.filename),
    bootstrap = join(root, 'temporary bootstrap');
  const npxCache = join(root, 'temporary npx cache');
  assert.equal(
    run('npm', [
      'exec',
      '--yes',
      '--cache',
      npxCache,
      '--package',
      archive,
      '--',
      'knitt',
      '--version',
    ]).trim(),
    packageVersion,
  );
  rmSync(npxCache, { recursive: true, force: true });
  run('npm', [
    'install',
    '--prefix',
    bootstrap,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    archive,
  ]);
  const cli = join(
    bootstrap,
    'node_modules/@tinchu0/knitt/dist/packages/installer/src/cli.js',
  );
  assert.equal(
    run(process.execPath, [cli, '--version']).trim(),
    packageVersion,
  );
  const workspace = join(root, 'consumer project'),
    home = join(root, 'permanent home');
  run('git', ['init', '--initial-branch=main', workspace]);
  mkdirSync(join(workspace, '.claude'));
  writeFileSync(
    join(workspace, '.mcp.json'),
    '{"mcpServers":{"existing":{"command":"keep"}}}',
  );
  const base = [
    'setup',
    '--workspace',
    workspace,
    '--client',
    'claude-code',
    '--client',
    'codex',
    '--client',
    'antigravity',
    '--client',
    'claude-desktop',
    '--home',
    home,
    '--package',
    archive,
  ];
  run(process.execPath, [cli, ...base, '--preview']);
  assert.equal(existsSync(home), false, 'Preview wrote installation files');
  assert.equal(
    existsSync(antigravityConfig),
    false,
    'Preview wrote global Antigravity settings',
  );
  mkdirSync(dirname(antigravityConfig), { recursive: true });
  writeFileSync(
    antigravityConfig,
    JSON.stringify({ mcpServers: { stitch: { command: 'preserve-stitch' } } }),
  );
  const installed = run(process.execPath, [cli, ...base, '--yes']);
  assert.ok(installed.includes('tool connections verified'));
  const globalServer = () => {
    const servers = JSON.parse(readFileSync(antigravityConfig, 'utf8')).mcpServers;
    const expected = antigravityServerName(workspace);
    const entry = servers[expected];
    if (!entry && Object.keys(servers).some(name => name.startsWith('shared-memory-'))) throw new Error('Global server identity mismatch: ' + JSON.stringify({
      workspace, realpath: realpathSync(workspace), nativeRealpath: realpathSync.native(workspace), expected,
      registered: Object.entries(servers).map(([name, value]) => ({ name, workspace: (value as any).env?.MEMORY_WORKSPACE })),
    }));
    return entry;
  };
  assert.ok(globalServer().args[0].startsWith(home));
  const agHooks = JSON.parse(
    readFileSync(join(workspace, '.agents/hooks.json'), 'utf8'),
  );
  const agStartup = runHook(
    agHooks['shared-memory'].SessionStart[0].command,
    workspace,
    {
      conversationId: 'antigravity-package-session',
      workspacePaths: [workspace],
    },
  );
  assert.ok(agStartup.includes(antigravityServerName(workspace)), agStartup);
  assert.ok(agStartup.includes('antigravity-package-session'));
  const state = () =>
    JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8'));
  const durableCli = join(
    state().current.appRoot,
    'packages/installer/src/cli.js',
  );
  rmSync(bootstrap, { recursive: true, force: true });
  const config = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8'));
  assert.ok(config.mcpServers['shared-memory'].args[0].startsWith(home));
  assert.ok(
    run(process.execPath, [durableCli, 'doctor', '--home', home]).includes(
      'configured',
    ),
  );
  const beforeDoctor = readFileSync(antigravityConfig, 'utf8');
  const missingRegistration = JSON.parse(beforeDoctor);
  delete missingRegistration.mcpServers[antigravityServerName(workspace)];
  writeFileSync(antigravityConfig, JSON.stringify(missingRegistration));
  const unhealthy = spawnSync(
    process.execPath,
    [durableCli, 'doctor', '--home', home],
    { encoding: 'utf8' },
  );
  assert.notEqual(unhealthy.status, 0);
  assert.ok(unhealthy.stdout.includes('Missing Antigravity server'));
  writeFileSync(antigravityConfig, beforeDoctor);
  const history = join(root, 'fixture-history');
  mkdirSync(history);
  const historyLogs = join(history, 'sessions');
  mkdirSync(historyLogs);
  const rollout = join(historyLogs, 'packed-chat.jsonl');
  writeFileSync(
    rollout,
    [
      {
        type: 'session_meta',
        payload: { id: 'packed-chat', cwd: workspace, source: 'cli' },
      },
      {
        type: 'response_item',
        payload: {
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Packaged cross-agent checkpoint' },
          ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const historyIndex = new DatabaseSync(join(history, 'state_5.sqlite'));
  historyIndex.exec(
    'CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,source TEXT)',
  );
  historyIndex
    .prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)')
    .run(
      'packed-chat',
      'Packed Codex chat',
      workspace,
      rollout,
      1794652800,
      'cli',
    );
  historyIndex.close();
  const agClient = new Client({ name: 'tarball-antigravity', version: '1' });
  assert.equal(globalServer().env.MEMORY_PICKER_MODE, 'native_question');
  await agClient.connect(
    new StdioClientTransport({
      ...globalServer(),
      env: {
        ...(process.env as Record<string, string>),
        ...globalServer().env,
        MEMORY_HISTORY_ROOTS: JSON.stringify({
          antigravity: [],
          codex: [history],
          claude: [],
        }),
      },
    }),
  );
  try {
    const picked = await agClient.callTool({
      name: 'choose_conversation',
      arguments: { workspace, sessionId: 'packaged-inline-session' },
    });
    assert.ok(!picked.isError, JSON.stringify(picked));
    const choices = picked.structuredContent as {
      pickerUrl?: string;
      options: { choiceId: string; title: string; client: string }[];
    };
    assert.equal(choices.pickerUrl, undefined);
    assert.equal(
      (picked.structuredContent as { nativeQuestion: { tool: string } })
        .nativeQuestion.tool,
      'ask_question',
    );
    assert.equal(choices.options[0].title, 'Packed Codex chat');
    assert.equal(choices.options[0].client, 'codex');
    const selected = await agClient.callTool({
      name: 'choose_conversation',
      arguments: {
        workspace,
        sessionId: 'packaged-inline-session',
        choiceId: choices.options[0].choiceId,
      },
    });
    assert.equal(
      (selected.structuredContent as { selected: boolean }).selected,
      true,
    );
    const recalled = await agClient.callTool({
      name: 'get_context',
      arguments: {
        repoId: globalServer().env.MEMORY_REPO,
        sessionId: 'packaged-inline-session',
      },
    });
    assert.ok(
      JSON.stringify(recalled.structuredContent).includes(
        'Packaged cross-agent checkpoint',
      ),
    );
  } finally {
    await agClient.close();
  }
  const client = new Client({ name: 'tarball-smoke', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: config.mcpServers['shared-memory'].command,
      args: config.mcpServers['shared-memory'].args,
      env: {
        ...(process.env as Record<string, string>),
        ...config.mcpServers['shared-memory'].env,
      },
      stderr: 'pipe',
    }),
  );
  try {
    assert.ok(
      (await client.listTools()).tools.some(
        (t) => t.name === 'choose_conversation',
      ),
    );
  } finally {
    await client.close();
  }
  // The packaged capture/recall hook must execute from the durable installation.
  const hooks = JSON.parse(
    readFileSync(join(workspace, '.claude/settings.local.json'), 'utf8'),
  );
  assert.ok(
    runHook(hooks.hooks.SessionStart[0].hooks[0].command, workspace, {
      session_id: 'fresh-package-session',
      cwd: workspace,
    }).includes('choose_conversation'),
  );
  const repoId = config.mcpServers['shared-memory'].env.MEMORY_REPO;
  const database = config.mcpServers['shared-memory'].env.MEMORY_DB;
  const store = new MemoryStore(database);
  try {
    store.selectSession(
      repoId,
      'fresh-package-session',
      'package-feature',
      'Package smoke',
    );
  } finally {
    store.close();
  }
  runHook(hooks.hooks.Stop[0].hooks[0].command, workspace, {
    session_id: 'fresh-package-session',
    cwd: workspace,
    last_assistant_message: 'Packaged capture ü works',
  });
  const captured = new MemoryStore(database);
  try {
    assert.ok(
      JSON.stringify(
        captured.context({ repoId, featureId: 'package-feature' }),
      ).includes('Packaged capture ü works'),
    );
  } finally {
    captured.close();
  }
  assert.ok(
    runHook(hooks.hooks.SessionStart[0].hooks[0].command, workspace, {
      session_id: 'fresh-package-session',
      cwd: workspace,
    }).includes('get_context'),
  );
  // Upgrade this disposable installation explicitly, then exercise new hooks and MCP.
  run(process.execPath, [
    durableCli,
    ...base,
    '--capture-new-sessions',
    '--yes',
  ]);
  const upgradedConfig = JSON.parse(
    readFileSync(join(workspace, '.mcp.json'), 'utf8'),
  ).mcpServers['shared-memory'];
  const upgradedHooks = JSON.parse(
    readFileSync(join(workspace, '.claude/settings.local.json'), 'utf8'),
  );
  const sessionTokens: Record<string, string> = {};
  for (const session of ['source-session', 'destination-session']) {
    const startup = spawnSync(
      hookShell,
      hookArgs(upgradedHooks.hooks.SessionStart[0].hooks[0].command),
      {
        cwd: workspace,
        input: JSON.stringify({ session_id: session, cwd: workspace }),
        encoding: 'utf8',
      },
    );
    assert.equal(startup.status, 0, startup.stderr);
    const token = JSON.parse(
      startup.stdout,
    ).hookSpecificOutput.additionalContext.match(
      /"sessionToken":"([A-Za-z0-9_-]+)"/,
    )?.[1];
    assert.ok(token, startup.stdout);
    sessionTokens[session] = token;
    const captured = spawnSync(
      hookShell,
      hookArgs(upgradedHooks.hooks.Stop[0].hooks[0].command),
      {
        cwd: workspace,
        input: JSON.stringify({
          session_id: session,
          cwd: workspace,
          last_assistant_message:
            session === 'source-session'
              ? 'Rejected batch retry. Decision: upstream ID ü. Next: concurrent retry test.'
              : 'Destination started.',
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(captured.status, 0, captured.stderr);
    assert.ok(captured.stderr.includes('"delivered":1'), captured.stderr);
  }
  const conversationClient = new Client(
    { name: 'conversation-tarball-smoke', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  conversationClient.setRequestHandler(ElicitRequestSchema, async (request) => {
    if (request.params.mode === 'url') throw new Error('Expected form');
    const schema = z
      .object({
        properties: z.object({
          conversation: z.object({
            oneOf: z.array(z.object({ const: z.string(), title: z.string() })),
          }),
        }),
      })
      .parse(request.params.requestedSchema);
    const choice = schema.properties.conversation.oneOf.find((o) =>
      o.title.includes('source-session'),
    );
    assert.ok(choice);
    return { action: 'accept', content: { conversation: choice.const } };
  });
  await conversationClient.connect(
    new StdioClientTransport({
      command: upgradedConfig.command,
      args: upgradedConfig.args,
      env: {
        ...(process.env as Record<string, string>),
        ...upgradedConfig.env,
        MEMORY_CODEX_HISTORY: join(root, 'none'),
        MEMORY_CLAUDE_HISTORY: join(root, 'none'),
        MEMORY_SOURCE_ROOTS: '[]',
      },
      stderr: 'pipe',
    }),
  );
  try {
    const initial = await conversationClient.callTool({
      name: 'get_context',
      arguments: {
        repoId: upgradedConfig.env.MEMORY_REPO,
        sessionId: 'source-session',
        sessionToken: sessionTokens['source-session'],
      },
    });
    const data = z
      .object({ events: z.array(z.object({ eventId: z.string() })) })
      .parse(initial.structuredContent);
    const saved = await conversationClient.callTool({
      name: 'save_checkpoint',
      arguments: {
        repoId: upgradedConfig.env.MEMORY_REPO,
        sessionId: 'source-session',
        sessionToken: sessionTokens['source-session'],
        entries: [
          {
            id: 'decision',
            category: 'decision',
            content: 'Use upstream IDs',
            evidenceIds: [data.events[0].eventId],
            status: 'reported',
          },
        ],
      },
    });
    assert.ok(!saved.isError, JSON.stringify(saved));
    assert.ok(
      !(
        await conversationClient.callTool({
          name: 'choose_conversation',
          arguments: {
            sessionId: 'destination-session',
            sessionToken: sessionTokens['destination-session'],
          },
        })
      ).isError,
    );
    const continued = await conversationClient.callTool({
      name: 'get_context',
      arguments: {
        repoId: upgradedConfig.env.MEMORY_REPO,
        sessionId: 'destination-session',
        sessionToken: sessionTokens['destination-session'],
      },
    });
    assert.ok(
      JSON.stringify(continued.structuredContent).includes('Use upstream IDs'),
    );
    const progress = await conversationClient.callTool({
      name: 'save_memory',
      arguments: {
        repoId: upgradedConfig.env.MEMORY_REPO,
        sessionId: 'destination-session',
        sessionToken: sessionTokens['destination-session'],
        eventId: 'destination-progress',
        kind: 'progress',
        content: 'Added destination-only regression test',
      },
    });
    assert.ok(!progress.isError, JSON.stringify(progress));
    const source = await conversationClient.callTool({
      name: 'get_context',
      arguments: {
        repoId: upgradedConfig.env.MEMORY_REPO,
        sessionId: 'source-session',
        sessionToken: sessionTokens['source-session'],
      },
    });
    assert.ok(
      !JSON.stringify(source.structuredContent).includes('destination-only'),
    );
  } finally {
    await conversationClient.close();
  }
  const health = JSON.parse(
    run(process.execPath, [durableCli, 'doctor', '--home', home]),
  );
  assert.equal(health.capture[0].captureObserved, true);
  const terminal = spawnSync(
    process.execPath,
    [
      durableCli,
      'continue',
      '--home',
      home,
      '--workspace',
      workspace,
      '--session',
      'destination-session',
      '--client',
      'claude',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(terminal.status, 0);
  assert.ok(terminal.stderr.includes('interactively'), terminal.stderr);
  const memory = join(home, 'data/preserved.txt');
  writeFileSync(memory, 'keep across lifecycle');
  const first = state().current.appRoot;
  run(process.execPath, [
    durableCli,
    'update',
    '--home',
    home,
    '--package',
    archive,
    '--yes',
  ]);
  assert.notEqual(state().current.appRoot, first);
  const updated = join(
    state().current.appRoot,
    'packages/installer/src/cli.js',
  );
  run(process.execPath, [updated, 'rollback', '--home', home, '--yes']);
  assert.equal(state().current.appRoot, first);
  const beforeFailure = readFileSync(join(home, 'installation.json'), 'utf8');
  const beforeGlobal = readFileSync(antigravityConfig, 'utf8');
  const beforeHooks = readFileSync(
    join(workspace, '.agents/hooks.json'),
    'utf8',
  );
  // A valid archive with a broken MCP process must roll back all config writes.
  const brokenRoot = join(root, 'broken-package');
  mkdirSync(brokenRoot);
  cpSync(resolve('dist'), join(brokenRoot, 'dist'), { recursive: true });
  cpSync(resolve('package.json'), join(brokenRoot, 'package.json'));
  writeFileSync(
    join(brokenRoot, 'dist/apps/server/src/main.js'),
    'process.exit(7);\n',
  );
  const brokenReport = JSON.parse(
    run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', brokenRoot],
      brokenRoot,
    ),
  );
  const brokenPacked = Array.isArray(brokenReport)
    ? brokenReport[0]
    : (Object.values(brokenReport)[0] as any);
  const rejected = spawnSync(
    process.execPath,
    [
      durableCli,
      'update',
      '--home',
      home,
      '--package',
      join(brokenRoot, brokenPacked.filename),
      '--yes',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Antigravity server connection/);
  assert.equal(
    readFileSync(join(home, 'installation.json'), 'utf8'),
    beforeFailure,
  );
  assert.equal(readFileSync(antigravityConfig, 'utf8'), beforeGlobal);
  assert.equal(
    readFileSync(join(workspace, '.agents/hooks.json'), 'utf8'),
    beforeHooks,
  );
  const failed = spawnSync(
    process.execPath,
    [
      durableCli,
      'update',
      '--home',
      home,
      '--package',
      join(root, 'missing.tgz'),
      '--yes',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(failed.status, 0);
  assert.equal(
    readFileSync(join(home, 'installation.json'), 'utf8'),
    beforeFailure,
  );
  const changed = JSON.parse(
    readFileSync(join(workspace, '.mcp.json'), 'utf8'),
  );
  changed.mcpServers.later = { command: 'keep too' };
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify(changed));
  run(process.execPath, [
    durableCli,
    'uninstall',
    '--workspace',
    workspace,
    '--home',
    home,
    '--yes',
  ]);
  const remaining = JSON.parse(
    readFileSync(join(workspace, '.mcp.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(remaining.mcpServers).sort(), [
    'existing',
    'later',
  ]);
  assert.equal(readFileSync(memory, 'utf8'), 'keep across lifecycle');
  assert.equal(globalServer(), undefined);
  assert.equal(
    JSON.parse(readFileSync(antigravityConfig, 'utf8')).mcpServers.stitch
      .command,
    'preserve-stitch',
  );
  console.log(
    'PASS: clean tarball installation, bootstrap removal, MCP, cross-agent in-chat selection, hook capture/recall, doctor, update, rollback, failure preservation and uninstall',
  );
} finally {
  if (originalConfigOverride === undefined)
    delete process.env.KNITT_ANTIGRAVITY_CONFIG;
  else process.env.KNITT_ANTIGRAVITY_CONFIG = originalConfigOverride;
  rmSync(root, { recursive: true, force: true });
}
