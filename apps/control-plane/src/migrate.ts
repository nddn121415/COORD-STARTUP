import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { migrate } from './database.js';
import { databaseUrl } from './config.js';
export { migrate } from './database.js';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new pg.Pool({ connectionString: await databaseUrl() });
  try {
    await migrate(pool);
    console.log('COORD database migrations applied.');
  } finally {
    await pool.end();
  }
}
