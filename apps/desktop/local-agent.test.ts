import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callLocalAgentBridge, installLocalAgents, startLocalAgentBridge } from './local-agent.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'coord-local-test-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
it('installs both project integrations without touching trust or unrelated MCP settings', async () => {
  const folder = await root();
  await mkdir(join(folder, '.codex'));
  await writeFile(
    join(folder, '.codex/config.toml'),
    'model = "user-model"\n[mcp_servers.other]\ncommand = "other"\n',
  );
  await writeFile(
    join(folder, '.mcp.json'),
    JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
  );
  const options = {
    folder,
    bridgePath: '/private/state/bridge.json',
    command: '/usr/bin/env',
    args: [
      'ELECTRON_RUN_AS_NODE=1',
      '/Applications/COORD.app/Contents/MacOS/COORD',
      '/app/local-mcp.cjs',
    ],
  };
  expect((await installLocalAgents(options)).every((x) => x.installed)).toBe(true);
  const codex = TOML.parse(await readFile(join(folder, '.codex/config.toml'), 'utf8'));
  expect(codex.model).toBe('user-model');
  expect(codex.projects).toBeUndefined();
  expect((codex.mcp_servers as Record<string, unknown>).other).toEqual({ command: 'other' });
  const claude = JSON.parse(await readFile(join(folder, '.mcp.json'), 'utf8'));
  expect(claude.mcpServers.other.command).toBe('other');
  expect(claude.mcpServers.coord.args).toContain('--agent');
  expect((await installLocalAgents(options)).every((x) => x.installed)).toBe(true);
  claude.mcpServers.coord.command = 'user-custom';
  await writeFile(join(folder, '.mcp.json'), JSON.stringify(claude));
  expect((await installLocalAgents(options)).find((x) => x.agent === 'claude')?.installed).toBe(
    false,
  );
  expect(
    JSON.parse(await readFile(join(folder, '.mcp.json'), 'utf8')).mcpServers.coord.command,
  ).toBe('user-custom');
});
it('bridge separates session identities and rejects unapproved operations', async () => {
  const calls: unknown[] = [];
  const bridge = await startLocalAgentBridge({
    stateDirectory: await root(),
    getFolder: () => '/test-project',
    request: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
  });
  cleanups.push(() => bridge.close());
  const first = randomUUID(),
    second = randomUUID();
  await callLocalAgentBridge(bridge.configPath, {
    sessionId: first,
    folder: '/test-project',
    operation: 'reserve',
    input: { paths: ['src/a.ts'], summary: 'task one' },
  });
  await callLocalAgentBridge(bridge.configPath, {
    sessionId: second,
    folder: '/test-project',
    operation: 'context',
    input: {},
  });
  expect(calls).toEqual([
    ['reserve', { paths: ['src/a.ts'], summary: 'task one' }, first],
    ['context', {}, second],
  ]);
  await expect(
    callLocalAgentBridge(bridge.configPath, {
      sessionId: first,
      folder: '/test-project',
      operation: 'publish',
      input: { changes: [{ path: '../escape', content: 'bad', baseHash: null }] },
    }),
  ).rejects.toThrow();
  await expect(
    callLocalAgentBridge(bridge.configPath, {
      sessionId: first,
      folder: '/another-project',
      operation: 'context',
      input: {},
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
});
it('real MCP processes register independent agents and route guarded tool calls', async () => {
  const calls: { operation: string; session: string }[] = [];
  const bridge = await startLocalAgentBridge({
    stateDirectory: await root(),
    getFolder: () => '/test-project',
    request: async (operation, _input, session) => {
      calls.push({ operation, session });
      if (operation === 'reserve')
        throw new Error('File reserved by secret-owner-token: /private/secret/path');
      return { allowed: true };
    },
  });
  cleanups.push(() => bridge.close());
  const connect = async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          '--import',
          'tsx',
          'apps/desktop/local-mcp.ts',
          '--bridge',
          bridge.configPath,
          '--agent',
          'codex',
          '--folder',
          '/test-project',
        ],
        stderr: 'pipe',
      }),
    );
    cleanups.push(() => client.close());
    return client;
  };
  const first = await connect(),
    second = await connect();
  expect((await first.listTools()).tools.map((x) => x.name).sort()).toEqual([
    'coord_context',
    'coord_heartbeat',
    'coord_publish',
    'coord_read',
    'coord_release',
    'coord_reserve',
    'coord_submit',
    'coord_workspace',
  ]);
  await first.callTool({ name: 'coord_workspace', arguments: { label: 'first task' } });
  await second.callTool({ name: 'coord_workspace', arguments: { label: 'second task' } });
  await first.callTool({ name: 'coord_submit', arguments: {} });
  expect(new Set(calls.filter((x) => x.operation === 'workspace').map((x) => x.session)).size).toBe(
    2,
  );
  expect(calls.filter((x) => x.operation === 'submit')).toHaveLength(1);
  const denied = await first.callTool({
    name: 'coord_reserve',
    arguments: { paths: ['src/a.ts'], summary: 'task' },
  });
  const response = JSON.stringify(denied);
  expect(response).toContain('Another agent owns a required file');
  expect(response).toContain('coord_context');
  expect(response).not.toContain('secret-owner-token');
  expect(response).not.toContain('/private/secret/path');
  expect(response).not.toContain('Check its connection');
  await first.callTool({ name: 'coord_context', arguments: {} });
  await second.callTool({ name: 'coord_context', arguments: {} });
  expect(new Set(calls.filter((x) => x.operation === 'context').map((x) => x.session)).size).toBe(
    2,
  );
  expect(new Set(calls.filter((x) => x.operation === 'heartbeat').map((x) => x.session)).size).toBe(
    2,
  );
});
