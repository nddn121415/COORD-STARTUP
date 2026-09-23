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
async function fixture(
  upstream: typeof fetch,
  cloud = false,
  auth: { googleOnly?: boolean; googleEnabled?: boolean } = {},
) {
  const handler = createSupabaseHandler({
    url: 'https://example.supabase.co',
    websiteUrl: site,
    publishableKey: 'sb_publishable_public',
    secretKey: secret,
    googleEnabled: auth.googleEnabled ?? true,
    googleOnly: auth.googleOnly,
    storageMode: cloud ? 'supabase' : undefined,
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

it('requires the new desktop transport before binding a cloud project', async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const call = await fixture(upstream, true);
  const project = '22222222-2222-4222-8222-222222222222';
  const device = {
    ...json({ peerId: 'a'.repeat(64) }),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'b'.repeat(64) },
  };
  expect((await call(`projects/${project}/connect`, device)).status).toBe(426);
  expect(upstream).not.toHaveBeenCalled();
  const response = await call(`projects/${project}/connect`, {
    ...device,
    body: JSON.stringify({ peerId: 'a'.repeat(64), transport: 'https', projectId: uid }),
  });
  expect(await response.json()).toEqual({ transport: 'https', projectId: project });
  expect(JSON.parse(String(upstream.mock.calls[0]![1]!.body))).toMatchObject({
    p_user_id: null,
    p_device_token: 'b'.repeat(64),
    p_payload: { projectId: project, peerId: 'a'.repeat(64) },
  });
});

it('validates cloud file paths, contents and caller identity before using its service credential', async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const call = await fixture(upstream, true);
  const route = `projects/${uid}/sync`;
  const body = {
    peerId: 'a'.repeat(64),
    sessionId: 'codex-1',
    operation: 'stage',
    input: {
      batchId: uid,
      path: 'src/main.ts',
      baseHash: null,
      contentBase64: Buffer.from('export const works = true;').toString('base64'),
    },
  };
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'b'.repeat(64) };
  const post = (value: unknown) =>
    call(route, { method: 'POST', headers, body: JSON.stringify(value) });
  expect((await post(body)).status).toBe(200);
  expect(JSON.parse(String(upstream.mock.calls[0]![1]!.body))).toEqual({
    p_project_id: uid,
    p_peer_id: body.peerId,
    p_session_id: 'codex-1',
    p_device_token: 'b'.repeat(64),
    p_operation: 'stage',
    p_input: body.input,
  });
  const rejected = [
    { ...body, userId: uid },
    { ...body, sessionId: '../bad' },
    { ...body, input: { ...body.input, path: '.env' } },
    { ...body, input: { ...body.input, path: '../outside' } },
    { ...body, input: { ...body.input, path: '.codex/config.toml' } },
    {
      ...body,
      input: {
        ...body.input,
        contentBase64: Buffer.from('AWS_SECRET_ACCESS_KEY="notarealsecret123"').toString('base64'),
      },
    },
    { ...body, input: { ...body.input, contentBase64: 'not-base64' } },
    { ...body, input: { ...body.input, contentBase64: Buffer.from([255]).toString('base64') } },
    {
      ...body,
      input: { ...body.input, contentBase64: Buffer.alloc(1024 * 1024 + 1, 97).toString('base64') },
    },
  ];
  for (const value of rejected) expect((await post(value)).status).toBe(400);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect((await call(route, json(body))).status).toBe(401);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it('transfers the largest supported file and propagates reservation and revoked-device errors', async () => {
  let fail = false;
  const contentBase64 = Buffer.alloc(1024 * 1024, 97).toString('base64');
  const upstream = vi.fn<typeof fetch>(async () =>
    Response.json(
      fail
        ? { error: 'Device revoked', status: 403 }
        : { path: 'large.txt', hash: 'a'.repeat(64), contentBase64 },
    ),
  );
  const call = await fixture(upstream, true);
  const post = () =>
    call(`projects/${uid}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'b'.repeat(64) },
      body: JSON.stringify({
        peerId: 'a'.repeat(64),
        sessionId: 'folder',
        operation: 'read',
        input: { path: 'large.txt' },
      }),
    });
  const response = await post();
  expect(response.status).toBe(200);
  expect((await response.json()).contentBase64).toBe(contentBase64);
  fail = true;
  expect((await post()).status).toBe(403);
});

it('blocks email login and registration in Google-only mode before contacting authentication or the database', async () => {
  const upstream = vi.fn<typeof fetch>();
  const call = await fixture(upstream, true, { googleOnly: true });
  for (const route of ['login', 'register']) {
    for (const body of [
      { email: 'alice@example.com', password: 'very-long-password' },
      { username: 'alice', password: 'very-long-password' },
      {},
    ]) {
      const response = await call(route, json(body));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Use Google to sign in to COORD.' });
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
  }
  expect(upstream).not.toHaveBeenCalled();
  expect(await (await call('config')).json()).toMatchObject({
    authMode: 'google',
    googleEnabled: true,
  });
});
it('reports unavailable Google setup and rejects OAuth start without creating a browser state', async () => {
  const upstream = vi.fn<typeof fetch>();
  const call = await fixture(upstream, true, { googleOnly: true, googleEnabled: false });
  expect(await (await call('config')).json()).toMatchObject({
    authMode: 'google',
    googleEnabled: false,
  });
  const start = await call('google', json({ next: '/connect?code=ABC1234567' }));
  expect(start.status).toBe(503);
  expect(await start.json()).toEqual({ error: 'Google sign-in is not configured yet' });
  expect(start.headers.getSetCookie()).toHaveLength(0);
  expect(upstream).not.toHaveBeenCalled();
});
it('preserves the desktop pairing code through Google-only PKCE sign-in', async () => {
  const upstream = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('/token?')
      ? Response.json({ access_token: access, refresh_token: refresh })
      : Response.json({ id: uid }),
  );
  const call = await fixture(upstream, true, { googleOnly: true });
  const start = await call('google', json({ next: '/connect?code=ABC1234567' }));
  expect(start.status).toBe(200);
  const provider = new URL((await start.json()).url);
  expect(provider.searchParams.get('provider')).toBe('google');
  expect(provider.searchParams.get('code_challenge_method')).toBe('s256');
  const state = new URL(provider.searchParams.get('redirect_to')!).searchParams.get('state');
  const response = await call('callback?code=google-code&state=' + state, {
    headers: {
      Cookie: start.headers.getSetCookie()[0]!.split(';')[0]!,
      'sec-fetch-site': 'cross-site',
    },
  });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(site + '/connect?code=ABC1234567');
  expect(response.headers.getSetCookie().join(';')).toContain('__Host-coord_access=');
  expect(upstream.mock.calls[0]![0]).toBe(
    'https://example.supabase.co/auth/v1/token?grant_type=pkce',
  );
});
