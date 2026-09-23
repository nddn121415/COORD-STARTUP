import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import legacy from './proxy.js';
import { cloudInput } from './cloud-input.js';
type Request = IncomingMessage & { body?: unknown };
type Options = {
  url?: string;
  publishableKey?: string;
  secretKey?: string;
  websiteUrl?: string;
  hubUrl?: string;
  portalToken?: string;
  googleEnabled?: boolean;
  googleOnly?: boolean;
  storageMode?: 'supabase';
  fetch?: typeof fetch;
};
const names = {
  access: '__Host-coord_access',
  refresh: '__Host-coord_refresh',
  oauth: '__Host-coord_oauth',
};
const id = z.string().uuid();
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function bounded(response: Response, limit = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new Error('Response too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  } finally {
    await reader.cancel();
  }
}
async function requestBody(req: Request, limit = 4096) {
  if (req.body !== undefined) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > limit) throw new ApiError(400, 'Request too large');
    return JSON.parse(text) as unknown;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new ApiError(400, 'Request too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as unknown;
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(value));
}
function cookie(res: ServerResponse, name: string, value: string, seconds: number) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [
    ...(Array.isArray(current) ? current : current ? [String(current)] : []),
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`,
  ]);
}
function cookies(req: Request) {
  const parsed: Record<string, string> = {};
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    try {
      parsed[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1));
    } catch {
      /* malformed cookies are ignored */
    }
  }
  return parsed;
}
function origin(value: string | undefined) {
  if (!value) throw new ApiError(503, 'Account service is not configured');
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new ApiError(503, 'Invalid account service configuration');
  return parsed.origin;
}
const authInput = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(12).max(128) })
  .strict();
export function createSupabaseHandler(options: Options) {
  const fetcher = options.fetch ?? fetch;
  return async (req: Request, res: ServerResponse) => {
    try {
      const base = origin(options.url),
        site = origin(options.websiteUrl);
      if (!options.publishableKey || !options.secretKey)
        throw new ApiError(503, 'Account service is not configured');
      const incoming = new URL(req.url ?? '/', site),
        path = incoming.pathname.replace(/^\/api\/account\/?/, ''),
        method = req.method ?? 'GET';
      const callback = path === 'callback' && method === 'GET';
      if (!['GET', 'POST', 'DELETE'].includes(method))
        throw new ApiError(405, 'Method not allowed');
      if (
        !callback &&
        ((req.headers.origin !== undefined && req.headers.origin !== site) ||
          req.headers['sec-fetch-site'] === 'cross-site')
      )
        throw new ApiError(403, 'Request origin rejected');
      const bearer = req.headers.authorization;
      if (bearer && !/^Bearer [a-f0-9]{64}$/.test(bearer))
        throw new ApiError(401, 'Invalid device session');
      const openDevice = path === 'device/start' || path === 'device/poll';
      if (method !== 'GET') {
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
          throw new ApiError(415, 'Use application/json');
        if (!bearer && !openDevice && req.headers.origin !== site)
          throw new ApiError(403, 'Browser origin required');
      }
      const jar = cookies(req);
      const clear = () => {
        cookie(res, names.access, '', 0);
        cookie(res, names.refresh, '', 0);
      };
      const auth = async (route: string, body?: unknown, access?: string) => {
        const response = await fetcher(base + '/auth/v1/' + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            apikey: options.publishableKey!,
            'Content-Type': 'application/json',
            ...(access ? { Authorization: 'Bearer ' + access } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        const data = await bounded(response);
        return { response, data };
      };
      const session = (data: Record<string, unknown>) => {
        const parsed = z
          .object({
            access_token: z.string().min(20).max(3500),
            refresh_token: z.string().min(10).max(3500),
            expires_in: z.number().positive().max(86400).optional(),
          })
          .safeParse(data);
        if (!parsed.success) throw new ApiError(503, 'Invalid authentication response');
        cookie(
          res,
          names.access,
          parsed.data.access_token,
          Math.floor(parsed.data.expires_in ?? 3600),
        );
        cookie(res, names.refresh, parsed.data.refresh_token, 30 * 86400);
        return parsed.data.access_token;
      };
      let access = jar[names.access];
      const verifiedUser = async (allowRefresh = true) => {
        let result = access ? await auth('user', undefined, access) : undefined;
        if (allowRefresh && (!result || !result.response.ok) && jar[names.refresh]) {
          const refreshed = await auth('token?grant_type=refresh_token', {
            refresh_token: jar[names.refresh],
          });
          if (refreshed.response.ok) {
            access = session(refreshed.data);
            result = await auth('user', undefined, access);
          }
        }
        if (!result?.response.ok || !id.safeParse(result.data.id).success) {
          clear();
          throw new ApiError(401, 'Sign in required');
        }
        return String(result.data.id);
      };
      const database = async (name: string, parameters: unknown, limit = 1024 * 1024) => {
        const response = await fetcher(base + '/rest/v1/rpc/' + name, {
          method: 'POST',
          headers: {
            apikey: options.secretKey!,
            ...(options.secretKey!.startsWith('eyJ')
              ? { Authorization: 'Bearer ' + options.secretKey! }
              : {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(parameters),
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
        const data = await bounded(response, limit);
        if (!response.ok) throw new ApiError(503, 'Account database is unavailable');
        if (typeof data.error === 'string')
          throw new ApiError(
            typeof data.status === 'number' && data.status >= 400 && data.status <= 499
              ? data.status
              : 400,
            data.error.slice(0, 300),
          );
        return data;
      };
      const rpc = async (
        action: string,
        payload: unknown,
        userId: string | null,
        deviceToken: string | null,
      ) => {
        return database('coord_account_api', {
          p_action: action,
          p_user_id: userId,
          p_device_token: deviceToken,
          p_payload: payload,
        });
      };
      if (path === 'config' && method === 'GET') {
        send(res, 200, {
          mode: 'supabase',
          googleEnabled: options.googleEnabled === true,
          ...(options.googleOnly ? { authMode: 'google' } : {}),
          hubConfigured:
            options.storageMode === 'supabase' || Boolean(options.hubUrl && options.portalToken),
          ...(options.storageMode === 'supabase' ? { syncTransport: 'https' } : {}),
          websiteUrl: site,
        });
        return;
      }
      if ((path === 'register' || path === 'login') && method === 'POST') {
        if (options.googleOnly) throw new ApiError(403, 'Use Google to sign in to COORD.');
        if (bearer) throw new ApiError(400, 'Use browser sign-in');
        const value = authInput.safeParse(await requestBody(req));
        if (!value.success)
          throw new ApiError(400, 'Use a valid email and a password of 12–128 characters');
        let route = 'token?grant_type=password',
          body: Record<string, unknown> = value.data;
        if (path === 'register') {
          const verifier = randomBytes(32).toString('base64url'),
            state = randomBytes(32).toString('hex');
          cookie(
            res,
            names.oauth,
            JSON.stringify({ verifier, state, expires: Date.now() + 3600000, next: '/' }),
            3600,
          );
          route =
            'signup?redirect_to=' +
            encodeURIComponent(site + '/api/account/callback?state=' + state);
          body = {
            ...body,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 's256',
          };
        }
        const result = await auth(route, body);
        if (!result.response.ok)
          throw new ApiError(
            result.response.status === 429 ? 429 : 400,
            path === 'login'
              ? 'Email or password was not accepted. Confirm your email if needed.'
              : 'Account could not be created. Check your email and password or try again later.',
          );
        if (!result.data.access_token) {
          send(res, 200, {
            confirmationRequired: true,
            message: 'Check your email to confirm your account, then sign in.',
          });
          return;
        }
        access = session(result.data);
        await verifiedUser(false);
        send(res, 200, { ok: true });
        return;
      }
      if (path === 'google' && method === 'POST') {
        if (bearer) throw new ApiError(400, 'Use browser sign-in');
        if (!options.googleEnabled) throw new ApiError(503, 'Google sign-in is not configured yet');
        const requested = z
          .object({ next: z.string().max(200).optional() })
          .strict()
          .safeParse(await requestBody(req));
        if (!requested.success) throw new ApiError(400, 'Invalid request');
        const next =
          requested.data.next && /^\/connect(?:\?code=[A-Fa-f0-9]{10})?$/.test(requested.data.next)
            ? requested.data.next
            : '/';
        const verifier = randomBytes(32).toString('base64url'),
          state = randomBytes(32).toString('hex');
        cookie(
          res,
          names.oauth,
          JSON.stringify({ verifier, state, expires: Date.now() + 600000, next }),
          600,
        );
        const url = new URL(base + '/auth/v1/authorize');
        url.searchParams.set('provider', 'google');
        url.searchParams.set('redirect_to', site + '/api/account/callback?state=' + state);
        url.searchParams.set(
          'code_challenge',
          createHash('sha256').update(verifier).digest('base64url'),
        );
        url.searchParams.set('code_challenge_method', 's256');
        send(res, 200, { url: url.href });
        return;
      }
      if (callback) {
        cookie(res, names.oauth, '', 0);
        const stored = z
          .object({
            verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            state: z.string().regex(/^[a-f0-9]{64}$/),
            expires: z.number(),
            next: z.string(),
          })
          .safeParse(JSON.parse(jar[names.oauth] ?? '{}'));
        const supplied = Buffer.from(incoming.searchParams.get('state') ?? '');
        if (
          !stored.success ||
          stored.data.expires < Date.now() ||
          supplied.length !== 64 ||
          !timingSafeEqual(supplied, Buffer.from(stored.data.state))
        )
          throw new ApiError(400, 'Sign-in expired. Start again.');
        const code = incoming.searchParams.get('code');
        if (!code || code.length > 2048) throw new ApiError(400, 'Sign-in was not completed');
        const result = await auth('token?grant_type=pkce', {
          auth_code: code,
          code_verifier: stored.data.verifier,
        });
        if (!result.response.ok) throw new ApiError(400, 'Sign-in expired. Start again.');
        access = session(result.data);
        await verifiedUser(false);
        const next = /^\/connect(?:\?code=[A-Fa-f0-9]{10})?$/.test(stored.data.next)
          ? stored.data.next
          : '/';
        res.writeHead(303, {
          Location: site + next,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end();
        return;
      }
      const deviceToken = bearer?.slice(7) ?? null;
      const sync = /^projects\/([a-f0-9-]{36})\/sync$/.exec(path);
      if (sync) {
        if (options.storageMode !== 'supabase') throw new ApiError(404, 'Not found');
        if (method !== 'POST') throw new ApiError(405, 'Method not allowed');
        if (!deviceToken) throw new ApiError(401, 'Desktop sign-in required');
        if (!id.safeParse(sync[1]).success) throw new ApiError(400, 'Invalid project');
        const body = await requestBody(req, 2 * 1024 * 1024);
        let parsed;
        try {
          parsed = cloudInput(body);
        } catch (error) {
          throw new ApiError(
            400,
            error instanceof z.ZodError
              ? 'Invalid sharing request'
              : error instanceof Error
                ? error.message
                : 'Invalid sharing request',
          );
        }
        const data = await database(
          'coord_sync_api',
          {
            p_project_id: sync[1],
            p_peer_id: parsed.peerId,
            p_session_id: parsed.sessionId,
            p_device_token: deviceToken,
            p_operation: parsed.operation,
            p_input: parsed.input,
          },
          2 * 1024 * 1024,
        );
        send(res, 200, data);
        return;
      }

      const userId = deviceToken || openDevice ? null : await verifiedUser();
      if (path === 'logout' && method === 'POST') {
        if (deviceToken) await rpc('logout', {}, null, deviceToken);
        else {
          const response = await fetcher(base + '/auth/v1/logout?scope=local', {
            method: 'POST',
            headers: { apikey: options.publishableKey!, Authorization: 'Bearer ' + access },
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok && response.status !== 401)
            throw new ApiError(503, 'Sign out unavailable. Try again.');
          clear();
        }
        send(res, 200, { ok: true });
        return;
      }
      const mappings: Record<string, [string, string]> = {
        workspace: ['GET', 'workspace'],
        projects: ['POST', 'project_create'],
        'invitations/accept': ['POST', 'invitation_accept'],
        'device/start': ['POST', 'device_start'],
        'device/poll': ['POST', 'device_poll'],
        'device/approve': ['POST', 'device_approve'],
      };
      let action = mappings[path]?.[1];
      let expectedMethod = mappings[path]?.[0];
      const payload: Record<string, unknown> = {};
      if (!action) {
        const match =
          /^projects\/([a-f0-9-]{36})(?:\/(invitations|connect|members\/([a-f0-9-]{36})|devices\/([a-f0-9]{64})))?$/.exec(
            path,
          );
        if (!match || !id.safeParse(match[1]).success) throw new ApiError(404, 'Not found');
        payload.projectId = match[1];
        action = !match[2]
          ? 'project_get'
          : match[2] === 'invitations'
            ? 'invitation_create'
            : match[2] === 'connect'
              ? 'connect'
              : match[3]
                ? 'member_remove'
                : 'device_revoke';
        expectedMethod = !match[2] ? 'GET' : match[3] || match[4] ? 'DELETE' : 'POST';
        if (match[3]) payload.userId = match[3];
        if (match[4]) payload.peerId = match[4];
      }
      if (method !== expectedMethod) throw new ApiError(405, 'Method not allowed');
      const body = method === 'GET' ? {} : await requestBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new ApiError(400, 'Invalid request');
      // URL identity wins over body properties, and authenticated identity is never accepted from JSON.
      const input = { ...body, ...payload };
      if (action === 'connect' && options.storageMode === 'supabase') {
        if (!deviceToken) throw new ApiError(401, 'Desktop sign-in required');
        if (!('transport' in input) || input.transport !== 'https')
          throw new ApiError(426, 'Update COORD to version 0.8 or later to connect this project.');
        const result = await rpc(
          action,
          { projectId: input.projectId, peerId: (input as Record<string, unknown>).peerId },
          null,
          deviceToken,
        );
        if (result.ok !== true) throw new ApiError(503, 'Could not connect project');
        send(res, 200, { transport: 'https', projectId: input.projectId });
        return;
      }
      if (action === 'connect' && (!options.hubUrl || !options.portalToken))
        throw new ApiError(
          503,
          'Accounts are ready. The always-on file service has not been deployed yet.',
        );
      const result = await rpc(action, input, userId, deviceToken);
      if (action === 'connect') {
        const hub = origin(options.hubUrl);
        const reply = await fetcher(hub + '/cloud/connect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-coord-portal-token': options.portalToken!,
          },
          body: JSON.stringify({
            projectId: input.projectId,
            peerId: (input as Record<string, unknown>).peerId,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(45000),
        });
        if (!reply.ok) throw new ApiError(503, 'The file service is temporarily unavailable');
        send(res, 200, await bounded(reply));
        return;
      }
      send(res, 200, result);
    } catch (error) {
      send(
        res,
        error instanceof ApiError ? error.status : error instanceof SyntaxError ? 400 : 503,
        {
          error:
            error instanceof ApiError
              ? error.message
              : error instanceof SyntaxError
                ? 'Invalid request'
                : 'Account service unavailable. Please try again.',
        },
      );
    }
  };
}
const handler = createSupabaseHandler({
  url: process.env.SUPABASE_URL,
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  secretKey: process.env.SUPABASE_SECRET_KEY,
  websiteUrl: process.env.COORD_WEBSITE_URL,
  hubUrl: process.env.COORD_HUB_URL,
  portalToken: process.env.COORD_PORTAL_TOKEN,
  googleEnabled: process.env.COORD_GOOGLE_ENABLED === '1',
  googleOnly: process.env.COORD_AUTH_MODE === 'google',
  storageMode: process.env.COORD_STORAGE_MODE === 'supabase' ? 'supabase' : undefined,
});
export default (req: Request, res: ServerResponse) =>
  process.env.SUPABASE_URL || process.env.COORD_AUTH_MODE === 'google'
    ? handler(req, res)
    : legacy(req, res);
