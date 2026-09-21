import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountClient, validateWebsite } from './account-client.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(request: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'coord-account-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const client = await createAccountClient({
    stateDirectory: dir,
    website: 'https://coord.example',
    fetch: request,
    protect: {
      encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
      decryptString: (value) => value.toString().split('').reverse().join(''),
    },
  });
  cleanup.push(async () => client.dispose());
  return { client, dir };
}
it('accepts only website origins with HTTPS or loopback HTTP', () => {
  expect(validateWebsite('http://localhost:3000')).toBe('http://localhost:3000');
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?token=x',
    'javascript:alert(1)',
  ])
    expect(() => validateWebsite(url)).toThrow();
});
it('pairs without exposing credentials and persists through the protection adapter', async () => {
  const token = 'session-secret-token-123456789';
  const calls: { url: string; options?: RequestInit }[] = [];
  const { client, dir } = await setup(async (url, options) => {
    calls.push({ url: String(url), options });
    const value = String(url).endsWith('device/start')
      ? {
          deviceCode: 'device-secret-123456789',
          userCode: 'ABCD1234',
          expiresAt: Date.now() + 600000,
        }
      : String(url).endsWith('device/poll')
        ? { status: 'approved', token }
        : { user: { id: 'user1' }, projects: [{ id: 'project1', name: 'Project', role: 'owner' }] };
    return Response.json(value);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect(await client.signIn()).toBe('https://coord.example/connect?code=ABCD1234');
  await vi.advanceTimersByTimeAsync(2500);
  await vi.waitFor(() => expect(client.getState().projects).toHaveLength(1));
  expect(JSON.stringify(client.getState())).not.toContain(token);
  expect(JSON.stringify(client.getState())).not.toContain('device-secret');
  expect((await readFile(join(dir, 'account-session.bin'), 'utf8')).includes(token)).toBe(false);
  expect((await stat(join(dir, 'account-session.bin'))).mode & 0o777).toBe(0o600);
  expect(calls.every((c) => c.options?.redirect === 'error')).toBe(true);
  expect((calls[2]?.options?.headers as Record<string, string>).Authorization).toBe(
    `Bearer ${token}`,
  );
  await client.signOut();
  expect(client.getState().signedIn).toBe(false);
  expect(calls.at(-1)?.url).toBe('https://coord.example/api/account/logout');
  expect(calls.at(-1)?.options?.method).toBe('POST');
});
it('rejects oversized responses and never accepts a redirect as a credential destination', async () => {
  const { client } = await setup(async (_url, options) => {
    expect(options?.redirect).toBe('error');
    return new Response('x'.repeat(524289));
  });
  await expect(client.signIn()).rejects.toThrow('too large');
});
it.each([false, true])(
  'revokes the previous origin before switching accounts (offline=%s)',
  async (offline) => {
    const calls: { url: string; options?: RequestInit }[] = [];
    const { client } = await setup(async (url, options) => {
      const path = String(url);
      calls.push({ url: path, options });
      if (path.endsWith('/logout')) {
        if (offline) throw new Error('Offline');
        return Response.json({ ok: true });
      }
      return Response.json(
        path.endsWith('/start')
          ? {
              deviceCode: 'device-secret-123456789',
              userCode: 'ABCD1234',
              expiresAt: Date.now() + 600000,
            }
          : path.endsWith('/poll')
            ? { status: 'approved', token: 'old-session-token-123456789' }
            : { user: { id: 'user1' }, projects: [] },
      );
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await client.signIn();
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => expect(client.getState().user?.id).toBe('user1'));
    await client.signIn('https://another.example');
    expect(calls.at(-2)?.url).toBe('https://coord.example/api/account/logout');
    expect((calls.at(-2)?.options?.headers as Record<string, string>).Authorization).toContain(
      'old-session-token',
    );
    expect(calls.at(-1)?.url).toBe('https://another.example/api/account/device/start');
    expect(
      (calls.at(-1)?.options?.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    expect(client.getState().signedIn).toBe(false);
    expect(!!client.getState().warning).toBe(offline);
  },
);

it('explains an unavailable shared service and non-JSON deployment failures', async () => {
  let html = false;
  const { client } = await setup(async () =>
    html
      ? new Response('<html>Deployment not found</html>', { status: 404 })
      : Response.json(
          { error: 'Accounts are ready. The always-on file service has not been deployed yet.' },
          { status: 503 },
        ),
  );
  await expect(client.signIn()).rejects.toThrow('always-on file service has not been deployed');
  html = true;
  await expect(client.signIn()).rejects.toThrow('Check its address and deployment');
});
