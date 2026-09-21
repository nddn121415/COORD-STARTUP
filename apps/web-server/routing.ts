import type { IncomingMessage, ServerResponse } from 'node:http';

type Request = IncomingMessage & { body?: unknown; query?: Record<string, unknown> };
/** Normalize explicit Vercel rewrites; plain Node functions do not use Next.js catch-all routing. */
export function routeAccountRequest(handler: (req: Request, res: ServerResponse) => unknown) {
  return (req: Request, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'https://coord.invalid');
    const routes = url.searchParams.getAll('__coord_route');
    const route = url.pathname.startsWith('/api/account/')
      ? url.pathname.slice('/api/account/'.length)
      : routes.length === 1
        ? routes[0]
        : routes.length === 0 && typeof req.query?.__coord_route === 'string'
          ? req.query.__coord_route
          : undefined;
    if (!route || route.length > 250 || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(route)) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    url.searchParams.delete('__coord_route');
    req.url =
      '/api/account/' + route + (url.searchParams.size ? '?' + url.searchParams.toString() : '');
    return handler(req, res);
  };
}
