import { afterEach, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import createTestnet from 'hyperdht/testnet.js';
import { createHub } from './server.js';
import { createCloudAuthority } from './cloud.js';
import { createPeerSession } from '../desktop/peer-session.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Condition not reached');
}
it('fails closed for cloud errors and rejects credential redirects', async () => {
  const cloud = createCloudAuthority({
    url: 'https://project.supabase.co',
    secretKey: 'sb_secret_test',
    fetch: async (_url, options) => {
      expect(options?.redirect).toBe('error');
      expect((options?.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response('unavailable', { status: 503 });
    },
  });
  expect(await cloud.authorized(randomUUID(), 'a'.repeat(64))).toBe(false);
  expect(() => createCloudAuthority({ url: 'http://example.com', secretKey: 'secret' })).toThrow();
});
it('authorizes cloud bindings, lazily creates one project, and revokes live peers', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-cloud-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const net = await createTestnet(3);
  cleanups.push(() => net.destroy());
  const network = { bootstrap: net.bootstrap };
  const projectId = randomUUID();
  const permitted = new Set<string>();
  const cloud = {
    url: 'https://project.supabase.co',
    secretKey: 'sb_secret_test',
    fetch: (async (url, options) => {
      const input = JSON.parse(String(options?.body));
      const allowed = input.p_project_id === projectId && permitted.has(input.p_peer_id);
      return Response.json(
        String(url).endsWith('coord_cloud_project')
          ? { id: projectId, name: 'Cloud project', allowed }
          : allowed,
      );
    }) as typeof fetch,
  };
  const adminToken = randomBytes(32).toString('hex'),
    portalToken = randomBytes(32).toString('hex');
  const hub = await createHub({
    dataDirectory: join(root, 'hub'),
    network,
    adminToken,
    portalToken,
    cloud,
  });
  cleanups.push(hub.close);
  const connect = (peerId: string, token = portalToken, origin?: string) =>
    fetch(hub.address + '/cloud/connect', {
      method: 'POST',
      headers: {
        'x-coord-portal-token': token,
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ projectId, peerId }),
    });
  expect((await fetch(hub.address + '/account/workspace')).status).toBe(404);
  expect((await connect('a'.repeat(64), adminToken)).status).toBe(401);
  expect((await connect('a'.repeat(64), portalToken, 'https://site.example')).status).toBe(403);
  expect((await connect('a'.repeat(64))).status).toBe(403);
  const peers = await Promise.all(
    [0, 1].map(async (i) => {
      const peer = await createPeerSession({
        stateDirectory: join(root, `state${i}`),
        network,
        pollMs: 100,
      });
      cleanups.push(() => peer.dispose());
      await mkdir(join(root, `folder${i}`));
      permitted.add(peer.getDeviceId());
      return peer;
    }),
  );
  const responses = await Promise.all(peers.map((p) => connect(p.getDeviceId())));
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const keys = await Promise.all(
    responses.map(async (r) => ((await r.json()) as { key: string }).key),
  );
  const listing = await fetch(hub.address + '/v1/projects', {
    headers: { Authorization: 'Bearer ' + adminToken },
  });
  expect(((await listing.json()) as { projects: unknown[] }).projects).toHaveLength(1);
  await Promise.all(peers.map((peer, i) => peer.join(keys[i]!, join(root, `folder${i}`))));
  await until(() => peers.every((p) => p.getState().status === 'connected'));
  permitted.delete(peers[0]!.getDeviceId());
  await until(() => peers[0]!.getState().status !== 'connected');
  expect((await connect(peers[0]!.getDeviceId())).status).toBe(403);
  expect(peers[1]!.getState().status).toBe('connected');
}, 30000);
