import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSupabaseHandler } from '../apps/web-server/supabase.js';
import { routeAccountRequest } from '../apps/web-server/routing.js';
const site = 'https://coord.example',
  uid = '11111111-1111-4111-8111-111111111111',
  secret = 'sb_secret_private-key',
  access = 'access.jwt.'.repeat(5),
  refresh = 'refresh-token-private';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
async function fixture(upstream: typeof fetch) {
  const handler = createSupabaseHandler({
    url: 'https://example.supabase.co',
    websiteUrl: site,
    publishableKey: 'sb_publishable_public',
    secretKey: secret,
    googleEnabled: true,
    fetch: upstream,
  });
  const routed = routeAccountRequest(handler);
  const server = createServer((req, res) => void routed(req, res));
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  closes.push(
    () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return (path: string, init: RequestInit = {}) =>
    fetch(
      'http://127.0.0.1:' +
        (server.address() as AddressInfo).port +
        '/api/account' +
        (path.startsWith('?') ? '' : '/') +
        path,
      {
        ...init,
        redirect: 'manual',
      },
    );
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { Origin: site, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
it('verifies browser identity with Auth before invoking service-only RPC and never returns keys', async () => {
  const upstream = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/user')
      ? Response.json({ id: uid, email: 'alice@example.com' })
      : Response.json({ user: { id: uid }, projects: [] }),
  );
  const call = await fixture(upstream);
  const response = await call('workspace', {
    headers: { Cookie: '__Host-coord_access=' + access, 'x-coord-user-id': 'attacker' },
  });
  expect(response.status).toBe(200);
  expect(upstream.mock.calls).toHaveLength(2);
  expect(JSON.parse(String(upstream.mock.calls[1]![1]!.body))).toEqual({
    p_action: 'workspace',
    p_user_id: uid,
    p_device_token: null,
    p_payload: {},
  });
  expect(upstream.mock.calls[1]![1]!.headers).toEqual({
    apikey: secret,
    'Content-Type': 'application/json',
  });
  expect(await response.text()).not.toContain(secret);
  const config = await call('config');
  expect(await config.json()).toEqual({
    mode: 'supabase',
    googleEnabled: true,
    hubConfigured: false,
    websiteUrl: site,
  });
});
it('refreshes HttpOnly sessions and keeps authentication tokens out of response JSON', async () => {
  const upstream = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('token?'))
      return Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600 });
    if (String(url).endsWith('/user'))
      return (init!.headers as Record<string, string>).Authorization === 'Bearer stale'
        ? Response.json({ error: 'expired' }, { status: 401 })
        : Response.json({ id: uid });
    return Response.json({ user: { id: uid }, projects: [] });
  });
  const call = await fixture(upstream);
  const response = await call('workspace', {
    headers: { Cookie: '__Host-coord_access=stale; __Host-coord_refresh=' + refresh },
  });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(await response.text()).not.toContain(refresh);
  const login = await call(
    'login',
    json({ email: 'alice@example.com', password: 'very-long-password' }),
  );
  expect(await login.json()).toEqual({ ok: true });
  expect(login.headers.get('set-cookie')).toContain('__Host-coord_access=');
});
it('rejects CSRF, invalid users and malformed device bearer tokens before privileged calls', async () => {
  const upstream = vi.fn<typeof fetch>(async () =>
    Response.json({ error: 'invalid' }, { status: 401 }),
  );
  const call = await fixture(upstream);
  expect(
    (
      await call('projects', {
        ...json({ name: 'X' }),
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  expect(
    (await call('workspace', { headers: { Authorization: 'Bearer forged.jwt' } })).status,
  ).toBe(401);
  expect(upstream.mock.calls).toHaveLength(0);
  expect(
    (await call('workspace', { headers: { Cookie: '__Host-coord_access=forged' } })).status,
  ).toBe(401);
  expect(upstream.mock.calls).toHaveLength(1);
});
it('binds Google PKCE callback to its browser state and uses a fixed safe redirect', async () => {
  const upstream = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('/token?')
      ? Response.json({ access_token: access, refresh_token: refresh })
      : Response.json({ id: uid }),
  );
  const call = await fixture(upstream);
  const start = await call('google', json({ next: 'https://attacker.example' }));
  const startBody = await start.json();
  const provider = new URL(startBody.url);
  expect(provider.origin).toBe('https://example.supabase.co');
  expect(provider.searchParams.get('code_challenge_method')).toBe('s256');
  const rawCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
  const redirect = new URL(provider.searchParams.get('redirect_to')!);
  const state = redirect.searchParams.get('state');
  expect(
    (await call('callback?code=one&state=bad', { headers: { Cookie: rawCookie } })).status,
  ).toBe(400);
  expect(upstream.mock.calls).toHaveLength(0);
  const response = await call('callback?code=one&state=' + state, {
    headers: { Cookie: rawCookie, 'sec-fetch-site': 'cross-site' },
  });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(site + '/');
  expect(JSON.parse(String(upstream.mock.calls[0]![1]!.body))).toMatchObject({
    auth_code: 'one',
    code_verifier: expect.any(String),
  });
});
it('handles email confirmation and preserves native pairing without browser identity', async () => {
  const upstream = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('/signup')
      ? Response.json({ user: { id: uid } })
      : Response.json({ deviceCode: 'b'.repeat(64), userCode: 'ABC1234567', expiresAt: 123 }),
  );
  const call = await fixture(upstream);
  const response = await call(
    'register',
    json({ email: 'alice@example.com', password: 'very-long-password' }),
  );
  expect((await response.json()).confirmationRequired).toBe(true);
  expect(response.headers.get('set-cookie')).not.toContain('__Host-coord_access');
  const pair = await call('device/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mac' }),
  });
  expect(pair.status).toBe(200);
  expect(JSON.parse(String(upstream.mock.calls[1]![1]!.body))).toEqual({
    p_action: 'device_start',
    p_user_id: null,
    p_device_token: null,
    p_payload: { name: 'Mac' },
  });
});

it('routes rewritten nested Vercel endpoints and preserves browser callback state', async () => {
  const upstream = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/user')
      ? Response.json({ id: uid })
      : String(url).includes('token?')
        ? Response.json({ access_token: access, refresh_token: refresh })
        : Response.json({ ok: true }),
  );
  const call = await fixture(upstream);
  const pair = await call('?__coord_route=device%2Fstart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name":"Mac"}',
  });
  expect(pair.status).toBe(200);
  expect(JSON.parse(String(upstream.mock.calls[0]![1]!.body)).p_action).toBe('device_start');
  const project = await call('?__coord_route=projects%2F' + uid, {
    headers: { Cookie: '__Host-coord_access=' + access },
  });
  expect(project.status).toBe(200);
  expect(JSON.parse(String(upstream.mock.calls.at(-1)![1]!.body))).toMatchObject({
    p_action: 'project_get',
    p_payload: { projectId: uid },
  });
  const start = await call('google', json({}));
  const provider = new URL((await start.json()).url);
  const state = new URL(provider.searchParams.get('redirect_to')!).searchParams.get('state');
  const callback = await call('?__coord_route=callback&code=one&state=' + state, {
    headers: { Cookie: start.headers.getSetCookie()[0]!.split(';')[0]! },
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe(site + '/');
  for (const route of ['..%2Fadmin', '%2F%2Fevil.example', 'device%2Fstart&__coord_route=config'])
    expect((await call('?__coord_route=' + route)).status).toBe(404);
});
