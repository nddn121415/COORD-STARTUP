import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { sessionStatePath, writePrivateJson } from '@coord/connector';
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it('installs reversible Codex config whose generated command starts from another checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coord cli external '));
  dirs.push(root);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  const configPath = join(root, 'config.toml');
  await writeFile(configPath, 'model = "existing-model"\n');
  const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
  const loader = createRequire(import.meta.url).resolve('tsx');
  const env = { ...process.env, COORD_HOME: join(root, 'private') };
  await exec(
    process.execPath,
    [
      '--import',
      loader,
      entry,
      'install-integration',
      'codex',
      '--repo',
      root,
      '--config',
      configPath,
    ],
    { cwd: root, env },
  );
  const config = TOML.parse(await readFile(configPath, 'utf8')) as unknown as {
    model: string;
    mcp_servers: { coord: { command: string; args: string[] } };
  };
  expect(config.model).toBe('existing-model');
  const generated = config.mcp_servers.coord;
  const launched = await exec(generated.command, [...generated.args, '--help'], { cwd: root, env });
  expect(launched.stdout).toContain('Serve MCP over stdio');
  await exec(
    process.execPath,
    [
      '--import',
      loader,
      entry,
      'uninstall-integration',
      'codex',
      '--repo',
      root,
      '--config',
      configPath,
    ],
    { cwd: root, env },
  );
  const restored = TOML.parse(await readFile(configPath, 'utf8'));
  expect(restored.model).toBe('existing-model');
  expect((restored.mcp_servers as TOML.JsonMap | undefined)?.coord).toBeUndefined();
});

it('cursor reads the persistent selected-agent cursor locally without opening a session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coord-cursor-'));
  dirs.push(directory);
  const root = await realpath(directory);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  const home = join(root, 'private'),
    projectId = randomUUID(),
    sessionId = randomUUID(),
    url = 'http://127.0.0.1:9';
  await writePrivateJson(join(home, 'credentials.json'), { url, token: 'NEVER_PRINT_THIS_TOKEN' });
  await writePrivateJson(join(root, '.coord', 'binding.json'), {
    url,
    projectId,
    repositoryId: 'repo',
  });
  const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
  const loader = createRequire(import.meta.url).resolve('tsx');
  const args = ['--import', loader, entry, 'cursor', '--repo', root, '--agent', 'claude'];
  const env = { ...process.env, COORD_HOME: home };
  await expect(exec(process.execPath, args, { cwd: root, env, timeout: 5000 })).rejects.toThrow(
    'Start its MCP connection',
  );
  const path = sessionStatePath({
    url,
    projectId,
    repoRoot: root,
    agent: 'claude',
    stateDir: join(home, 'sessions'),
  });
  await writePrivateJson(path, { sessionId, afterSeq: 73 });
  const before = await readdir(join(home, 'sessions'));
  const result = await exec(process.execPath, args, { cwd: root, env, timeout: 5000 });
  expect(JSON.parse(result.stdout)).toEqual({ session_id: sessionId, after_seq: 73 });
  expect(result.stdout + result.stderr).not.toContain('NEVER_PRINT_THIS_TOKEN');
  expect(await readdir(join(home, 'sessions'))).toEqual(before);
});
