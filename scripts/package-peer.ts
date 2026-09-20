import { chmod, copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

const directory = resolve('dist/peer');
await mkdir(directory, { recursive: true });
for (const file of ['README.txt', 'Test COORD.command', 'Test Wi-Fi.command', 'test-coord.sh']) {
  await copyFile(resolve('distribution', file), resolve(directory, file));
}
for (const file of ['Test COORD.command', 'Test Wi-Fi.command', 'test-coord.sh']) {
  await chmod(resolve(directory, file), 0o755);
}
// Copy the exact installed native runtime graph from pnpm's lockfile. Keep all
// shipped platform prebuilds; recipients do not install packages or compile code.
const versions = new Map<string, string>();
async function dependencyDirectory(from: string, name: string): Promise<string> {
  let current = from;
  while (true) {
    try {
      return await realpath(join(current, 'node_modules', name));
    } catch {
      /* Search parent resolution paths. */
    }
    if (dirname(current) === current) throw new Error(`Missing runtime dependency: ${name}`);
    current = dirname(current);
  }
}
async function copyDependency(from: string, name: string): Promise<void> {
  const source = await dependencyDirectory(from, name);
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const previous = versions.get(name);
  if (previous) {
    if (previous !== metadata.version)
      throw new Error(`Cannot flatten conflicting runtime versions: ${name}`);
    return;
  }
  versions.set(name, metadata.version);
  await cp(source, join(directory, 'node_modules', name), {
    recursive: true,
    filter: (path) => basename(path) !== 'node_modules',
  });
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    await copyDependency(source, dependency);
  }
  for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
    try {
      await dependencyDirectory(source, dependency);
    } catch {
      continue;
    }
    await copyDependency(source, dependency);
  }
}
await copyDependency(resolve('.'), 'hyperdht');
await rm(resolve('dist/coord-peer.zip'), { force: true });
execFileSync('zip', ['-q', '-r', resolve('dist/coord-peer.zip'), '.'], { cwd: directory });
const checksum = createHash('sha256')
  .update(await readFile('dist/coord-peer.zip'))
  .digest('hex');
await writeFile('dist/coord-peer.zip.sha256', `${checksum}  coord-peer.zip\n`);
console.log('Created dist/coord-peer.zip and SHA-256 checksum.');
