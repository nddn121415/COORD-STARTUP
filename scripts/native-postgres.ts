import { createRequire } from 'node:module';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const exec = promisify(execFile);
export interface NativePostgresOptions {
  directory: string;
  socketDirectory: string;
  port: number;
  password: string;
}
/** Use packaged binaries, not embedded-postgres's wrapper: its exit hook masks failing test exit codes. */
async function binaries(): Promise<{ initdb: string; postgres: string }> {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  if (!['linux', 'darwin'].includes(platform))
    throw new Error(
      'Native dev PostgreSQL currently supports macOS/Linux; use Docker or COORD_TEST_DATABASE_URL on other systems.',
    );
  const require = createRequire(import.meta.url);
  const bundled = createRequire(require.resolve('embedded-postgres'));
  const file = bundled.resolve(`@embedded-postgres/${platform}-${process.arch}`);
  return import(pathToFileURL(file).href);
}
export async function nativePostgres(options: NativePostgresOptions) {
  const bin = await binaries();
  if (process.getuid?.() === 0)
    throw new Error(
      'Run tests as a non-root user, or supply COORD_TEST_DATABASE_URL to a real PostgreSQL server.',
    );
  await mkdir(options.socketDirectory, { recursive: true, mode: 0o700 });
  await chmod(bin.initdb, 0o755);
  await chmod(bin.postgres, 0o755);
  try {
    await access(join(options.directory, 'PG_VERSION'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const passwordFile = join(options.socketDirectory, `password-${randomUUID()}`);
    try {
      await writeFile(passwordFile, options.password + '\n', { mode: 0o600, flag: 'wx' });
      await exec(
        bin.initdb,
        [
          '-D',
          options.directory,
          '-U',
          'coord',
          '--auth=scram-sha-256',
          '--encoding=UTF8',
          '--locale=C',
          `--pwfile=${passwordFile}`,
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
    } finally {
      await unlink(passwordFile);
    }
  }
  let logs = '';
  let failure: Error | undefined;
  const child: ChildProcess = spawn(
    bin.postgres,
    [
      '-D',
      options.directory,
      '-h',
      '127.0.0.1',
      '-p',
      String(options.port),
      '-k',
      options.socketDirectory,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr!.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-8000);
  });
  child.on('error', (error) => {
    failure = error;
  });
  const url = `postgresql://coord:${options.password}@127.0.0.1:${options.port}/postgres`;
  const emergency = () => {
    child.kill('SIGINT');
  };
  process.once('exit', emergency);
  async function stop() {
    process.off('exit', emergency);
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('PostgreSQL did not shut down within 10 seconds'));
      }, 10000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill('SIGINT');
    });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) {
      await stop();
      throw new Error(`PostgreSQL failed to start: ${failure?.message ?? logs}`);
    }
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 250 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return { url, stop };
    } catch {
      await client.end();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await stop();
  throw new Error(`PostgreSQL startup timed out: ${logs}`);
}
