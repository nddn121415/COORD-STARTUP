import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAccountProxy } from '../apps/web-server/proxy.js';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
async function fixture(upstream = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))) {
  const proxy = createAccountProxy({
    hubUrl: 'https://hub.example',
    portalToken: 'a'.repeat(64),
    fetch: upstream,
    allowLocal: true,
  });
  const server = createServer((req, res) => void proxy(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closes.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return {
    origin,
    upstream,
    request: (path: string, init: RequestInit = {}) => fetch(origin + '/api/account/' + path, init),
  };
}
it('keeps browser secrets in secure HttpOnly cookies and strips spoofed identity headers', async () => {
  const f = await fixture(
    vi.fn<typeof fetch>(async () =>
      Response.json({ token: 'b'.repeat(64), user: { id: 'u', username: 'alice' } }),
    ),
  );
  const response = await f.request('login', {
    method: 'POST',
    headers: {
      Origin: f.origin,
      'Content-Type': 'application/json',
      'x-coord-portal-token': 'attacker',
      'oai-authenticated-user-id': 'attacker',
    },
    body: '{}',
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('__Host-coord_session=');
  expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(await response.json()).not.toHaveProperty('token');
  const request = f.upstream.mock.calls[0]![1]!;
  expect(request.headers).toEqual({
    'x-coord-portal-token': 'a'.repeat(64),
    'Content-Type': 'application/json',
  });
  expect(request.redirect).toBe('error');
});
it('blocks cross-origin mutations, nonJSON requests and arbitrary proxy destinations', async () => {
  const f = await fixture();
  for (const path of ['projects', 'logout', 'device/approve']) {
    expect(
      (
        await f.request(path, {
          method: 'POST',
          headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await f.request('login', {
        method: 'POST',
        headers: { Origin: f.origin, 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect((await f.request('../admin')).status).toBe(404);
  expect(f.upstream).not.toHaveBeenCalled();
});
it('supports native pairing, bounds bodies, and hides upstream error details', async () => {
  const f = await fixture();
  expect(
    (
      await f.request('device/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"Mac"}',
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.request('workspace', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } }))
      .status,
  ).toBe(200);
  expect(f.upstream.mock.calls[1]![1]!.headers).toMatchObject({
    authorization: 'Bearer ' + 'b'.repeat(64),
  });
  expect(
    (
      await f.request('login', {
        method: 'POST',
        headers: { Origin: f.origin, 'Content-Type': 'application/json' },
        body: '{"value":"' + 'x'.repeat(5000) + '"}',
      })
    ).status,
  ).toBe(400);
  f.upstream.mockRejectedValueOnce(new Error('secret credentials in upstream error'));
  const bad = await f.request('workspace');
  expect(bad.status).toBe(503);
  expect(await bad.text()).not.toContain('secret credentials');
});
