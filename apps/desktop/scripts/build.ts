import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: {
    main: resolve(root, 'src/main.ts'),
    preload: resolve(root, 'src/preload.ts'),
    'coord-mcp': resolve(root, 'coord-mcp.ts'),
    'local-mcp': resolve(root, 'local-mcp.ts'),
  },
  outdir: out,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', 'hyperdht'],
  sourcemap: false,
  logLevel: 'info',
});
await cp(resolve(root, 'src/ui'), resolve(out, 'ui'), { recursive: true });
console.log('Desktop built for direct invite-key collaboration.');
