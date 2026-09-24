import { afterEach, expect, it, vi } from 'vitest';
import createTestnet from 'hyperdht/testnet.js';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPeerSession, type PeerOptions } from './peer-session.js';
import * as workspaceGuard from './workspace-guard.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function until(fn: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function fixture(authorizePeer?: PeerOptions['authorizePeer']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-session-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const net = await createTestnet(3);
  cleanup.push(() => net.destroy());
  const hostFolder = join(root, 'original');
  await mkdir(hostFolder);
  await writeFile(join(hostFolder, 'hello.ts'), 'original\n');
  const hostOptions = {
    stateDirectory: join(root, 'host-state'),
    authorizePeer,
    network: { bootstrap: net.bootstrap },
    pollMs: 100,
  };
  const host = await createPeerSession(hostOptions);
  cleanup.push(() => host.dispose());
  await host.host(hostFolder);
  async function guest(
    name: string,
    onCreated?: (peer: Awaited<ReturnType<typeof createPeerSession>>) => void,
  ) {
    const folder = join(root, name);
    await mkdir(folder);
    const options = {
      stateDirectory: join(root, name + '-state'),
      network: { bootstrap: net.bootstrap },
      pollMs: 100,
    };
    const peer = await createPeerSession(options);
    cleanup.push(() => peer.dispose());
    onCreated?.(peer);
    await peer.join(host.getState().key!, folder);
    await until(() => host.getState().pending.length > 0, 'pending approval');
    const id = host.getState().pending[0].id;
    expect(peer.getState().files).toEqual([]);
    await expect(peer.request('context', {}, 'test')).rejects.toThrow();
    await host.approve(id);
    await until(
      () => peer.getState().status === 'connected' && peer.getState().files.length === 1,
      'joined files',
    );
    return { peer, folder, id, options };
  }
  return { host, hostOptions, hostFolder, guest, root };
}
it('does not expose received files while their local writes are still pending', async () => {
  const { guest, root } = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconcile = workspaceGuard.reconcileSnapshot;
  vi.spyOn(workspaceGuard, 'reconcileSnapshot').mockImplementation(async (...args) => {
    if (args[0] === join(root, 'delayed-files')) {
      entered();
      await released;
    }
    return reconcile(...args);
  });
  let peer!: Awaited<ReturnType<typeof createPeerSession>>;
  const joining = guest('delayed-files', (created) => {
    peer = created;
  });
  try {
    await blocked;
    expect(peer.getState().files).toEqual([]);
    expect(await readFile(join(root, 'delayed-files/hello.ts')).catch(() => null)).toBeNull();
  } finally {
    release();
    await joining;
  }
  expect(peer.getState().files.map((file) => file.path)).toEqual(['hello.ts']);
  expect(await readFile(join(root, 'delayed-files/hello.ts'), 'utf8')).toBe('original\n');
}, 30000);
it('pairs by key with host approval, synchronizes ordinary folder saves, and reconnects with pinned identity', async () => {
  const { host, guest } = await fixture();
  const b = await guest('teammate');
  expect(await readFile(join(b.folder, 'hello.ts'), 'utf8')).toBe('original\n');
  await writeFile(join(b.folder, 'hello.ts'), 'teammate\n');
  await until(async () => {
    const r = (await host.request('read', { paths: ['hello.ts'] }, 'check')) as any;
    return r.files[0].content === 'teammate\n';
  }, 'automatic local save');
  await b.peer.dispose();
  const restarted = await createPeerSession(b.options);
  cleanup.push(() => restarted.dispose());
  await until(() => restarted.getState().status === 'connected', 'automatic reconnect');
  expect(host.getState().pending).toHaveLength(0);
  await host.revoke(b.id);
  await until(
    () => restarted.getState().status === 'offline' || restarted.getState().status === 'connecting',
    'revocation',
  );
  await expect(restarted.request('reserve', { paths: ['hello.ts'] }, 'revoked')).rejects.toThrow();
}, 30000);
it('enforces cross-device exclusive reservations and stale-base rejection, preserving conflicting local edits', async () => {
  const { host, guest, hostFolder } = await fixture();
  const b = await guest('b');
  const c = await guest('c');
  const original = (await host.request('read', { paths: ['hello.ts'] }, 'inspect')) as any;
  const attempts = await Promise.allSettled([
    b.peer.request('reserve', { paths: ['hello.ts'], summary: 'B task' }, 'agent-b'),
    c.peer.request('reserve', { paths: ['hello.ts'], summary: 'C task' }, 'agent-c'),
  ]);
  expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const winner = attempts[0].status === 'fulfilled' ? b : c;
  const session = winner === b ? 'agent-b' : 'agent-c';
  await host.request('heartbeat', { agent: 'codex', label: 'Different local agent' }, 'host-agent');
  await expect(host.request('reserve', { paths: ['hello.ts'] }, 'host-agent')).rejects.toThrow();
  await writeFile(join(hostFolder, 'hello.ts'), 'unpublished local work\n');
  await winner.peer.request(
    'publish',
    {
      changes: [
        { path: 'hello.ts', baseHash: original.files[0].hash, content: 'approved shared work\n' },
      ],
    },
    session,
  );
  await expect(
    winner.peer.request(
      'publish',
      {
        changes: [
          { path: 'hello.ts', baseHash: original.files[0].hash, content: 'stale overwrite\n' },
        ],
      },
      session,
    ),
  ).rejects.toThrow();
  await until(() => host.getState().conflicts.includes('hello.ts'), 'local divergence retained');
  expect(await readFile(join(hostFolder, 'hello.ts'), 'utf8')).toBe('unpublished local work\n');
  const shared = (await host.request('read', { paths: ['hello.ts'] }, 'inspect')) as any;
  expect(shared.files[0].content).toBe('approved shared work\n');
}, 30000);
it('keeps sharing identity and project after host restart without accepting an unrelated folder', async () => {
  const { host, hostOptions, guest } = await fixture();
  const b = await guest('b');
  await host.dispose();
  const restarted = await createPeerSession(hostOptions);
  cleanup.push(() => restarted.dispose());
  await until(
    () =>
      b.peer.getState().status === 'connected' && restarted.getState().peers.some((p) => p.online),
    'host restart',
  );
  expect(restarted.getState().pending).toHaveLength(0);
  await expect(b.peer.join(restarted.getState().key!, b.folder)).rejects.toThrow('empty folder');
}, 30000);

it('gives agents separate working copies and only submits reserved files', async () => {
  const { host, guest, hostFolder } = await fixture();
  const b = await guest('b');
  const a = (await host.request('workspace', { label: 'Agent A' }, 'agent-a')) as any;
  const other = (await host.request('workspace', { label: 'Agent B' }, 'agent-b')) as any;
  expect(a.directory).not.toBe(other.directory);
  await writeFile(join(a.directory, 'hello.ts'), 'agent A isolated edit\n');
  expect(await readFile(join(other.directory, 'hello.ts'), 'utf8')).toBe('original\n');
  await expect(host.request('submit', {}, 'agent-a')).rejects.toThrow();
  await host.request('reserve', { paths: ['hello.ts'] }, 'agent-a');
  await expect(
    b.peer.request('reserve', { paths: ['hello.ts'] }, 'remote-agent'),
  ).rejects.toThrow();
  await host.request('submit', {}, 'agent-a');
  await until(
    async () => (await readFile(join(b.folder, 'hello.ts'), 'utf8')) === 'agent A isolated edit\n',
    'submitted isolated edits',
  );
  await until(
    async () =>
      (await readFile(join(hostFolder, 'hello.ts'), 'utf8')) === 'agent A isolated edit\n',
    'host mirror',
  );
  expect(await readFile(join(other.directory, 'hello.ts'), 'utf8')).toBe('original\n');
}, 30000);
it('does not interpret an excluded local edit as deletion of the shared file', async () => {
  const { host, hostFolder } = await fixture();
  await writeFile(join(hostFolder, 'hello.ts'), 'API_KEY="this_is_a_private_literal"\n');
  await host.refresh();
  const shared = (await host.request('read', { paths: ['hello.ts'] }, 'check')) as any;
  expect(shared.files[0].content).toBe('original\n');
  expect(host.getState().conflicts).toContain('hello.ts');
  expect(await readFile(join(hostFolder, 'hello.ts'), 'utf8')).toContain('private_literal');
}, 30000);
it('serializes a project switch behind in-flight synchronization', async () => {
  const { host, hostFolder, root } = await fixture();
  const next = join(root, 'new-project');
  await mkdir(next);
  await writeFile(join(next, 'hello.ts'), 'unrelated project\n');
  await writeFile(join(hostFolder, 'hello.ts'), 'old local change\n');
  await Promise.all([host.refresh(), host.host(next)]);
  const shared = (await host.request('read', { paths: ['hello.ts'] }, 'check')) as any;
  expect(shared.files[0].content).toBe('unrelated project\n');
  expect(await readFile(join(next, 'hello.ts'), 'utf8')).toBe('unrelated project\n');
}, 30000);

it('rejects old-project agent work queued behind a project switch', async () => {
  const { host, root } = await fixture();
  const next = join(root, 'unrelated');
  await mkdir(next);
  await writeFile(join(next, 'hello.ts'), 'private unrelated source\n');
  const switching = host.host(next);
  const stale = host.request('workspace', {}, 'old-project-agent');
  const results = await Promise.allSettled([switching, stale]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1].status).toBe('rejected');
  if (results[1].status === 'rejected')
    expect(String(results[1].reason)).toContain('Project changed');
}, 30000);

it('uses a persistent service authority after the first contributor leaves and consumes invite keys once', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-service-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const net = await createTestnet(3);
  cleanup.push(() => net.destroy());
  const serverFolder = join(root, 'server-provisioning');
  await mkdir(serverFolder);
  const hub = await createPeerSession({
    stateDirectory: join(root, 'hub-state'),
    network: { bootstrap: net.bootstrap },
    autoApproveInvitations: true,
    watchFolder: false,
    pollMs: 100,
  });
  cleanup.push(() => hub.dispose());
  await hub.host(serverFolder);
  async function client(name: string, initial?: string) {
    const folder = join(root, name);
    await mkdir(folder);
    if (initial) await writeFile(join(folder, 'hello.ts'), initial);
    const peer = await createPeerSession({
      stateDirectory: join(root, name + '-state'),
      network: { bootstrap: net.bootstrap },
      pollMs: 100,
    });
    cleanup.push(() => peer.dispose());
    await hub.invite();
    const key = hub.getState().key!;
    await peer.join(key, folder);
    await until(() => peer.getState().status === 'connected', 'service admitted client');
    return { peer, folder, key };
  }
  const creator = await client('creator', 'first contributor\n');
  await until(() => hub.getState().files.length === 1, 'initial upload from existing project');
  const second = await client('second');
  const third = await client('third');
  await until(
    () => second.peer.getState().files.length === 1 && third.peer.getState().files.length === 1,
    'shared copies',
  );
  expect(second.peer.getState().authority).toBe('service');
  const consumed = third.key;
  await creator.peer.dispose();
  await writeFile(join(second.folder, 'hello.ts'), 'creator is offline\n');
  await until(
    async () => (await readFile(join(third.folder, 'hello.ts'), 'utf8')) === 'creator is offline\n',
    'remaining devices continue without creator',
  );
  expect(await readFile(join(serverFolder, 'hello.ts'), 'utf8').catch(() => null)).toBe(null);
  const intruderFolder = join(root, 'reuse');
  await mkdir(intruderFolder);
  const reuse = await createPeerSession({
    stateDirectory: join(root, 'reuse-state'),
    network: { bootstrap: net.bootstrap },
    pollMs: 100,
  });
  cleanup.push(() => reuse.dispose());
  await reuse.join(consumed, intruderFolder);
  await until(() => reuse.getState().status === 'offline', 'consumed invite rejected');
  expect(reuse.getState().files).toHaveLength(0);
  expect(hub.getState().pending).toHaveLength(0);
}, 30000);

it('does not revive a locally revoked peer after delayed cloud authorization resolves', async () => {
  let blocking = false;
  let entered = false;
  let release!: (value: boolean) => void;
  const delayed = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const { host, guest } = await fixture(async () => {
    if (!blocking) return true;
    entered = true;
    return delayed;
  });
  const peer = await guest('delayed-cloud');
  blocking = true;
  const request = peer.peer.request(
    'reserve',
    { paths: ['hello.ts'], summary: 'stale grant' },
    'delayed-agent',
  );
  const settled = request.then(
    () => 'accepted',
    () => 'rejected',
  );
  await until(() => entered, 'cloud request pending');
  await host.revoke(peer.id);
  release(true);
  expect(await settled).toBe('rejected');
  const context = (await host.request('context', {}, 'inspect')) as { locks: unknown[] };
  expect(context.locks).toHaveLength(0);
  expect(host.getState().peers.find((p) => p.id === peer.id)?.approved).not.toBe(true);
}, 30000);
