import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { startTestPostgres } from '../scripts/postgres.js';
import { createSupabaseHandler } from '../apps/web-server/supabase.js';
import { routeAccountRequest } from '../apps/web-server/routing.js';
import { createAccountClient } from '../apps/desktop/account-client.js';
import { createPeerSession } from '../apps/desktop/peer-session.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}
async function contents(folder: string, path: string) {
  try {
    return await readFile(join(folder, path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function close(server: Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

it('shares native folders through HTTPS and durable SQL across creator shutdown, service restart, offline edits and revocation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-cloud-flow-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = await startTestPostgres();
  cleanups.push(database.stop);
  const pool = new pg.Pool({ connectionString: database.url });
  cleanups.push(() => pool.end());
  await pool.query(
    'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text)',
  );
  for (const file of ['202609210001_coord_accounts.sql', '202609210002_coord_cloud.sql'])
    await pool.query(
      await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'),
    );
  const owner = randomUUID(),
    member = randomUUID();
  await pool.query('INSERT INTO auth.users VALUES($1,$2),($3,$4)', [
    owner,
    'owner@example.test',
    member,
    'member@example.test',
  ]);
  const site = 'https://coord.example',
    secret = 'sb_secret_test-only';
  const operations = new Set<string>();
  // Only Supabase's hosted Auth verifier and PostgREST transport are simulated.
  // Every account, membership, file and lock operation executes the real SQL.
  const upstream: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://project.supabase.co');
    if (url.pathname === '/auth/v1/user') {
      const uid = new Headers(init?.headers).get('authorization')?.replace('Bearer fixture-', '');
      return uid === owner || uid === member
        ? Response.json({ id: uid })
        : Response.json({}, { status: 401 });
    }
    expect(new Headers(init?.headers).get('apikey')).toBe(secret);
    const body = JSON.parse(String(init?.body));
    let result;
    if (url.pathname === '/rest/v1/rpc/coord_account_api') {
      result = await pool.query('SELECT public.coord_account_api($1,$2,$3,$4) result', [
        body.p_action,
        body.p_user_id,
        body.p_device_token,
        body.p_payload,
      ]);
    } else {
      expect(url.pathname).toBe('/rest/v1/rpc/coord_sync_api');
      operations.add(body.p_operation);
      result = await pool.query('SELECT public.coord_sync_api($1,$2,$3,$4,$5,$6) result', [
        body.p_project_id,
        body.p_peer_id,
        body.p_session_id,
        body.p_device_token,
        body.p_operation,
        body.p_input,
      ]);
    }
    return Response.json(result.rows[0].result);
  };
  async function startWeb() {
    const handler = routeAccountRequest(
      createSupabaseHandler({
        url: 'https://project.supabase.co',
        secretKey: secret,
        publishableKey: 'public-test',
        websiteUrl: site,
        storageMode: 'supabase',
        fetch: upstream,
      }),
    );
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  }
  let web = await startWeb();
  cleanups.push(() => close(web));
  const endpoint = (path: string) =>
    'http://127.0.0.1:' +
    (web.address() as AddressInfo).port +
    '/api/account?__coord_route=' +
    encodeURIComponent(path);
  async function browser(
    uid: string,
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) {
    return fetch(endpoint(path), {
      method,
      headers: {
        Origin: site,
        Cookie: '__Host-coord_access=fixture-' + uid,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const created = await browser(owner, 'projects', { name: 'Durable HTTPS collaboration' });
  expect(created.status).toBe(200);
  const project = await created.json();
  expect((await browser(member, 'projects/' + project.id)).status).toBe(403);
  const invitation = await (await browser(owner, `projects/${project.id}/invitations`, {})).json();
  expect((await browser(member, 'invitations/accept', { key: invitation.key })).status).toBe(200);

  async function desktop(uid: string, name: string, resume = false) {
    const connection = { online: true };
    const client = await createAccountClient({
      stateDirectory: join(root, name + '-account'),
      website: site,
      protect: { encryptString: (value) => Buffer.from(value), decryptString: (b) => b.toString() },
      fetch: (input, init) => {
        if (!connection.online) return Promise.reject(new TypeError('Fixture is offline'));
        return fetch(endpoint(new URL(String(input)).pathname.slice('/api/account/'.length)), init);
      },
    });
    cleanups.push(async () => client.dispose());
    if (resume) {
      expect(client.getState().signedIn).toBe(true);
      await client.refresh();
    } else {
      const approval = new URL(await client.signIn());
      expect(
        (await browser(uid, 'device/approve', { userCode: approval.searchParams.get('code') }))
          .status,
      ).toBe(200);
      await until(() => client.getState().projects.length === 1, 'Desktop pairing did not finish');
    }
    const peer = await createPeerSession({
      stateDirectory: join(root, name + '-peer'),
      pollMs: 150,
      cloud: {
        currentWebsite: () => (client.getState().signedIn ? client.getState().website : undefined),
        request: (website, projectId, peerId, sessionId, operation, input) =>
          client.sync(projectId, peerId, sessionId, operation, input, website),
      },
    });
    cleanups.push(() => peer.dispose());
    const folder = join(root, name);
    if (!resume) {
      await mkdir(folder);
      const selected = await client.projectConnection(project.id, peer.getDeviceId());
      expect(selected.transport).toBe('https');
      if (selected.transport !== 'https') throw new Error('Expected HTTPS sharing');
      await peer.joinCloud(selected.projectId, folder, selected.website);
    }
    await until(
      () => peer.getState().status === 'connected',
      'Desktop cloud connection did not finish: ' + JSON.stringify(peer.getState()),
    );
    expect(peer.getState().authority).toBe('service');
    return { client, peer, folder, connection };
  }
  let a = await desktop(owner, 'owner');
  const b = await desktop(member, 'member');
  await expect(a.client.projectKey(project.id, a.peer.getDeviceId())).rejects.toThrow();
  await a.peer.request('heartbeat', { agent: 'Codex', label: 'Owner agent' }, 'codex-a');
  await a.peer.request(
    'reserve',
    { paths: ['hello.ts', 'large.ts'], summary: 'Preparing the shared implementation' },
    'codex-a',
  );
  await expect(b.peer.request('reserve', { paths: ['hello.ts'] }, 'codex-b')).rejects.toThrow();
  const context = (await b.peer.request('context', {}, 'codex-b')) as {
    agents: { agent: string; summary: string }[];
    locks: { path: string; owner: string }[];
  };
  expect(
    context.agents.some((agent) => agent.summary === 'Preparing the shared implementation'),
  ).toBe(true);
  expect(context.locks).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: 'hello.ts' })]),
  );
  // Exceed the old 4 KiB account body limit and exercise real base64 PostgREST transfer.
  const large = '// Shared source line\n'.repeat(24_000);
  await a.peer.request(
    'publish',
    {
      changes: [
        { path: 'hello.ts', baseHash: null, content: 'shared' },
        { path: 'large.ts', baseHash: null, content: large },
      ],
    },
    'codex-a',
  );
  await a.peer.request('release', {}, 'codex-a');
  await until(
    async () =>
      (await contents(a.folder, 'hello.ts')) === 'shared' &&
      (await contents(b.folder, 'hello.ts')) === 'shared' &&
      (await contents(b.folder, 'large.ts')) === large,
    'Published source did not reach both native folders',
  );

  // The creator is fully shut down; another user's ordinary folder edit still publishes.
  await a.peer.dispose();
  a.client.dispose();
  await writeFile(join(b.folder, 'hello.ts'), 'creator offline');
  await until(
    async () =>
      (await pool.query('SELECT hash FROM public.coord_sync_files WHERE path=$1', ['hello.ts']))
        .rows[0]?.hash === hash('creator offline'),
    'Remaining collaborator could not publish with the creator offline',
  );

  // Restart the stateless website controller and the original native client.
  // The native device credential/binding and source are recovered from disk and SQL.
  await close(web);
  web = await startWeb();
  a = await desktop(owner, 'owner', true);
  await until(
    async () => (await contents(a.folder, 'hello.ts')) === 'creator offline',
    'Restarted desktop did not recover persisted source',
  );
  expect(await contents(a.folder, 'large.ts')).toBe(large);

  // Offline local drafts survive and publish automatically once HTTPS returns.
  b.connection.online = false;
  await until(() => b.peer.getState().status === 'offline', 'Offline state was not detected');
  await writeFile(join(b.folder, 'hello.ts'), 'reconnected draft');
  await b.peer.refresh();
  expect(await contents(b.folder, 'hello.ts')).toBe('reconnected draft');
  const previous = (await a.peer.request('read', { paths: ['hello.ts'] }, 'codex-a')) as {
    files: { content: string }[];
  };
  expect(previous.files[0]?.content).toBe('creator offline');
  b.connection.online = true;
  await until(
    async () =>
      b.peer.getState().status === 'connected' &&
      (await contents(a.folder, 'hello.ts')) === 'reconnected draft',
    'Offline draft did not recover after reconnecting',
  );

  // Membership revocation applies to existing connections and their local cached views.
  const removed = await browser(owner, `projects/${project.id}/members/${member}`, {}, 'DELETE');
  expect(removed.status).toBe(200);
  await expect(b.peer.request('read', { paths: ['hello.ts'] }, 'codex-b')).rejects.toThrow();
  await expect(b.peer.request('reserve', { paths: ['hello.ts'] }, 'codex-b')).rejects.toThrow();
  await expect(
    b.peer.request(
      'publish',
      { changes: [{ path: 'hello.ts', baseHash: hash('reconnected draft'), content: 'revoked' }] },
      'codex-b',
    ),
  ).rejects.toThrow();
  await expect(b.client.projectConnection(project.id, b.peer.getDeviceId())).rejects.toThrow(
    'Project access denied',
  );
  expect(await contents(b.folder, 'hello.ts')).toBe('reconnected draft');
  expect(
    (await pool.query('SELECT hash FROM public.coord_sync_files WHERE path=$1', ['hello.ts']))
      .rows[0]?.hash,
  ).toBe(hash('reconnected draft'));
  expect([...operations]).toEqual(
    expect.arrayContaining([
      'manifest',
      'read',
      'heartbeat',
      'reserve',
      'release',
      'stage',
      'commit',
    ]),
  );
}, 60000);
