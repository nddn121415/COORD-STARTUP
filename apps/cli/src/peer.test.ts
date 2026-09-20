import { afterEach, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const loader = createRequire(import.meta.url).resolve('tsx');
const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
const prefix = ['--import', loader, entry];
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null) return;
      const stopped = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGTERM');
      await stopped;
    }),
  );
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'coord-peer-cli-'));
  dirs.push(directory);
  return realpath(directory);
}
function firstJson(child: ChildProcess): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`Share startup timed out: ${stderr}`)),
      10000,
    );
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk);
      try {
        const value = JSON.parse(stdout);
        clearTimeout(timeout);
        resolve(value);
      } catch {
        /* Wait for the complete JSON output. */
      }
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`Sender exited: ${stderr}`));
    });
  });
}

it('shares and stages files in actual CLI processes without Git or a control plane', async () => {
  const sender = await root(),
    receiver = await root();
  await writeFile(join(sender, 'hello.ts'), 'export const hello = "peer";\n');
  const child = spawn(
    process.execPath,
    [...prefix, '--repo', sender, 'share-files', '--file', 'hello.ts'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COORD_HOME: join(sender, 'private') },
    },
  );
  children.push(child);
  const shared = await firstJson(child);
  expect(shared.file_count).toBe(1);
  expect((await stat(shared.invitation_file)).mode & 0o777).toBe(0o600);
  const invitation = JSON.parse(await readFile(shared.invitation_file, 'utf8'));
  expect(JSON.stringify(shared)).not.toContain(invitation.token);
  const result = await exec(
    process.execPath,
    [...prefix, '--repo', receiver, 'receive-files', '--invite', shared.invitation_file],
    { timeout: 15000 },
  );
  const received = JSON.parse(result.stdout);
  expect(received.hashes_verified).toBe(true);
  expect(received.applied).toBe(false);
  expect(await readFile(join(received.directory, 'hello.ts'), 'utf8')).toBe(
    'export const hello = "peer";\n',
  );
  await expect(stat(join(receiver, 'hello.ts'))).rejects.toThrow();
  expect(result.stdout + result.stderr).not.toContain(invitation.token);
}, 25000);

it('refuses public and symlinked invitation files without echoing their secrets', async () => {
  const directory = await root(),
    invitation = join(directory, 'invite.json');
  await writeFile(
    invitation,
    JSON.stringify({
      token: 'NEVER_PRINT_PEER_TOKEN',
      url: 'https://NEVER_PRINT_PEER_TOKEN@example.invalid',
    }),
    { mode: 0o644 },
  );
  // Set the fixture explicitly even when the test process inherits a private umask.
  await chmod(invitation, 0o644);
  const run = (path: string) =>
    exec(process.execPath, [...prefix, 'receive-files', '--invite', path], { timeout: 5000 });
  for (const path of [invitation, join(directory, 'link.json')]) {
    if (path !== invitation) {
      await chmod(invitation, 0o600);
      await symlink(invitation, path);
    }
    try {
      await run(path);
      throw new Error('Expected rejection');
    } catch (error) {
      const failed = error as Error & { stderr: string };
      expect(failed.stderr).toContain('owner-only regular JSON file');
      expect(failed.stderr).not.toContain('NEVER_PRINT_PEER_TOKEN');
    }
  }
});

it('advertises direct transfer commands and requires explicit file selection', async () => {
  const help = await exec(process.execPath, [...prefix, 'share-files', '--help']);
  expect(help.stdout).toContain('--advertise-host');
  await expect(exec(process.execPath, [...prefix, 'share-files'])).rejects.toThrow(
    'required option',
  );
});

it('refuses a FIFO invitation promptly without blocking on read', async () => {
  const directory = await root(),
    path = join(directory, 'invite.fifo');
  await exec('mkfifo', [path]);
  await chmod(path, 0o600);
  await expect(
    exec(process.execPath, [...prefix, 'receive-files', '--invite', path], { timeout: 5000 }),
  ).rejects.toThrow('owner-only regular JSON file');
});
