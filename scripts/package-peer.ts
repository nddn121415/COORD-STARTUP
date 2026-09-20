import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const directory = resolve('dist/peer');
await mkdir(directory, { recursive: true });
for (const file of ['README.txt', 'Test COORD.command', 'test-coord.sh']) {
  await copyFile(resolve('distribution', file), resolve(directory, file));
}
for (const file of ['Test COORD.command', 'test-coord.sh']) {
  await chmod(resolve(directory, file), 0o755);
}
execFileSync('zip', [
  '-q',
  '-j',
  resolve('dist/coord-peer.zip'),
  ...['coord-peer.cjs', 'README.txt', 'Test COORD.command', 'test-coord.sh'].map((file) =>
    resolve(directory, file),
  ),
]);
const checksum = createHash('sha256')
  .update(await readFile('dist/coord-peer.zip'))
  .digest('hex');
await writeFile('dist/coord-peer.zip.sha256', `${checksum}  coord-peer.zip\n`);
console.log('Created dist/coord-peer.zip and SHA-256 checksum.');
