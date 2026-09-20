import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function transaction<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='15s'");
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(
    new URL('../../../migrations/001_initial.sql', import.meta.url),
    'utf8',
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFile('migrations/001_initial.sql', 'utf8');
  });
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(72460201)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    if (!(await db.query('SELECT 1 FROM schema_migrations WHERE version=1')).rowCount) {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(version) VALUES(1)');
    }
  });
}
export async function seedDemo(pool: Pool) {
  return transaction(pool, async (db) => {
    const org = randomUUID(),
      outsiderOrg = randomUUID(),
      projectId = randomUUID(),
      outsiderProject = randomUUID();
    const repositoryId = 'coord-demo-repository-v1';
    await db.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)', [
      org,
      'COORD demo',
      outsiderOrg,
      'Unrelated organization',
    ]);
    await db.query(
      'INSERT INTO projects(id,organization_id,name,repository_id) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',
      [
        projectId,
        org,
        'Shared demo',
        repositoryId,
        outsiderProject,
        outsiderOrg,
        'Private project',
        'private-demo-repository',
      ],
    );
    async function user(name: string, organizationId: string, project: string) {
      const userId = randomUUID(),
        deviceId = randomUUID(),
        token = randomBytes(32).toString('base64url');
      await db.query('INSERT INTO users(id,organization_id,name) VALUES($1,$2,$3)', [
        userId,
        organizationId,
        name,
      ]);
      await db.query('INSERT INTO project_memberships(project_id,user_id) VALUES($1,$2)', [
        project,
        userId,
      ]);
      await db.query(
        "INSERT INTO devices(id,user_id,name,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')",
        [deviceId, userId, `${name} laptop`, tokenHash(token)],
      );
      return { token, userId, deviceId };
    }
    return {
      projectId,
      repositoryId,
      waled: await user('Waled', org, projectId),
      sarah: await user('Sarah', org, projectId),
      outsider: {
        ...(await user('Outsider', outsiderOrg, outsiderProject)),
        projectId: outsiderProject,
      },
    };
  });
}
