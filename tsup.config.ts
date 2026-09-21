import { defineConfig } from 'tsup';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// tsup's clean patterns augment a recursive wipe; preserve separately packaged desktop/peer outputs.
const outDir = resolve('dist');
if (existsSync(outDir)) {
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.js(?:\.map)?$/.test(entry.name)) rmSync(join(outDir, entry.name));
  }
}
export default defineConfig({
  entry: {
    hub: 'apps/hub/main.ts',
    'control-plane': 'apps/control-plane/src/main.ts',
    coord: 'apps/cli/src/main.ts',
    mcp: 'packages/mcp-server/src/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: false,
  removeNodeProtocol: false,
  noExternal: [/^@coord\//],
});
