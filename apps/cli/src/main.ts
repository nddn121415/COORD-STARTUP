#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, rm, appendFile, mkdir, stat, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import TOML from '@iarna/toml';
import { fileURLToPath } from 'node:url';
import {
  Connector,
  loadCredentials,
  loadLocalConfig,
  loadPersistedCursor,
  writePrivateJson,
  coordHome,
} from '@coord/connector';
import { discoverRepository } from '@coord/git-intel';
import { validateServerUrl } from '@coord/realtime-client';
import { agentKindSchema } from '@coord/protocol';
import { startMcpServer } from '@coord/mcp-server';
import { installCodexIntegration, uninstallCodexIntegration } from '@coord/adapter-codex';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  processClaudeHook,
} from '@coord/adapter-claude';
const program = new Command()
  .name('coord')
  .description('Local metadata coordination for coding agents')
  .version('0.1.0');
program
  .option('--repo <path>', 'Git checkout', process.cwd())
  .option('--agent <kind>', 'codex, claude, or other', 'other');
const output = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};
const options = () => program.opts<{ repo: string; agent: string }>();
function endpoint(url: string, path: string) {
  const value = validateServerUrl(url);
  value.protocol = ['wss:', 'https:'].includes(value.protocol) ? 'https:' : 'http:';
  value.pathname = path;
  return value;
}
async function api(path: string, credentials: { url: string; token: string }, body?: unknown) {
  const response = await fetch(endpoint(credentials.url, path), {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      `COORD rejected request (${response.status}). Check device login and project membership.`,
    );
  return response.json();
}
async function connector(persistent = false) {
  const config = await loadLocalConfig(options().repo);
  return new Connector({
    ...config,
    agent: agentKindSchema.parse(options().agent),
    ...(persistent ? {} : { sessionId: randomUUID() }),
  });
}
async function inspect(include?: string[]) {
  const client = await connector();
  try {
    await client.start();
    output(await client.call('coord_get_project_context', include ? { include } : {}));
  } finally {
    await client.stop();
  }
}
program
  .command('setup')
  .description('Show local setup steps')
  .action(() =>
    output({
      steps: [
        'coord login --url https://your-server --token-file /private/device-token',
        'coord join --project PROJECT_UUID --repo /path/to/checkout',
        'coord install-integration codex --repo /path/to/checkout',
        'coord install-integration claude --repo /path/to/checkout',
      ],
      privacy: 'Only coordination metadata is sent; source files remain local.',
    }),
  );
program
  .command('login')
  .requiredOption('--url <url>')
  .requiredOption('--token-file <path>', 'Private file containing device token')
  .action(async ({ url, tokenFile }: { url: string; tokenFile: string }) => {
    validateServerUrl(url);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token || /\s/.test(token) || token.length > 1024)
      throw new Error('Token file must contain one opaque device token');
    await api('/v1/me', { url, token });
    await writePrivateJson(join(coordHome(), 'credentials.json'), { url, token });
    output({ logged_in: true, server: url });
  });
program.command('logout').action(async () => {
  await rm(join(coordHome(), 'credentials.json'), { force: true });
  output({
    logged_out: true,
    note: 'Local credential removed. Revoke the device on the server to invalidate existing processes.',
  });
});
async function bind(projectId: string, credentials: { url: string; token: string }) {
  const info = await discoverRepository(options().repo);
  const response = await api('/v1/projects', credentials);
  const projects: { id: string; repository_id: string }[] = Array.isArray(response)
    ? response
    : response.projects;
  const project = projects.find((p) => p.id === projectId);
  if (!project)
    throw new Error('Project unavailable to this device. Ask an administrator for membership.');
  await mkdir(join(info.commonDir, 'info'), { recursive: true });
  const exclude = join(info.commonDir, 'info', 'exclude');
  let existing = '';
  try {
    existing = await readFile(exclude, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!existing.split('\n').includes('/.coord/')) await appendFile(exclude, '\n/.coord/\n');
  await writePrivateJson(join(info.root, '.coord', 'binding.json'), {
    projectId,
    repositoryId: project.repository_id,
    url: credentials.url,
  });
  output({ bound: true, project_id: projectId, repository_id: project.repository_id });
}
program
  .command('join')
  .requiredOption('--project <id>')
  .action(async ({ project }: { project: string }) => bind(project, await loadCredentials()));
program
  .command('init')
  .requiredOption('--name <name>')
  .description('Create a server project and bind this worktree')
  .action(async ({ name }: { name: string }) => {
    const credentials = await loadCredentials();
    const result = await api('/v1/projects', credentials, { name, repository_id: randomUUID() });
    await bind(result.project?.id ?? result.id, credentials);
  });
for (const [command, section] of [
  ['status', undefined],
  ['agents', 'agents'],
  ['tasks', 'tasks'],
  ['conflicts', 'conflicts'],
] as const)
  program.command(command).action(() => inspect(section ? [section] : undefined));
program
  .command('cursor')
  .description('Read the local persistent session cursor without connecting')
  .action(async () => output(await loadPersistedCursor(options().repo, options().agent)));
program
  .command('doctor')
  .option('--config <path>', 'Codex configuration path override')
  .action(async (doctorOptions: { config?: string }) => {
    const checks: Record<string, unknown> = {};
    const check = async (name: string, action: () => Promise<unknown>) => {
      try {
        checks[name] = { ok: true, detail: await action() };
      } catch (error) {
        checks[name] = {
          ok: false,
          detail: error instanceof Error ? error.message : 'Check failed',
        };
      }
    };
    await check('git', async () => {
      await discoverRepository(options().repo);
      return 'Repository discovered';
    });
    await check('database_and_http', async () => {
      const credentials = await loadCredentials();
      const response = await fetch(endpoint(credentials.url, '/health'), {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Control plane or database health check failed');
      return response.json();
    });
    await check('authentication', async () => {
      await api('/v1/me', await loadCredentials());
      return 'Device token accepted';
    });
    await check('binding', async () => {
      const config = await loadLocalConfig(options().repo);
      return { project_id: config.projectId };
    });
    await check('websocket', async () => {
      const client = await connector();
      try {
        await client.start();
        await client.call('coord_get_project_context', { include: ['agents'] });
        return 'Authenticated project session and request succeeded';
      } finally {
        await client.stop();
      }
    });
    await check('codex_config', async () => {
      const raw = await readFile(
        doctorOptions.config ??
          join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'),
        'utf8',
      );
      let config: TOML.JsonMap;
      try {
        config = TOML.parse(raw);
      } catch {
        throw new Error('Could not parse Codex configuration. Repair it before installing COORD.');
      }
      const servers = config.mcp_servers as Record<string, unknown> | undefined;
      if (!servers?.coord) throw new Error('Run coord install-integration codex');
      return 'COORD MCP entry present';
    });
    await check('claude_config', async () => {
      const { root } = await discoverRepository(options().repo);
      let config: Record<string, any>;
      try {
        config = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
      } catch {
        throw new Error(
          'Could not read Claude MCP configuration. Run coord install-integration claude or repair .mcp.json.',
        );
      }
      if (!config.mcpServers?.coord) throw new Error('Run coord install-integration claude');
      let settings: Record<string, any>;
      try {
        settings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'));
      } catch {
        throw new Error(
          'Could not read Claude hook settings. Run coord install-integration claude or repair the local settings.',
        );
      }
      return {
        mcp: true,
        hooks: ['SessionStart', 'PostToolUse', 'SessionEnd'].every(
          (name) => Array.isArray(settings.hooks?.[name]) && settings.hooks[name].length > 0,
        ),
      };
    });
    output(checks);
    if (Object.values(checks).some((check) => !(check as { ok: boolean }).ok)) process.exitCode = 1;
  });
program
  .command('pause')
  .description('Request the local daemon/MCP connector to stop and release presence')
  .action(async () => {
    const info = await discoverRepository(options().repo);
    await writePrivateJson(join(info.root, '.coord', 'pause'), { at: Date.now() });
    output({ paused: true });
  });
program
  .command('leave')
  .description('Pause local connector and remove checkout project binding')
  .action(async () => {
    const info = await discoverRepository(options().repo);
    await writePrivateJson(join(info.root, '.coord', 'pause'), { at: Date.now() });
    await rm(join(info.root, '.coord', 'binding.json'), { force: true });
    output({ left: true });
  });
async function longRunning(mcp: boolean) {
  const startedAt = Date.now();
  const client = await connector(true);
  await client.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(pausePoll);
    await client.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  const pausePath = join(client.options.repoRoot, '.coord', 'pause');
  await rm(pausePath, { force: true });
  const refreshPath = join(client.options.repoRoot, '.coord', 'refresh');
  const checkSignals = async () => {
    try {
      await stat(pausePath);
      await stop();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (client.options.agent !== 'claude') return;
    try {
      const info = await lstat(refreshPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return;
      const signal = JSON.parse(await readFile(refreshPath, 'utf8')) as {
        event?: string;
        timestamp?: number;
      };
      // One Claude connector per checkout; no transcript, tool input, or command is read.
      if (
        signal.event === 'SessionEnd' &&
        typeof signal.timestamp === 'number' &&
        signal.timestamp >= startedAt
      )
        await stop();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error;
    }
  };
  const pausePoll = setInterval(() => {
    void checkSignals().catch(() =>
      process.stderr.write('Unable to check local connector signal\n'),
    );
  }, 1000);
  client.on('diagnostic', ({ code }: { code: string }) => process.stderr.write(`COORD: ${code}\n`));
  if (mcp) {
    const server = await startMcpServer(client);
    server.server.onclose = () => void stop();
    process.stdin.once('end', () => void stop());
  } else process.stderr.write('COORD daemon connected. Press Ctrl-C to stop.\n');
}
program
  .command('daemon')
  .description('Run foreground daemon; use a service manager for background operation')
  .action(() => longRunning(false));
program
  .command('mcp')
  .description('Serve MCP over stdio using an outbound connector')
  .action(() => longRunning(true));
program
  .command('hook')
  .description('Process a local Claude hook without emitting stdout')
  .action(async () => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timeout = setTimeout(
      () => process.stdin.destroy(new Error('Hook input timed out')),
      3000,
    );
    try {
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 262144) throw new Error('Hook input too large');
        chunks.push(buffer);
      }
      await processClaudeHook(Buffer.concat(chunks).toString('utf8'), options().repo);
    } finally {
      clearTimeout(timeout);
    }
  });
program
  .command('install-integration <agent>')
  .option('--config <path>', 'Codex config path override')
  .action(async (agent: string, opt: { config?: string }) => {
    const { root } = await discoverRepository(options().repo);
    const entry = resolve(fileURLToPath(import.meta.url));
    // tsx source use is supported for local development; built CLI uses plain Node.
    const prefix = entry.endsWith('.ts')
      ? ['--import', import.meta.resolve('tsx'), entry]
      : [entry];
    const command = process.execPath,
      args = [...prefix, 'mcp', '--agent', agent, '--repo', root];
    if (agent === 'codex')
      output(await installCodexIntegration({ configPath: opt.config, command, args }));
    else if (agent === 'claude')
      output(
        await installClaudeIntegration({
          repoRoot: root,
          command,
          args,
          hookCommand: command,
          hookArgs: [...prefix, 'hook', '--repo', root],
        }),
      );
    else throw new Error('Supported integrations: codex, claude');
  });
program
  .command('uninstall-integration <agent>')
  .option('--config <path>')
  .action(async (agent: string, opt: { config?: string }) => {
    if (agent === 'codex') output(await uninstallCodexIntegration({ configPath: opt.config }));
    else if (agent === 'claude')
      output(
        await uninstallClaudeIntegration({
          repoRoot: (await discoverRepository(options().repo)).root,
        }),
      );
    else throw new Error('Supported integrations: codex, claude');
  });
await program.parseAsync().catch((error) => {
  process.stderr.write(`COORD: ${error instanceof Error ? error.message : 'Operation failed'}\n`);
  process.exitCode = 1;
});
