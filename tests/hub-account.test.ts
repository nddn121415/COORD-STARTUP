import { afterEach, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import createTestnet from 'hyperdht/testnet.js';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../apps/hub/server.js';
import { createPeerSession } from '../apps/desktop/peer-session.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-account-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const network = await createTestnet(3);
  cleanup.push(() => network.destroy());
  const options = {
    dataDirectory: join(root, 'hub'),
    adminToken: randomBytes(32).toString('hex'),
    portalToken: randomBytes(32).toString('hex'),
    network: { bootstrap: network.bootstrap },
  };
  let hub = await createHub(options);
  cleanup.push(() => hub.close());
  const api = async (
    path: string,
    token?: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await fetch(hub.address + '/account' + path, {
      method,
      headers: {
        'x-coord-portal-token': options.portalToken,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  return {
    root,
    options,
    api,
    get hub() {
      return hub;
    },
    restart: async () => {
      await hub.close();
      hub = await createHub(options);
    },
  };
}
it('requires gateway credentials, separates account sessions from admin and survives restart', async () => {
  const f = await fixture();
  expect((await fetch(f.hub.address + '/account/workspace')).status).toBe(401);
  const account = await f.api('/register', undefined, {
    username: 'owner_1',
    password: 'a-long-secret-password',
  });
  expect(account.status).toBe(200);
  const token = account.data.token;
  expect((await f.api('/workspace', f.options.adminToken)).status).toBe(401);
  expect(
    (await f.api('/login', undefined, { username: 'owner_1', password: 'wrong-password-here' }))
      .status,
  ).toBe(401);
  const project = await f.api('/projects', token, { name: 'Team' });
  expect(project.status).toBe(200);
  const other = await f.api('/register', undefined, {
    username: 'other_1',
    password: 'another-long-password',
  });
  expect((await f.api('/projects/' + project.data.id, other.data.token)).status).toBe(403);
  await f.restart();
  expect((await f.api('/workspace', token)).data.projects).toEqual([
    { id: project.data.id, name: 'Team', role: 'owner' },
  ]);
  expect((await f.api('/logout', token, {})).status).toBe(200);
  expect((await f.api('/workspace', token)).status).toBe(401);
});
it('pairs desktop once, restricts mutations, consumes member invites and revokes transport access', async () => {
  const f = await fixture();
  const owner = (
    await f.api('/register', undefined, { username: 'owner_2', password: 'a-long-secret-password' })
  ).data;
  const guest = (
    await f.api('/register', undefined, { username: 'guest_2', password: 'a-long-secret-password' })
  ).data;
  const project = (await f.api('/projects', owner.token, { name: 'Together' })).data;
  const invitation = (await f.api('/projects/' + project.id + '/invitations', owner.token, {}))
    .data;
  expect((await f.api('/invitations/accept', guest.token, { key: invitation.key })).status).toBe(
    200,
  );
  expect((await f.api('/invitations/accept', guest.token, { key: invitation.key })).status).toBe(
    409,
  );
  const pair = (await f.api('/device/start', undefined, { name: 'Guest Mac' })).data;
  expect(
    (await f.api('/device/poll', undefined, { deviceCode: pair.deviceCode })).data.status,
  ).toBe('pending');
  expect((await f.api('/device/approve', guest.token, { userCode: pair.userCode })).status).toBe(
    200,
  );
  const device = (await f.api('/device/poll', undefined, { deviceCode: pair.deviceCode })).data;
  expect(device.status).toBe('approved');
  expect((await f.api('/device/poll', undefined, { deviceCode: pair.deviceCode })).status).toBe(
    409,
  );
  expect((await f.api('/projects', device.token, { name: 'Disallowed' })).status).toBe(403);
  expect((await f.api('/projects/' + project.id + '/invitations', device.token, {})).status).toBe(
    403,
  );
  const peer = await createPeerSession({
    stateDirectory: join(f.root, 'guest-state'),
    network: f.options.network,
  });
  cleanup.push(() => peer.dispose());
  const key = (
    await f.api('/projects/' + project.id + '/connect', device.token, {
      peerId: peer.getDeviceId(),
    })
  ).data.key;
  await mkdir(join(f.root, 'guest-folder'));
  await peer.join(key, join(f.root, 'guest-folder'));
  const deadline = Date.now() + 10000;
  while (peer.getState().status !== 'connected' && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 30));
  expect(peer.getState().status).toBe('connected');
  expect(
    (
      await f.api(
        '/projects/' + project.id + '/members/' + guest.user.id,
        owner.token,
        undefined,
        'DELETE',
      )
    ).status,
  ).toBe(200);
  expect((await f.api('/projects/' + project.id, device.token)).status).toBe(403);
  expect(
    (
      await f.api('/projects/' + project.id + '/connect', device.token, {
        peerId: peer.getDeviceId(),
      })
    ).status,
  ).toBe(403);
  expect((await f.api('/projects/' + project.id, owner.token)).data.devices).toEqual([]);
});
it('expired device sessions cannot keep using an already connected source channel', async () => {
  const f = await fixture();
  const owner = (
    await f.api('/register', undefined, { username: 'owner_3', password: 'a-long-secret-password' })
  ).data;
  const project = (await f.api('/projects', owner.token, { name: 'Expiry' })).data;
  const pair = (await f.api('/device/start', undefined, { name: 'Mac' })).data;
  await f.api('/device/approve', owner.token, { userCode: pair.userCode });
  const device = (await f.api('/device/poll', undefined, { deviceCode: pair.deviceCode })).data;
  const peer = await createPeerSession({
    stateDirectory: join(f.root, 'expiry-state'),
    network: f.options.network,
  });
  cleanup.push(() => peer.dispose());
  const key = (
    await f.api('/projects/' + project.id + '/connect', device.token, {
      peerId: peer.getDeviceId(),
    })
  ).data.key;
  await mkdir(join(f.root, 'expiry-folder'));
  await peer.join(key, join(f.root, 'expiry-folder'));
  const deadline = Date.now() + 10000;
  while (peer.getState().status !== 'connected' && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  expect(peer.getState().status).toBe('connected');
  const db = new DatabaseSync(join(f.options.dataDirectory, 'registry.sqlite'));
  db.prepare("UPDATE account_sessions SET expires=0 WHERE kind='device'").run();
  db.close();
  expect((await f.api('/workspace', device.token)).status).toBe(401);
  await expect(peer.request('context', {}, randomUUID())).rejects.toThrow();
});
it('lets owners and device owners revoke desktop sessions while denying other members and outsiders', async () => {
  const f = await fixture();
  const register = async (username: string) =>
    (await f.api('/register', undefined, { username, password: 'a-long-secret-password' })).data;
  const owner = await register('device_owner'),
    guest = await register('device_guest'),
    other = await register('device_other'),
    outsider = await register('device_outsider');
  const project = (await f.api('/projects', owner.token, { name: 'Device controls' })).data;
  for (const person of [guest, other]) {
    const invitation = (await f.api('/projects/' + project.id + '/invitations', owner.token, {}))
      .data;
    await f.api('/invitations/accept', person.token, { key: invitation.key });
  }
  const pairDevice = async () => {
    const pair = (await f.api('/device/start', undefined, { name: 'Guest desktop' })).data;
    await f.api('/device/approve', guest.token, { userCode: pair.userCode });
    return (await f.api('/device/poll', undefined, { deviceCode: pair.deviceCode })).data;
  };
  const device = await pairDevice(),
    peerId = 'c'.repeat(64);
  expect(
    (await f.api('/projects/' + project.id + '/connect', device.token, { peerId })).status,
  ).toBe(200);
  const path = '/projects/' + project.id + '/devices/' + peerId;
  expect((await f.api(path, outsider.token, undefined, 'DELETE')).status).toBe(403);
  expect((await f.api(path, other.token, undefined, 'DELETE')).status).toBe(403);
  expect((await f.api(path, device.token, undefined, 'DELETE')).status).toBe(403);
  expect((await f.api(path, guest.token, undefined, 'DELETE')).status).toBe(200);
  expect((await f.api('/workspace', device.token)).status).toBe(401);
  const replacement = await pairDevice();
  await f.api('/projects/' + project.id + '/connect', replacement.token, { peerId });
  expect((await f.api(path, owner.token, undefined, 'DELETE')).status).toBe(200);
  expect((await f.api('/workspace', replacement.token)).status).toBe(401);
  expect((await f.api('/projects/' + project.id, owner.token)).data.devices).toEqual([]);
});
