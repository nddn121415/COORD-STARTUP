import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, writePrivateJson } from './config.js';
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it('rejects broadly readable credentials and never reflects malformed secret content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coord-private-'));
  dirs.push(root);
  vi.stubEnv('COORD_HOME', root);
  const file = join(root, 'credentials.json');
  await writePrivateJson(file, { url: 'ws://127.0.0.1:4100', token: 'opaque-device-token' });
  expect((await loadCredentials()).token).toBe('opaque-device-token');
  await chmod(file, 0o644);
  await expect(loadCredentials()).rejects.toThrow('private file');
  await chmod(file, 0o600);
  await writeFile(file, '{"token": "SUPER_PRIVATE_TOKEN", BROKEN');
  try {
    await loadCredentials();
    throw new Error('should have failed');
  } catch (error) {
    expect(String(error)).toContain('Invalid private credential file');
    expect(String(error)).not.toContain('SUPER_PRIVATE_TOKEN');
  }
});
