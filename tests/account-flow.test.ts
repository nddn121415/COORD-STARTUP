import { afterEach, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import createTestnet from 'hyperdht/testnet.js';
import { createHub } from '../apps/hub/server.js';
import { createAccountProxy } from '../apps/web-server/proxy.js';
import { createAccountClient } from '../apps/desktop/account-client.js';
import { createPeerSession } from '../apps/desktop/peer-session.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('connects the real desktop client through website pairing to an account-owned hub project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coord-full-account-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const net = await createTestnet(3);
  cleanup.push(() => net.destroy());
  const portalToken = randomBytes(32).toString('hex');
  const hub = await createHub({
    dataDirectory: root + '/hub',
    adminToken: randomBytes(32).toString('hex'),
    portalToken,
    network: { bootstrap: net.bootstrap },
  });
  cleanup.push(() => hub.close());
  const proxy = createAccountProxy({ hubUrl: hub.address, portalToken, allowLocal: true });
  const web = createServer((req, res) => void proxy(req, res));
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        web.closeAllConnections();
        web.close(() => r());
      }),
  );
  const website = 'http://127.0.0.1:' + (web.address() as AddressInfo).port;
  let cookie = '';
  const browser = async (path: string, body: unknown) => {
    const res = await fetch(website + '/api/account/' + path, {
      method: 'POST',
      headers: { Origin: website, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    return res.json();
  };
  const registered = await browser('register', {
    username: 'flow_owner',
    password: 'long-unique-test-password',
  });
  expect(registered).not.toHaveProperty('token');
  expect(cookie).toContain('__Host-coord_session=');
  const project = await browser('projects', { name: 'Full flow' });
  const client = await createAccountClient({
    stateDirectory: root + '/account',
    website,
    protect: { encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
  });
  cleanup.push(async () => client.dispose());
  const verification = new URL(await client.signIn());
  await browser('device/approve', { userCode: verification.searchParams.get('code') });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 10000;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    expect(check()).toBe(true);
  };
  await until(() => client.getState().projects.length === 1);
  expect(client.getState().projects[0]?.id).toBe(project.id);
  const peer = await createPeerSession({
    stateDirectory: root + '/peer',
    network: { bootstrap: net.bootstrap },
  });
  cleanup.push(() => peer.dispose());
  const key = await client.projectKey(project.id, peer.getDeviceId());
  await mkdir(root + '/folder');
  await peer.join(key, root + '/folder');
  await until(() => peer.getState().status === 'connected');
  await expect(peer.request('context', {}, 'test-agent')).resolves.toBeDefined();
  await client.signOut();
  await expect(peer.request('context', {}, 'test-agent')).rejects.toThrow();
});
