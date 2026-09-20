import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { 'coord-peer': 'apps/cli/src/peer-standalone.ts' },
  outDir: 'dist/peer',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  clean: true,
  splitting: false,
  noExternal: [/^@coord\//, 'commander', 'selfsigned', 'zod', 'ws', '@iarna/toml'],
  external: ['hyperdht'],
  outExtension: () => ({ js: '.cjs' }),
});
