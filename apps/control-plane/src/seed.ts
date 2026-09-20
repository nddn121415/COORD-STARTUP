import { mkdir, open, chmod } from 'node:fs/promises';
import pg from 'pg';
import { seedDemo } from './database.js';
import { databaseUrl } from './config.js';
const pool = new pg.Pool({ connectionString: await databaseUrl() });
try {
  // Refuse accidental credential replacement. Repeated seed runs must be intentional.
  await mkdir('.coord', { recursive: true, mode: 0o700 });
  await chmod('.coord', 0o700);
  const file = await open('.coord/demo-credentials.json', 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(await seedDemo(pool), null, 2) + '\n');
  } finally {
    await file.close();
  }
  console.log(
    'Demo provisioned. Credentials saved to .coord/demo-credentials.json (owner-only permissions).',
  );
} finally {
  await pool.end();
}
