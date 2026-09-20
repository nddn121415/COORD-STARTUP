import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const portalUrl = process.env.COORD_PORTAL_URL ?? 'https://coord-team.waledblack14.chatgpt.site';
if (portalUrl) {
  const url = new URL(portalUrl);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw new Error('COORD_PORTAL_URL must use HTTPS (or localhost for development)');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('COORD_PORTAL_URL must not contain credentials, query, or fragment');
}
await build({
  entryPoints: {
    main: resolve(root, 'src/main.ts'),
    preload: resolve(root, 'src/preload.ts'),
    'coord-mcp': resolve(root, 'coord-mcp.ts'),
  },
  outdir: out,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', 'hyperdht'],
  define: { __COORD_PORTAL_URL__: JSON.stringify(portalUrl) },
  sourcemap: false,
  logLevel: 'info',
});
await cp(resolve(root, 'src/ui'), resolve(out, 'ui'), { recursive: true });
console.log(
  portalUrl
    ? `Desktop targets ${new URL(portalUrl).origin}`
    : 'Desktop built without a portal URL. Pairing will remain unavailable.',
);
