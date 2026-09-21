import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import createTestnet from 'hyperdht/testnet.js';
import { startTestPostgres } from '../scripts/postgres.js';
import { createSupabaseHandler } from '../apps/web-server/supabase.js';
import { routeAccountRequest } from '../apps/web-server/routing.js';
import { createAccountClient } from '../apps/desktop/account-client.js';
import { createPeerSession } from '../apps/desktop/peer-session.js';
import { createHub } from '../apps/hub/server.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Expected shared state was not reached');
}
it('runs Supabase SQL, website routing, two native clients and the hub through sharing and revocation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-supabase-flow-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const db = await startTestPostgres();
  cleanups.push(db.stop);
  const pool = new pg.Pool({ connectionString: db.url });
  cleanups.push(() => pool.end());
  await pool.query(
    'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text)',
  );
  await pool.query(
    await readFile(
      new URL('../supabase/migrations/202609210001_coord_accounts.sql', import.meta.url),
      'utf8',
    ),
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
    secret = 'sb_secret_test-only',
    portalToken = randomBytes(32).toString('hex');
  let hubAddress = '';
  // Only the hosted Auth verifier is simulated. Account and authorization RPCs execute the real SQL.
  const upstream: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://hub.example') return fetch(hubAddress + url.pathname, init);
    if (url.pathname === '/auth/v1/user') {
      const uid = new Headers(init?.headers).get('authorization')?.replace('Bearer fixture-', '');
      return uid === owner || uid === member
        ? Response.json({ id: uid })
        : Response.json({}, { status: 401 });
    }
    expect(new Headers(init?.headers).get('apikey')).toBe(secret);
    const body = JSON.parse(String(init?.body));
    let result;
    if (url.pathname.endsWith('/coord_account_api')) {
      result = await pool.query('SELECT public.coord_account_api($1,$2,$3,$4) result', [
        body.p_action,
        body.p_user_id,
        body.p_device_token,
        body.p_payload,
      ]);
    } else if (url.pathname.endsWith('/coord_cloud_project')) {
      result = await pool.query('SELECT public.coord_cloud_project($1,$2) result', [
        body.p_project_id,
        body.p_peer_id,
      ]);
    } else {
      expect(url.pathname).toBe('/rest/v1/rpc/coord_peer_authorized');
      result = await pool.query('SELECT public.coord_peer_authorized($1,$2) result', [
        body.p_project_id,
        body.p_peer_id,
      ]);
    }
    return Response.json(result.rows[0].result);
  };
  const net = await createTestnet(3);
  cleanups.push(() => net.destroy());
  const network = { bootstrap: net.bootstrap };
  const hubOptions = {
    dataDirectory: root + '/hub',
    adminToken: randomBytes(32).toString('hex'),
    portalToken,
    network,
    cloud: { url: 'https://project.supabase.co', secretKey: secret, fetch: upstream },
  };
  let hub = await createHub(hubOptions);
  cleanups.push(() => hub.close());
  hubAddress = hub.address;
  const handler = routeAccountRequest(
    createSupabaseHandler({
      url: 'https://project.supabase.co',
      secretKey: secret,
      publishableKey: 'public-test',
      websiteUrl: site,
      hubUrl: 'https://hub.example',
      portalToken,
      fetch: upstream,
    }),
  );
  const web = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        web.closeAllConnections();
        web.close(() => resolve());
      }),
  );
  const local = 'http://127.0.0.1:' + (web.address() as AddressInfo).port;
  const endpoint = (path: string) =>
    local + '/api/account?__coord_route=' + encodeURIComponent(path);
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
  const created = await browser(owner, 'projects', { name: 'Full Supabase flow' });
  expect(created.status).toBe(200);
  const project = await created.json();
  expect((await browser(member, 'projects/' + project.id)).status).toBe(403);
  const invitation = await (await browser(owner, `projects/${project.id}/invitations`, {})).json();
  expect((await browser(member, 'invitations/accept', { key: invitation.key })).status).toBe(200);
  async function desktop(uid: string, name: string) {
    const client = await createAccountClient({
      stateDirectory: root + '/' + name + '-account',
      website: site,
      protect: { encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
      fetch: (input, init) =>
        fetch(endpoint(new URL(String(input)).pathname.slice('/api/account/'.length)), init),
    });
    cleanups.push(async () => client.dispose());
    const approval = new URL(await client.signIn());
    expect(
      (await browser(uid, 'device/approve', { userCode: approval.searchParams.get('code') }))
        .status,
    ).toBe(200);
    await until(() => client.getState().projects.length === 1);
    const peer = await createPeerSession({
      stateDirectory: root + '/' + name + '-peer',
      network,
      pollMs: 100,
    });
    cleanups.push(() => peer.dispose());
    const folder = root + '/' + name;
    await mkdir(folder);
    await peer.join(await client.projectKey(project.id, peer.getDeviceId()), folder);
    await until(() => peer.getState().status === 'connected');
    return { client, peer, folder };
  }
  const a = await desktop(owner, 'owner'),
    b = await desktop(member, 'member');
  await a.peer.request('reserve', { paths: ['hello.ts'] }, 'codex-a');
  await expect(b.peer.request('reserve', { paths: ['hello.ts'] }, 'codex-b')).rejects.toThrow();
  await a.peer.request(
    'publish',
    { changes: [{ path: 'hello.ts', baseHash: null, content: 'shared' }] },
    'codex-a',
  );
  await a.peer.request('release', {}, 'codex-a');
  await until(async () => {
    try {
      return (await readFile(join(b.folder, 'hello.ts'), 'utf8')) === 'shared';
    } catch {
      return false;
    }
  });
  await a.peer.dispose();
  await b.peer.request('reserve', { paths: ['hello.ts'] }, 'codex-b');
  await b.peer.request(
    'publish',
    {
      changes: [
        {
          path: 'hello.ts',
          baseHash: createHash('sha256').update('shared').digest('hex'),
          content: 'creator offline',
        },
      ],
    },
    'codex-b',
  );
  await b.peer.request('release', {}, 'codex-b');
  await hub.close();
  hub = await createHub(hubOptions);
  hubAddress = hub.address;
  await until(() => b.peer.getState().status === 'connected');
  const shared = (await b.peer.request('read', { paths: ['hello.ts'] }, 'codex-b')) as {
    files: { content: string }[];
  };
  expect(shared.files[0]?.content).toBe('creator offline');
  const removed = await browser(owner, `projects/${project.id}/members/${member}`, {}, 'DELETE');
  expect(removed.status).toBe(200);
  await expect(b.peer.request('reserve', { paths: ['hello.ts'] }, 'codex-b')).rejects.toThrow();
  await expect(b.client.projectKey(project.id, b.peer.getDeviceId())).rejects.toThrow(
    'Project access denied',
  );
}, 60000);
