import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { installCodexIntegration, uninstallCodexIntegration } from './index.js';
const directories: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'coord-codex-'));
  directories.push(dir);
  return join(dir, 'config.toml');
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('Codex integration configuration', () => {
  it('backs up exact original, preserves values, is idempotent and removes only COORD', async () => {
    const path = await fixture();
    const original =
      '# user comment\nmodel = "user-model"\n[mcp_servers.other]\ncommand = "other"\nargs = ["literal"]\n';
    await writeFile(path, original);
    const options = {
      configPath: path,
      command: '/usr/bin/node',
      args: ['/path with space/coord.js', 'mcp', '--agent', 'codex'],
    };
    const result = await installCodexIntegration(options);
    expect(await readFile(result.backup!, 'utf8')).toBe(original);
    expect(TOML.parse(await readFile(path, 'utf8'))).toMatchObject({
      model: 'user-model',
      mcp_servers: {
        other: { command: 'other' },
        coord: { command: '/usr/bin/node', args: options.args },
      },
    });
    expect((await installCodexIntegration(options)).backup).toBeUndefined();
    await uninstallCodexIntegration({ configPath: path });
    expect(TOML.parse(await readFile(path, 'utf8'))).toEqual(TOML.parse(original));
  });
  it('refuses invalid TOML and preserves the exact file', async () => {
    const path = await fixture(),
      original = 'model = [bad';
    await writeFile(path, original);
    await expect(
      installCodexIntegration({ configPath: path, command: 'coord', args: [] }),
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('refuses existing unowned coord configuration and later user edits', async () => {
    const path = await fixture();
    await writeFile(path, '[mcp_servers.coord]\ncommand = "mine"\n');
    await expect(
      installCodexIntegration({ configPath: path, command: 'coord', args: [] }),
    ).rejects.toThrow('already exists');
    await rm(path);
    await installCodexIntegration({ configPath: path, command: 'coord', args: [] });
    await writeFile(path, '[mcp_servers.coord]\ncommand = "user-edit"\n');
    await expect(uninstallCodexIntegration({ configPath: path })).rejects.toThrow('edited');
    expect(await readFile(path, 'utf8')).toContain('user-edit');
  });
  it('refuses symlinks without touching targets', async () => {
    const path = await fixture(),
      target = `${path}.target`;
    await writeFile(target, 'model = "safe"\n');
    await symlink(target, path);
    await expect(
      installCodexIntegration({ configPath: path, command: 'coord', args: [] }),
    ).rejects.toThrow('non-regular');
    expect(await readFile(target, 'utf8')).toBe('model = "safe"\n');
  });
});
