import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { accountRoutes } from '../apps/hub/accounts.js';
it('cannot finish an in-flight connection request after its device session logs out', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,created_at INTEGER)');
    const bodies = new WeakMap<IncomingMessage, unknown>();
    let invitations = 0;
    const gateway = 'a'.repeat(64);
    const route = accountRoutes({
      db,
      portalToken: gateway,
      body: async (req) => bodies.get(req),
      exclusive: async (work) => work(),
      create: async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Team',
        createdAt: Date.now(),
      }),
      detail: async () => ({}),
      invite: async () => {
        invitations++;
        return 'key';
      },
      revoke: async () => {},
    });
    const call = (url: string, body: unknown, token?: string) => {
      const req = {
        url: '/account' + url,
        method: 'POST',
        headers: {
          'x-coord-portal-token': gateway,
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
      } as unknown as IncomingMessage;
      bodies.set(req, body);
      return route(req);
    };
    const owner = (await call('/register', {
      username: 'race_owner',
      password: 'long-enough-password',
    })) as { token: string; user: { id: string } };
    const project = (await call('/projects', { name: 'Team' }, owner.token)) as { id: string };
    const pair = (await call('/device/start', { name: 'Desktop' })) as {
      deviceCode: string;
      userCode: string;
    };
    await call('/device/approve', { userCode: pair.userCode }, owner.token);
    const device = (await call('/device/poll', { deviceCode: pair.deviceCode })) as {
      token: string;
    };
    let finish!: (body: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = call('/projects/' + project.id + '/connect', body, device.token);
    await call('/logout', {}, device.token);
    finish({ peerId: 'b'.repeat(64) });
    await expect(pending).rejects.toThrow('Session expired');
    expect(invitations).toBe(0);
  } finally {
    db.close();
  }
});
