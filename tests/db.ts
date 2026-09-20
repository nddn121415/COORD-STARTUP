import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { inject } from 'vitest';
import { migrate } from '../apps/control-plane/src/database.js';
/** Every test gets a fresh real PostgreSQL schema and runs migrations from zero. */
export async function withTestDatabase<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const url = inject('databaseUrl');
  if (!url)
    throw new Error(
      'Database tests need PostgreSQL global setup; run pnpm test:integration or pnpm test:e2e',
    );
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema},public`,
    max: 15,
  });
  try {
    await migrate(pool);
    return await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
