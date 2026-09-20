import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'coord-package-check-')));
try {
  await exec('unzip', ['-q', resolve('dist/coord-peer.zip'), '-d', directory]);
  const { stdout } = await exec(
    process.execPath,
    [
      join(directory, 'coord-peer.cjs'),
      'demo',
      ...(process.argv.includes('--wifi') ? ['--wifi'] : []),
    ],
    {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '', COORD_HOME: join(directory, 'private') },
      timeout: 65000,
    },
  );
  assert.match(stdout, /PASS — direct file transfer works/);
  assert.match(stdout, /Temporary demo files removed/);
  console.log(stdout.trim());
  console.log('Extracted download passed outside the repository, without installed dependencies.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
