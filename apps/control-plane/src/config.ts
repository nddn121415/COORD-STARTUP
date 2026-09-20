import { readFile } from 'node:fs/promises';
export async function databaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return (await readFile('.coord/database-url', 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'postgresql://coord:coord@127.0.0.1:5432/coord';
  }
}
