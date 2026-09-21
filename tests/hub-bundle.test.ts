import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('starts the built hub with native SQLite, private persistent storage and authenticated administration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coord-hub-bundle-'));
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [resolve('dist/hub.js')], {
    env: {
      ...process.env,
      COORD_HUB_ADMIN_TOKEN: token,
      COORD_HUB_DATA: directory,
      COORD_HUB_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  let timeout: NodeJS.Timeout | undefined;
  try {
    const deadline = Date.now() + 10000;
    let address: string | undefined;
    while (Date.now() < deadline) {
      address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) break;
      if (child.exitCode !== null) throw new Error(`Built hub did not start: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(address).toBeTruthy();
    expect((await fetch(`${address}/healthz`)).status).toBe(200);
    expect((await fetch(`${address}/v1/projects`)).status).toBe(401);
    const response = await fetch(`${address}/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
    expect(await readdir(directory)).toContain('registry.sqlite');
    child.kill('SIGTERM');
    expect(
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), 5000);
        }),
      ]),
    ).toBe(0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
