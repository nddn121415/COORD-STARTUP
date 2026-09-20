import { defineConfig } from 'tsup';
export default defineConfig({
  entry: {
    'control-plane': 'apps/control-plane/src/main.ts',
    coord: 'apps/cli/src/main.ts',
    mcp: 'packages/mcp-server/src/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: ['*.js', '*.js.map'],
  noExternal: [/^@coord\//],
});
