import { beforeAll, afterAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startTestPostgres } from '../scripts/postgres.js';
let database: Awaited<ReturnType<typeof startTestPostgres>>, pool: pg.Pool;
const owner = randomUUID(),
  member = randomUUID(),
  other = randomUUID();
beforeAll(async () => {
  database = await startTestPostgres();
  pool = new pg.Pool({ connectionString: database.url });
  await pool.query(
    `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);`,
  );
  await pool.query('INSERT INTO auth.users VALUES($1,$2),($3,$4),($5,$6)', [
    owner,
    'owner@example.test',
    member,
    'member@example.test',
    other,
    'other@example.test',
  ]);
  await pool.query(
    await readFile(
      new URL('../supabase/migrations/202609210001_coord_accounts.sql', import.meta.url),
      'utf8',
    ),
  );
}, 60000);
afterAll(async () => {
  await pool?.end();
  await database?.stop();
});
async function api(
  action: string,
  user: string | null = null,
  payload: Record<string, unknown> = {},
  token: string | null = null,
) {
  return (
    await pool.query('SELECT public.coord_account_api($1,$2,$3,$4) AS result', [
      action,
      user,
      token,
      payload,
    ])
  ).rows[0].result;
}
async function paired(user: string) {
  const start = await api('device_start', null, { name: 'Test desktop' });
  expect(await api('device_approve', user, { userCode: start.userCode })).toEqual({ ok: true });
  return await api('device_poll', null, { deviceCode: start.deviceCode });
}
it('denies untrusted table access and RPC execution, permits only service RPC', async () => {
  for (const role of ['anon', 'authenticated']) {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE ' + role);
      await expect(client.query('SELECT * FROM public.coord_projects')).rejects.toThrow(
        'permission denied',
      );
      await expect(client.query("SELECT public.coord_account_api('workspace')")).rejects.toThrow(
        'permission denied',
      );
      await expect(
        client.query('SELECT public.coord_peer_authorized($1,$2)', [randomUUID(), 'a'.repeat(64)]),
      ).rejects.toThrow('permission denied');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  }
  const client = await pool.connect();
  try {
    await client.query('SET ROLE service_role');
    expect(
      (await client.query("SELECT public.coord_account_api('workspace',$1)", [owner])).rows[0]
        .coord_account_api.user.id,
    ).toBe(owner);
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
  expect(
    (
      await pool.query(
        "SELECT bool_and(relrowsecurity) ok FROM pg_class WHERE relname LIKE 'coord_%' AND relkind='r'",
      )
    ).rows[0].ok,
  ).toBe(true);
});
it('redeems membership invitations exactly once across concurrent transactions', async () => {
  const project = await api('project_create', owner, { name: 'Concurrent invitations' });
  const invite = await api('invitation_create', owner, { projectId: project.id });
  const results = await Promise.all([
    api('invitation_accept', member, { key: invite.key }),
    api('invitation_accept', other, { key: invite.key }),
  ]);
  expect(results.filter((x) => x.ok)).toHaveLength(1);
  expect(results.filter((x) => x.status === 409)).toHaveLength(1);
  expect((await api('project_get', owner, { projectId: project.id })).members).toHaveLength(2);
  expect((await api('project_get', randomUUID(), { projectId: project.id })).status).toBe(401);
});
it('issues a pairing token once, enforces browser mutation scope and cascades session revocation', async () => {
  const start = await api('device_start', null, { name: 'Laptop' });
  expect(await api('device_poll', null, { deviceCode: start.deviceCode })).toEqual({
    status: 'pending',
  });
  expect(await api('device_approve', owner, { userCode: start.userCode })).toEqual({ ok: true });
  expect((await api('device_approve', other, { userCode: start.userCode })).status).toBe(409);
  const polls = await Promise.all([
    api('device_poll', null, { deviceCode: start.deviceCode }),
    api('device_poll', null, { deviceCode: start.deviceCode }),
  ]);
  const approved = polls.find((x) => x.status === 'approved');
  expect(polls.filter((x) => x.status === 'approved')).toHaveLength(1);
  const token = approved.token;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect((await api('project_create', null, { name: 'No device mutations' }, token)).status).toBe(
    403,
  );
  const p = await api('project_create', owner, { name: 'Primary' }),
    q = await api('project_create', owner, { name: 'Secondary' }),
    peer = 'a'.repeat(64);
  for (const project of [p, q])
    expect(
      (await api('connect', null, { projectId: project.id, peerId: peer }, token)).project.id,
    ).toBe(project.id);
  expect(
    (await pool.query('SELECT public.coord_peer_authorized($1,$2) ok', [p.id, peer])).rows[0].ok,
  ).toBe(true);
  expect((await api('device_revoke', owner, { projectId: p.id, peerId: peer })).ok).toBe(true);
  expect((await api('connect', null, { projectId: q.id, peerId: peer }, token)).status).toBe(401);
  expect(
    (await pool.query('SELECT public.coord_cloud_project($1,$2) result', [q.id, peer])).rows[0]
      .result,
  ).toBeNull();
});
it('removes member bindings and rejects expired sessions and invalid identities', async () => {
  const p = await api('project_create', member, { name: 'Membership revocation' }),
    invitation = await api('invitation_create', member, { projectId: p.id });
  await api('invitation_accept', other, { key: invitation.key });
  const session = await paired(other),
    peer = 'b'.repeat(64);
  await api('connect', null, { projectId: p.id, peerId: peer }, session.token);
  expect((await api('member_remove', member, { projectId: p.id, userId: other })).ok).toBe(true);
  expect(
    (await pool.query('SELECT public.coord_peer_authorized($1,$2) ok', [p.id, peer])).rows[0].ok,
  ).toBe(false);
  expect(
    (await api('connect', null, { projectId: p.id, peerId: peer }, session.token)).status,
  ).toBe(403);
  await pool.query("UPDATE public.coord_device_sessions SET expires_at=now()-interval '1 second'");
  expect((await api('workspace', null, {}, session.token)).status).toBe(401);
  expect((await api('workspace', owner, {}, 'a'.repeat(64))).status).toBe(401);
});
it('serializes project quotas and rejects exhausted pairing approval rates', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 5 }, (_, i) => api('project_create', other, { name: `Quota ${i}` })),
  );
  expect(attempts.filter((value) => value.id)).toHaveLength(5);
  expect((await api('project_create', other, { name: 'Over quota' })).status).toBe(409);
  for (let i = 0; i < 10; i++) await api('device_approve', other, { userCode: '0000000000' });
  expect((await api('device_approve', other, { userCode: '0000000000' })).status).toBe(429);
});
