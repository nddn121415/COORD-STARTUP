import { nativePostgres } from './native-postgres.js';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port');
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return address.port;
}
/** Real native PostgreSQL, loopback-only. Never used by deployed control plane. */
export async function startTestPostgres() {
  process.umask(0o077);
  const directory = await mkdtemp(join(tmpdir(), 'coord-pg-'));
  const port = await freePort();
  const password = randomBytes(24).toString('hex');
  let database: Awaited<ReturnType<typeof nativePostgres>>;
  try {
    database = await nativePostgres({
      directory: join(directory, 'data'),
      socketDirectory: directory,
      password,
      port,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    url: database.url,
    async stop() {
      await database.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
