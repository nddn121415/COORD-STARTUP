import { afterEach, expect, it, vi } from 'vitest';
import createTestnet from 'hyperdht/testnet.js';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPeerSession, type PeerOptions } from './peer-session.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(fn: () => boolean) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timed out');
}
async function fixture(extra: Partial<PeerOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-invites-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const net = await createTestnet(3);
  cleanup.push(() => net.destroy());
  async function peer(name: string, options: Partial<PeerOptions> = {}) {
    const folder = join(root, name);
    await mkdir(folder);
    const session = await createPeerSession({
      stateDirectory: join(root, name + '-state'),
      network: { bootstrap: net.bootstrap },
      pollMs: 100,
      ...options,
    });
    cleanup.push(() => session.dispose());
    return { session, folder };
  }
  const host = await peer('host', { autoApproveInvitations: true, ...extra });
  await host.session.host(host.folder);
  return { host: host.session, peer };
}
it('keeps simultaneous device invitations independent and invalidates only the revoked device', async () => {
  const { host, peer } = await fixture();
  const b = await peer('b'),
    c = await peer('c'),
    d = await peer('d');
  await host.invite(b.session.getDeviceId());
  const kb = host.getState().key!;
  await host.invite(c.session.getDeviceId());
  const kc = host.getState().key!;
  await host.invite(d.session.getDeviceId());
  const kd = host.getState().key!;
  await host.revoke(d.session.getDeviceId());
  await Promise.all([
    b.session.join(kb, b.folder),
    c.session.join(kc, c.folder),
    d.session.join(kd, d.folder),
  ]);
  await until(
    () =>
      b.session.getState().status === 'connected' && c.session.getState().status === 'connected',
  );
  expect(
    host
      .getState()
      .peers.map((p) => p.id)
      .sort(),
  ).toEqual([b.session.getDeviceId(), c.session.getDeviceId()].sort());
  expect(d.session.getState().status).not.toBe('connected');
});
it('bounds outstanding device invitations and prunes expired entries', async () => {
  const { host } = await fixture();
  for (let i = 0; i < 100; i++) await host.invite(i.toString(16).padStart(64, '0'));
  await host.invite('0'.repeat(64));
  await expect(host.invite('f'.repeat(64))).rejects.toThrow('Too many');
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 600001);
  await expect(host.invite('f'.repeat(64))).resolves.toBeUndefined();
});
it.each([true, false])(
  'does not complete approval when revoked during persistence (automatic=%s)',
  async (automatic) => {
    let target = '',
      revoked: Promise<void> | undefined;
    const f = await fixture({
      autoApproveInvitations: automatic,
      protect: {
        encryptString(value) {
          if (target && JSON.parse(value).approved[target]) {
            target = '';
            revoked = host.revoke(id);
          }
          return Buffer.from(value);
        },
        decryptString: (value) => value.toString(),
      },
    });
    const host = f.host;
    const b = await f.peer('b');
    const id = b.session.getDeviceId();
    await host.invite(id);
    target = id;
    await b.session.join(host.getState().key!, b.folder);
    if (!automatic) {
      await until(() => host.getState().pending.length === 1);
      await host.approve(id);
    }
    await until(() => !!revoked);
    await revoked;
    await new Promise((r) => setTimeout(r, 200));
    expect(host.getState().peers).toEqual([]);
    expect(b.session.getState().status).not.toBe('connected');
    await expect(b.session.request('context', {}, 'denied')).rejects.toThrow();
  },
);
it('rechecks account authorization for existing peer requests', async () => {
  let allowed = true;
  const { host, peer } = await fixture({ authorizePeer: () => allowed });
  const b = await peer('b');
  await host.invite(b.session.getDeviceId());
  await b.session.join(host.getState().key!, b.folder);
  await until(() => b.session.getState().status === 'connected');
  allowed = false;
  await expect(b.session.request('context', {}, 'expired')).rejects.toThrow();
});
