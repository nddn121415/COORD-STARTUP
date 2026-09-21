import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from './server.js';
import { createPeerSession } from '../desktop/peer-session.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(fn: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + label);
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-hub-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const network = await createTestnet(3);
  cleanup.push(() => network.destroy());
  const adminToken = randomBytes(32).toString('hex');
  const options = {
    dataDirectory: join(root, 'hub'),
    adminToken,
    network: { bootstrap: network.bootstrap },
  };
  const hub = await createHub(options);
  cleanup.push(hub.close);
  return { root, hub, options, adminToken };
}
async function api(address: string, token: string, path: string, method = 'GET', body?: unknown) {
  return fetch(address + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
describe('always-on private hub', () => {
  it('rejects weak tokens, unauthenticated administration, browser origins, and malformed creation', async () => {
    const { root, hub, adminToken } = await fixture();
    await expect(
      createHub({ dataDirectory: join(root, 'bad'), adminToken: 'short' }),
    ).rejects.toThrow('32 bytes');
    expect((await fetch(hub.address + '/healthz')).status).toBe(200);
    expect(await (await fetch(hub.address + '/healthz')).json()).toEqual({ ok: true });
    expect((await fetch(hub.address + '/v1/projects')).status).toBe(401);
    expect((await api(hub.address, randomBytes(32).toString('hex'), '/v1/projects')).status).toBe(
      401,
    );
    expect(
      (
        await fetch(hub.address + '/v1/projects', {
          headers: { Authorization: 'Bearer ' + adminToken, Origin: 'https://attacker.invalid' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(hub.address, adminToken, '/v1/projects', 'POST', {
          name: 'Project',
          directory: '/etc',
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(hub.address, adminToken, '/v1/projects', 'POST', { name: 'x'.repeat(4100) }))
        .status,
    ).toBe(413);
  });
  it('allows only one authority process per durable data directory', async () => {
    const { hub, options } = await fixture();
    await expect(createHub(options)).rejects.toThrow('already using');
    await hub.close();
    const replacement = await createHub(options);
    cleanup.push(replacement.close);
    expect((await fetch(replacement.address + '/healthz')).status).toBe(200);
  });
  it('releases its singleton authority lock after HTTP startup failure', async () => {
    const { hub, options, root } = await fixture();
    const failedOptions = { ...options, dataDirectory: join(root, 'failed-start'), port: hub.port };
    await expect(createHub(failedOptions)).rejects.toThrow();
    const retried = await createHub({ ...failedOptions, port: 0 });
    cleanup.push(retried.close);
    expect((await fetch(retried.address + '/healthz')).status).toBe(200);
  });
  it('persists a shared project and keeps two teammates working after the creating laptop disconnects and hub restarts', async () => {
    const { root, hub, options, adminToken } = await fixture();
    let address = hub.address;
    const response = await api(address, adminToken, '/v1/projects', 'POST', { name: 'Always on' });
    expect(response.status).toBe(201);
    const project = (await response.json()) as { id: string; name: string };
    async function guest(name: string) {
      const folder = join(root, name);
      await mkdir(folder);
      const peer = await createPeerSession({
        stateDirectory: join(root, name + '-state'),
        network: options.network,
        pollMs: 100,
      });
      cleanup.push(() => peer.dispose());
      const invite = (await (
        await api(address, adminToken, `/v1/projects/${project.id}/invitations`, 'POST')
      ).json()) as { key: string };
      await peer.join(invite.key, folder);
      await until(() => peer.getState().status === 'connected', name + ' connected');
      return { peer, folder };
    }
    const creator = await guest('creator'),
      b = await guest('teammate-b'),
      c = await guest('teammate-c');
    await creator.peer.request('reserve', { paths: ['hello.ts'] }, 'creator-agent');
    await creator.peer.request(
      'publish',
      { changes: [{ path: 'hello.ts', baseHash: null, content: 'original' }] },
      'creator-agent',
    );
    await creator.peer.request('release', {}, 'creator-agent');
    await until(async () => {
      try {
        return (await readFile(join(b.folder, 'hello.ts'), 'utf8')) === 'original';
      } catch {
        return false;
      }
    }, 'initial shared file');
    const state = (await (
      await api(address, adminToken, `/v1/projects/${project.id}`)
    ).json()) as Record<string, unknown>;
    expect(state).not.toHaveProperty('key');
    expect(state).not.toHaveProperty('folder');
    expect((state.peers as unknown[]).length).toBe(3);
    await creator.peer.dispose();
    await b.peer.request('reserve', { paths: ['hello.ts'] }, 'agent-b');
    await b.peer.request(
      'publish',
      {
        changes: [
          {
            path: 'hello.ts',
            baseHash: createHash('sha256').update('original').digest('hex'),
            content: 'creator is offline',
          },
        ],
      },
      'agent-b',
    );
    await b.peer.request('release', {}, 'agent-b');
    await until(async () => {
      try {
        return (await readFile(join(c.folder, 'hello.ts'), 'utf8')) === 'creator is offline';
      } catch {
        return false;
      }
    }, 'teammates continue without creator');
    await hub.close();
    const restarted = await createHub(options);
    cleanup.push(restarted.close);
    address = restarted.address;
    const listed = (await (await api(address, adminToken, '/v1/projects')).json()) as {
      projects: { id: string }[];
    };
    expect(listed.projects.map((p) => p.id)).toEqual([project.id]);
    await until(
      () => b.peer.getState().status === 'connected' && c.peer.getState().status === 'connected',
      'persisted approvals reconnect',
    );
    await c.peer.request('reserve', { paths: ['after-restart.ts'] }, 'agent-c');
    await c.peer.request(
      'publish',
      { changes: [{ path: 'after-restart.ts', baseHash: null, content: 'still shared' }] },
      'agent-c',
    );
    await c.peer.request('release', {}, 'agent-c');
    await until(async () => {
      try {
        return (await readFile(join(b.folder, 'after-restart.ts'), 'utf8')) === 'still shared';
      } catch {
        return false;
      }
    }, 'continued publication after restart');
    const read = (await b.peer.request('read', { paths: ['hello.ts'] }, 'check')) as {
      files: { content: string }[];
    };
    expect(read.files[0]!.content).toBe('creator is offline');
  }, 60000);
});
