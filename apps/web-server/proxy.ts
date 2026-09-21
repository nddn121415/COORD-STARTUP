import type { IncomingMessage, ServerResponse } from 'node:http';

type Request = IncomingMessage & { body?: unknown };
type Options = {
  hubUrl?: string;
  portalToken?: string;
  fetch?: typeof fetch;
  allowLocal?: boolean;
};
const cookieName = '__Host-coord_session';
const tokenPattern = /^[a-f0-9]{64}$/;
function response(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}
async function bodyOf(req: Request) {
  if (req.body !== undefined) {
    const value = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(value) > 4096) throw new Error('body');
    JSON.parse(value);
    return value;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new Error('body');
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString() || '{}';
  JSON.parse(value);
  return value;
}
/** Fixed upstream, narrow routes, no forwarding of browser-supplied identity headers. */
export function createAccountProxy(options: Options) {
  return async (req: Request, res: ServerResponse) => {
    try {
      const path = (req.url ?? '').split('?')[0]?.replace(/^\/api/, '') ?? '';
      const method = req.method ?? 'GET';
      const allowed =
        /^(?:\/account\/(?:register|login|logout|workspace|projects|invitations\/accept|device\/(?:start|poll|approve))|\/account\/projects\/[a-f0-9-]{36}(?:\/(?:invitations|connect|(?:members\/[a-f0-9-]{36}|devices\/[a-f0-9]{64})))?)$/;
      if (!allowed.test(path) || !['GET', 'POST', 'DELETE'].includes(method))
        return response(res, 404, { error: 'Not found' });
      if (!options.hubUrl || !options.portalToken)
        return response(res, 503, {
          error:
            'The collaboration service is not configured yet. Set COORD_HUB_URL and COORD_PORTAL_TOKEN in Vercel.',
        });
      const upstream = new URL(options.hubUrl);
      const local =
        options.allowLocal && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname);
      if (
        (upstream.protocol !== 'https:' && !(local && upstream.protocol === 'http:')) ||
        upstream.username ||
        upstream.password ||
        upstream.pathname !== '/' ||
        upstream.search ||
        upstream.hash ||
        !/^[a-f0-9]{64,256}$/i.test(options.portalToken)
      )
        return response(res, 503, { error: 'Invalid collaboration service configuration' });
      const origin = req.headers.origin;
      const host = req.headers.host;
      // Host is the deployment's routed Host, never a caller-supplied forwarded-host header.
      if (origin !== undefined) {
        if (
          typeof origin !== 'string' ||
          !host ||
          (origin !== 'https://' + host && !(options.allowLocal && origin === 'http://' + host))
        )
          return response(res, 403, { error: 'Request origin rejected' });
      }
      if (req.headers['sec-fetch-site'] === 'cross-site')
        return response(res, 403, { error: 'Cross-site request rejected' });
      if (
        method !== 'GET' &&
        req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
      )
        return response(res, 415, { error: 'Use application/json' });
      const bearer = req.headers.authorization;
      const cookies = (req.headers.cookie ?? '').split(';').map((value) => value.trim());
      const browserToken = cookies
        .find((value) => value.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1);
      const deviceRoute = path === '/account/device/start' || path === '/account/device/poll';
      const loginRoute = path === '/account/login' || path === '/account/register';
      if (method !== 'GET' && !deviceRoute && !bearer && !origin)
        return response(res, 403, { error: 'Browser origin required' });
      if (loginRoute && bearer) return response(res, 400, { error: 'Use browser sign-in' });
      const headers: Record<string, string> = {
        'x-coord-portal-token': options.portalToken,
        'Content-Type': 'application/json',
      };
      if (bearer) {
        if (!/^Bearer [a-f0-9]{64}$/.test(bearer))
          return response(res, 401, { error: 'Invalid session' });
        headers.authorization = bearer;
      } else if (browserToken && tokenPattern.test(browserToken))
        headers.authorization = 'Bearer ' + browserToken;
      const body = method === 'GET' ? undefined : await bodyOf(req);
      const result = await (options.fetch ?? fetch)(new URL(path, upstream), {
        method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      });
      const reader = result.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 1024 * 1024) throw new Error('upstream size');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
      }
      const value = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (loginRoute && result.ok) {
        if (typeof value.token !== 'string' || !tokenPattern.test(value.token))
          throw new Error('invalid session');
        res.setHeader(
          'Set-Cookie',
          cookieName +
            '=' +
            value.token +
            '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800',
        );
        delete value.token;
      }
      if ((path === '/account/logout' && result.ok) || (result.status === 401 && !bearer))
        res.setHeader(
          'Set-Cookie',
          cookieName + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        );
      response(res, result.status, value);
    } catch (error) {
      const invalid =
        error instanceof SyntaxError || (error instanceof Error && error.message === 'body');
      response(res, invalid ? 400 : 503, {
        error: invalid
          ? 'Invalid request body'
          : 'Collaboration service unavailable. Please try again.',
      });
    }
  };
}
export default createAccountProxy({
  hubUrl: process.env.COORD_HUB_URL,
  portalToken: process.env.COORD_PORTAL_TOKEN,
  allowLocal: process.env.NODE_ENV !== 'production' && process.env.COORD_ALLOW_LOCAL_HUB === '1',
});
