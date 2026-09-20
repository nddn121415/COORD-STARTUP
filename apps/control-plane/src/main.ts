import pg from 'pg';
import { createControlPlane } from './server.js';
import { databaseUrl } from './config.js';
const pool = new pg.Pool({
  connectionString: await databaseUrl(),
  connectionTimeoutMillis: 5000,
  statement_timeout: 15_000,
});
const server = await createControlPlane({
  pool,
  host: process.env.COORD_HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4100),
});
console.log(`COORD control plane listening at ${server.httpUrl}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await pool.end();
}
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
