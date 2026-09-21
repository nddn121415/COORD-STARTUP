import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { startTestPostgres } from '../scripts/postgres.js';

let database: Awaited<ReturnType<typeof startTestPostgres>>, pool: pg.Pool;
const owner = randomUUID(),
  member = randomUUID(),
  outsider = randomUUID();
let project: string, otherProject: string;
const peers = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const tokens = ['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const base64 = (text: string) => Buffer.from(text).toString('base64');
beforeAll(async () => {
  database = await startTestPostgres();
  pool = new pg.Pool({ connectionString: database.url });
  await pool.query(
    'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);',
  );
  for (const migration of ['202609210001_coord_accounts.sql', '202609210002_coord_cloud.sql'])
    await pool.query(
      await readFile(new URL('../supabase/migrations/' + migration, import.meta.url), 'utf8'),
    );
}, 60000);
afterAll(async () => {
  await pool?.end();
  await database?.stop();
});
beforeEach(async () => {
  await pool.query('TRUNCATE auth.users CASCADE; TRUNCATE public.coord_rate_limits;');
  project = randomUUID();
  otherProject = randomUUID();
  await pool.query('INSERT INTO auth.users VALUES($1,$2),($3,$4),($5,$6)', [
    owner,
    'owner@example.test',
    member,
    'member@example.test',
    outsider,
    'outsider@example.test',
  ]);
  await pool.query(
    "INSERT INTO public.coord_projects(id,name,owner_id) VALUES($1,'First',$2),($3,'Other',$4);",
    [project, owner, otherProject, outsider],
  );
  await pool.query(
    "INSERT INTO public.coord_members VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",
    [project, owner, member, otherProject, outsider],
  );
  for (let index = 0; index < 3; index++) {
    await pool.query(
      "INSERT INTO public.coord_device_sessions VALUES($1,$2,$3,now()+interval '1 day')",
      [sha(tokens[index]), [owner, member, outsider][index], `Device ${index}`],
    );
    await pool.query('INSERT INTO public.coord_project_devices VALUES($1,$2,$3,$4,$5)', [
      index === 2 ? otherProject : project,
      peers[index],
      [owner, member, outsider][index],
      sha(tokens[index]),
      `Device ${index}`,
    ]);
  }
});
async function sync(
  operation: string,
  input: Record<string, unknown> = {},
  device = 0,
  session = 'agent-a',
  pid = project,
  token = tokens[device],
) {
  return (
    await pool.query('SELECT public.coord_sync_api($1,$2,$3,$4,$5,$6) result', [
      pid,
      peers[device],
      session,
      token,
      operation,
      input,
    ])
  ).rows[0].result;
}
async function reserve(paths: string[], device = 0, session = 'agent-a') {
  expect(await sync('reserve', { paths, summary: 'Working on project' }, device, session)).toEqual({
    ok: true,
  });
}
async function stage(
  batchId: string,
  path: string,
  content: string | null,
  baseHash: string | null = null,
  device = 0,
  session = 'agent-a',
) {
  return sync(
    'stage',
    { batchId, path, baseHash, contentBase64: content === null ? null : base64(content) },
    device,
    session,
  );
}
async function publish(path: string, content: string, device = 0, session = 'agent-a') {
  await reserve([path], device, session);
  const batchId = randomUUID();
  expect(await stage(batchId, path, content, null, device, session)).toEqual({ ok: true });
  expect(await sync('commit', { batchId }, device, session)).toEqual({
    ok: true,
    files: [{ path, hash: sha(content) }],
  });
  expect(await sync('release', {}, device, session)).toEqual({ ok: true });
}
it('keeps all source tables private and permits only the service RPC', async () => {
  const client = await pool.connect();
  try {
    for (const role of ['anon', 'authenticated']) {
      await client.query('SET ROLE ' + role);
      for (const table of [
        'coord_sync_agents',
        'coord_sync_files',
        'coord_sync_locks',
        'coord_sync_batches',
        'coord_sync_staging',
      ])
        await expect(client.query('SELECT * FROM public.' + table)).rejects.toThrow(
          'permission denied',
        );
      await expect(
        client.query('SELECT public.coord_sync_api($1,$2,$3,$4,$5)', [
          project,
          peers[0],
          'a',
          tokens[0],
          'manifest',
        ]),
      ).rejects.toThrow('permission denied');
      await expect(client.query("SELECT public.coord_sync_safe_path('a.txt')")).rejects.toThrow(
        'permission denied',
      );
      await client.query('RESET ROLE');
    }
    await client.query('SET ROLE service_role');
    const result = (
      await client.query('SELECT public.coord_sync_api($1,$2,$3,$4,$5) result', [
        project,
        peers[0],
        'a',
        tokens[0],
        'manifest',
      ])
    ).rows[0].result;
    expect(result.files).toEqual([]);
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
  expect(
    (
      await pool.query(
        "SELECT bool_and(relrowsecurity) ok FROM pg_class WHERE relname LIKE 'coord_sync_%' AND relkind='r'",
      )
    ).rows[0].ok,
  ).toBe(true);
});
it('binds the native token to its exact user, project, device and current pairing', async () => {
  expect((await sync('manifest', {}, 0, 'agent-a', project, tokens[1])).status).toBe(403);
  expect((await sync('manifest', {}, 0, 'agent-a', otherProject)).status).toBe(403);
  expect((await sync('manifest', {}, 2)).status).toBe(403);
  expect((await sync('manifest', {}, 0, 'agent-a', project, 'bad')).status).toBe(401);
  expect((await sync('manifest', {}, 0, 'agent:invalid')).status).toBe(401);
  const newToken = '1'.repeat(64);
  await reserve(['one.ts']);
  const batchId = randomUUID();
  expect((await stage(batchId, 'one.ts', 'one')).ok).toBe(true);
  await pool.query(
    "INSERT INTO public.coord_device_sessions VALUES($1,$2,'Repaired',now()+interval '1 day')",
    [sha(newToken), owner],
  );
  await pool.query("SELECT public.coord_account_api('connect',NULL,$1,$2)", [
    newToken,
    { projectId: project, peerId: peers[0] },
  ]);
  expect((await sync('commit', { batchId })).status).toBe(403);
  const manifest = await sync('manifest', {}, 0, 'agent-a', project, newToken);
  expect(manifest.context.locks).toEqual([]);
  expect(manifest.files).toEqual([]);
  expect((await sync('commit', { batchId }, 0, 'agent-a', project, newToken)).status).toBe(409);
});
it('serializes competing devices and agent sessions, and renews only owned reservations', async () => {
  const results = await Promise.all([
    sync('reserve', { paths: ['src/main.ts'] }, 0),
    sync('reserve', { paths: ['SRC/main.ts'] }, 1),
  ]);
  expect(results.filter((x) => x.ok)).toHaveLength(1);
  expect(results.filter((x) => x.status === 409)).toHaveLength(1);
  const winner = results[0].ok ? 0 : 1,
    loser = 1 - winner;
  expect((await sync('reserve', { paths: ['src/main.ts/child'] }, loser)).status).toBe(409);
  expect((await sync('reserve', { paths: ['src/main.ts'] }, winner, 'agent-b')).status).toBe(409);
  expect((await sync('release', {}, loser)).ok).toBe(true);
  expect((await sync('manifest', {}, winner)).context.locks).toHaveLength(1);
  await pool.query("UPDATE public.coord_sync_locks SET expires_at=now()+interval '1 second'");
  expect((await sync('heartbeat', { agent: 'Codex' }, winner)).ok).toBe(true);
  const manifest = await sync('manifest', {}, winner);
  expect(manifest.context.locks[0].expiresAt).toBeGreaterThan(Date.now() + 110000);
  expect(manifest.context.agents.some((a: { agent: string }) => a.agent === 'Codex')).toBe(true);
  expect(manifest.context.peers.filter((p: { online: boolean }) => p.online)).toHaveLength(2);
  await pool.query("UPDATE public.coord_sync_locks SET expires_at=now()-interval '1 second'");
  expect((await sync('reserve', { paths: ['src/main.ts'] }, loser)).ok).toBe(true);
});
it('publishes text atomically, reads by immutable hash and supports checked deletion', async () => {
  await publish('hello.ts', 'hello 🌎');
  expect(await sync('read', { path: 'hello.ts', hash: sha('hello 🌎') }, 1)).toEqual({
    path: 'hello.ts',
    hash: sha('hello 🌎'),
    contentBase64: base64('hello 🌎'),
  });
  expect((await sync('read', { path: 'hello.ts', hash: sha('obsolete') }, 1)).status).toBe(409);
  expect((await sync('read', { path: 'gone.ts' }, 1)).status).toBe(404);
  expect((await sync('manifest', {}, 1)).files).toEqual([
    { path: 'hello.ts', hash: sha('hello 🌎') },
  ]);
  await reserve(['hello.ts'], 1);
  const batchId = randomUUID();
  expect((await stage(batchId, 'hello.ts', null, sha('hello 🌎'), 1)).ok).toBe(true);
  expect(await sync('commit', { batchId }, 1)).toEqual({
    ok: true,
    files: [{ path: 'hello.ts', hash: null }],
  });
  expect((await sync('manifest')).files).toEqual([]);
  expect((await sync('commit', { batchId }, 1)).status).toBe(409);
});
it('preserves every canonical file when one file in a staged publication has a stale base', async () => {
  await publish('a.ts', 'original');
  await reserve(['a.ts', 'b.ts']);
  const batchId = randomUUID();
  expect((await stage(batchId, 'a.ts', 'new', sha('wrong'))).ok).toBe(true);
  expect((await stage(batchId, 'b.ts', 'created')).ok).toBe(true);
  expect((await sync('commit', { batchId })).status).toBe(409);
  expect((await sync('manifest')).files).toEqual([{ path: 'a.ts', hash: sha('original') }]);
  expect(
    (await pool.query('SELECT count(*) count FROM public.coord_sync_staging')).rows[0].count,
  ).toBe('2');
  expect((await stage(batchId, 'a.ts', 'new', sha('original'))).ok).toBe(true);
  expect((await sync('commit', { batchId })).files).toHaveLength(2);
});
it('rejects batch theft, unreserved publication, and revocation before commit', async () => {
  const batchId = randomUUID();
  expect((await stage(batchId, 'a.ts', 'content')).status).toBe(409);
  await reserve(['a.ts']);
  expect((await stage(batchId, 'a.ts', 'content')).ok).toBe(true);
  for (const operation of ['commit', 'abort'])
    expect((await sync(operation, { batchId }, 1)).status).toBe(403);
  expect((await stage(batchId, 'b.ts', 'content', null, 1)).status).toBe(403);
  await pool.query("SELECT public.coord_account_api('logout',NULL,$1,'{}')", [tokens[0]]);
  expect((await sync('commit', { batchId })).status).toBe(401);
  expect((await sync('manifest', {}, 1)).files).toEqual([]);
  expect(
    (await pool.query('SELECT count(*) count FROM public.coord_sync_staging')).rows[0].count,
  ).toBe('0');
});
it('rejects protected paths, malformed content, duplicate Unicode and ancestor collisions', async () => {
  for (const path of [
    '../x',
    '/x',
    'a//b',
    'a\\b',
    '.env',
    '.env.local',
    'nested/.git/config',
    '.coord/state',
    '.codex/config',
    'secrets.json',
    'id_rsa',
    'dist/main.js',
    'CON.txt',
    'trailing.',
    'a/%2e%2e/b',
  ]) {
    expect((await sync('reserve', { paths: [path] })).status, path).toBe(400);
    expect((await sync('read', { path })).status, path).toBe(400);
  }
  expect((await sync('reserve', { paths: ['a.ts', 'A.ts'] })).status).toBe(400);
  expect((await sync('reserve', { paths: ['café.ts', 'cafe\u0301.ts'] })).status).toBe(400);
  expect((await sync('reserve', { paths: ['a', 'a/b'] })).status).toBe(400);
  expect((await sync('reserve', { paths: ['É.ts', 'é.ts'] })).status).toBe(400);
  await reserve(['a.ts']);
  const batchId = randomUUID();
  for (const contentBase64 of [
    '%%',
    'YQ',
    'YR==',
    base64('\0'),
    Buffer.from([0xff]).toString('base64'),
    base64('x'.repeat(1048577)),
  ]) {
    expect(
      (await sync('stage', { batchId, path: 'a.ts', baseHash: null, contentBase64 })).status,
    ).toBe(400);
  }
  await sync('release');
  await publish('Upper.ts', 'original');
  await reserve(['upper.ts']);
  expect((await stage(batchId, 'upper.ts', 'changed', sha('original'))).ok).toBe(true);
  expect((await sync('commit', { batchId })).status).toBe(409);
  await sync('abort', { batchId });
  await sync('release');
  await publish('folder', 'file');
  await reserve(['folder/nested.ts']);
  const ancestorBatch = randomUUID();
  expect((await stage(ancestorBatch, 'folder/nested.ts', 'nested')).ok).toBe(true);
  expect((await sync('commit', { batchId: ancestorBatch })).status).toBe(409);
  expect((await sync('manifest')).files).toHaveLength(2);
});
it('enforces final multi-file quotas before modifying any canonical file', async () => {
  await pool.query(
    "INSERT INTO public.coord_sync_files SELECT $1,'file-'||i||'.ts','file-'||i||'.ts',$2,''::bytea FROM generate_series(1,499) i",
    [project, sha('')],
  );
  await reserve(['extra-a.ts', 'extra-b.ts']);
  const batchId = randomUUID();
  expect((await stage(batchId, 'extra-a.ts', 'a')).ok).toBe(true);
  expect((await stage(batchId, 'extra-b.ts', 'b')).ok).toBe(true);
  expect((await sync('commit', { batchId })).status).toBe(409);
  expect((await sync('manifest')).files).toHaveLength(499);
  await sync('abort', { batchId });
  expect(
    (await pool.query('SELECT count(*) count FROM public.coord_sync_staging')).rows[0].count,
  ).toBe('0');
  await pool.query('DELETE FROM public.coord_sync_files');
  await pool.query(
    "INSERT INTO public.coord_sync_files SELECT $1,'large-'||i||'.ts','large-'||i||'.ts',$2,convert_to(repeat('x',1048576),'UTF8') FROM generate_series(1,16) i",
    [project, sha('x'.repeat(1048576))],
  );
  const bytesBatch = randomUUID();
  expect((await stage(bytesBatch, 'extra-a.ts', 'one byte too many')).ok).toBe(true);
  expect((await sync('commit', { batchId: bytesBatch })).status).toBe(409);
  expect((await sync('manifest')).files).toHaveLength(16);
});
it('caps staging at 50 files per batch and expires abandoned publications', async () => {
  const paths = Array.from({ length: 50 }, (_, i) => `staged-${i}.ts`);
  await reserve(paths);
  const batchId = randomUUID();
  for (const path of paths) expect((await stage(batchId, path, 'small')).ok).toBe(true);
  await reserve(['extra.ts']);
  expect((await stage(batchId, 'extra.ts', 'small')).status).toBe(409);
  await pool.query("UPDATE public.coord_sync_batches SET expires_at=now()-interval '1 second'");
  expect((await sync('commit', { batchId })).status).toBe(409);
  expect((await sync('manifest')).files).toEqual([]);
  expect(
    (await pool.query('SELECT count(*) count FROM public.coord_sync_staging')).rows[0].count,
  ).toBe('0');
});
it('uses the account transaction lock so revocation serializes ahead of publication', async () => {
  await reserve(['a.ts']);
  const batchId = randomUUID();
  expect((await stage(batchId, 'a.ts', 'new')).ok).toBe(true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(208718,1)');
    await client.query("SELECT public.coord_account_api('device_revoke',$1,NULL,$2)", [
      owner,
      { projectId: project, peerId: peers[0] },
    ]);
    const publication = sync('commit', { batchId });
    await client.query('COMMIT');
    expect((await publication).status).toBe(401);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect((await sync('manifest', {}, 1)).files).toEqual([]);
});

it('expires reservations, drops revoked membership and bounds pending batch metadata', async () => {
  await reserve(['a.ts']);
  const batchId = randomUUID();
  expect((await stage(batchId, 'a.ts', 'content')).ok).toBe(true);
  await pool.query("UPDATE public.coord_sync_locks SET expires_at=now()-interval '1 second'");
  expect((await sync('heartbeat', { agent: 'Codex' })).ok).toBe(true);
  expect((await sync('commit', { batchId })).status).toBe(409);
  expect((await sync('manifest')).context.locks).toHaveLength(0);
  await reserve(['a.ts']);
  for (let i = 0; i < 3; i++) expect((await stage(randomUUID(), 'a.ts', 'content')).ok).toBe(true);
  expect((await stage(randomUUID(), 'a.ts', 'content')).status).toBe(409);
  await reserve(['b.ts'], 1);
  const memberBatch = randomUUID();
  expect((await stage(memberBatch, 'b.ts', 'member content', null, 1)).ok).toBe(true);
  await pool.query("SELECT public.coord_account_api('member_remove',$1,NULL,$2)", [
    owner,
    { projectId: project, userId: member },
  ]);
  expect((await sync('commit', { batchId: memberBatch }, 1)).status).toBe(403);
  const result = await sync('manifest');
  expect(result.files).toEqual([]);
  expect(result.context.peers).toHaveLength(1);
  expect(result.context.locks).toHaveLength(1);
});

it('drains closing database sessions before stopping its test PostgreSQL server', async () => {
  const instance = await startTestPostgres();
  const client = new pg.Client({ connectionString: instance.url });
  let stopping: Promise<void> | undefined;
  try {
    await client.connect();
    stopping = instance.stop();
    // A fast server shutdown would terminate this live connection with 57P01.
    // Smart shutdown lets its final query and socket close complete naturally.
    expect((await client.query('SELECT pg_sleep(0.05), 1 AS alive')).rows[0].alive).toBe(1);
  } finally {
    await client.end();
    await (stopping ?? instance.stop());
  }
});
