import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAccountProxy } from '../apps/web-server/proxy.js';
const proxy = createAccountProxy({
  hubUrl: process.env.COORD_HUB_URL,
  portalToken: process.env.COORD_PORTAL_TOKEN,
  allowLocal: true,
});
const files: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html'],
  '/connect': ['index.html', 'text/html'],
  '/download': ['index.html', 'text/html'],
  '/main.js': ['main.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
};
createServer((req, res) => {
  if (req.url?.startsWith('/api/account/')) {
    void proxy(req, res);
    return;
  }
  const entry = files[(req.url ?? '/').split('?')[0]!];
  if (!entry) {
    res.writeHead(404).end();
    return;
  }
  void readFile(new URL('../apps/web/' + entry[0], import.meta.url)).then(
    (body) =>
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }).end(body),
    () => res.writeHead(500).end(),
  );
}).listen(4300, '127.0.0.1', () => console.log('COORD website: http://localhost:4300'));
