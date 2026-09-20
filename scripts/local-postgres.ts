import { nativePostgres } from './native-postgres.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
process.umask(0o077);
const directory = resolve('.coord');
await mkdir(directory, { recursive: true, mode: 0o700 });
const configPath = resolve(directory, 'postgres.json');
let config: { password: string; port: number };
try {
  config = JSON.parse(await readFile(configPath, 'utf8')) as typeof config;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  config = {
    password: randomBytes(24).toString('hex'),
    port: Number(process.env.COORD_PG_PORT ?? 55432),
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
}
const databaseDir = resolve(directory, 'postgres');
const database = await nativePostgres({
  directory: databaseDir,
  socketDirectory: directory,
  ...config,
});
await writeFile(resolve(directory, 'database-url'), database.url + '\n', { mode: 0o600 });
console.log(
  `Local PostgreSQL ready on 127.0.0.1:${config.port}. Credentials saved privately in .coord/database-url. Keep this terminal open. Ctrl-C stops the database.`,
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await database.stop();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
