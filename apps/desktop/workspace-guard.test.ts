import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceGuard, reconcileSnapshot } from './workspace-guard.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-guard-')));
  roots.push(root);
  await writeFile(join(root, 'file.ts'), 'original');
  return root;
}
describe('workspace ownership and compare-and-swap publishing', () => {
  it('serializes racing reservations and rejects unreserved publishing', async () => {
    const root = await fixture(),
      guard = await createWorkspaceGuard(root);
    const results = await Promise.allSettled([
      guard.reserve('alice', ['file.ts']),
      guard.reserve('bob', ['file.ts']),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(guard.locks()).toEqual([
      { path: 'file.ts', owner: 'alice', expiresAt: expect.any(Number) },
    ]);
    await expect(
      guard.publish('bob', [{ path: 'file.ts', baseHash: digest('original'), content: 'bob' }]),
    ).rejects.toThrow('Reservation');
    await guard.publish('alice', [
      { path: 'file.ts', baseHash: digest('original'), content: 'alice' },
    ]);
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('alice');
    await guard.release('alice');
    await guard.reserve('bob', ['file.ts']);
    expect(guard.locks()[0]!.owner).toBe('bob');
  });
  it('expires leases and prevents stale owners from publishing after another owner claims', async () => {
    const root = await fixture();
    let now = 1000;
    const guard = await createWorkspaceGuard(root, { now: () => now, leaseMs: 120000 });
    await guard.reserve('alice', ['file.ts']);
    now += 119999;
    await guard.renew('alice');
    now += 120000;
    await expect(guard.renew('alice')).rejects.toThrow('No active');
    await guard.reserve('bob', ['file.ts']);
    await expect(
      guard.publish('alice', [{ path: 'file.ts', baseHash: digest('original'), content: 'stale' }]),
    ).rejects.toThrow('Reservation');
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('original');
  });
  it('validates every CAS before mutating any file and detects ordinary external edits', async () => {
    const root = await fixture();
    await writeFile(join(root, 'second.ts'), 'second');
    const guard = await createWorkspaceGuard(root);
    await guard.reserve('alice', ['file.ts', 'second.ts']);
    await writeFile(join(root, 'second.ts'), 'local edit');
    await expect(
      guard.publish('alice', [
        { path: 'file.ts', baseHash: digest('original'), content: 'new' },
        { path: 'second.ts', baseHash: digest('second'), content: 'bad overwrite' },
      ]),
    ).rejects.toThrow('changed');
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('original');
    expect(await readFile(join(root, 'second.ts'), 'utf8')).toBe('local edit');
    await expect(
      guard.publish('alice', [
        { path: 'file.ts', baseHash: digest('original'), content: 'new' },
        { path: 'second.ts', baseHash: digest('local edit'), content: 'API_KEY=abcdefgh12345' },
      ]),
    ).rejects.toThrow('Credential');
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('original');
  });
  it('supports checked create/delete and rejects duplicate or protected paths and links', async () => {
    const root = await fixture(),
      guard = await createWorkspaceGuard(root);
    await symlink(join(root, 'file.ts'), join(root, 'link.ts'));
    await mkdir(join(root, 'dir'));
    await symlink(join(root, 'dir'), join(root, 'linked'));
    for (const path of [
      '../escape',
      '.env',
      '.git/config',
      '.coord/a',
      '.codex/config.toml',
      '.claude/settings.json',
      '.mcp.json',
      'node_modules/a',
      'dist/app.js',
      'link.ts',
      'linked/code.ts',
    ])
      await expect(guard.reserve('alice', [path])).rejects.toThrow();
    await expect(guard.reserve('alice', ['x.ts', 'X.ts'])).rejects.toThrow('colliding');
    await guard.reserve('alice', ['new/file.ts', 'file.ts']);
    await guard.publish('alice', [
      { path: 'new/file.ts', baseHash: null, content: 'created' },
      { path: 'file.ts', baseHash: digest('original'), content: null },
    ]);
    expect(await readFile(join(root, 'new/file.ts'), 'utf8')).toBe('created');
    await expect(readFile(join(root, 'file.ts'))).rejects.toThrow();
  });
  it('snapshots only safe bounded text files without private metadata or binaries', async () => {
    const root = await fixture();
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'dep.js'), 'dependency');
    await writeFile(join(root, '.env'), 'SECRET=notshared');
    await writeFile(join(root, 'config.ts'), 'API_KEY=abcdefgh12345678');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 255]));
    await symlink(join(root, 'file.ts'), join(root, 'link.ts'));
    const guard = await createWorkspaceGuard(root);
    expect(await guard.snapshot()).toEqual([
      { path: 'file.ts', content: 'original', hash: digest('original') },
    ]);
    await guard.reserve('alice', ['big.ts']);
    await expect(
      guard.publish('alice', [
        { path: 'big.ts', baseHash: null, content: 'a'.repeat(1024 * 1024 + 1) },
      ]),
    ).rejects.toThrow('1 MiB');
  });
  it('reconciles mirror files, preserves local edits and only deletes unchanged previous bytes', async () => {
    const root = await fixture();
    await writeFile(join(root, 'delete.ts'), 'delete');
    await writeFile(join(root, 'keep.ts'), 'local');
    const previous = {
      'file.ts': digest('original'),
      'delete.ts': digest('delete'),
      'keep.ts': digest('before-local'),
    };
    const result = await reconcileSnapshot(
      root,
      [
        { path: 'file.ts', content: 'remote', hash: digest('remote') },
        { path: 'new.ts', content: 'new', hash: digest('new') },
      ],
      previous,
    );
    expect(result.conflicts).toEqual(['keep.ts']);
    expect(result.baseline).toEqual({
      'file.ts': digest('remote'),
      'new.ts': digest('new'),
      'keep.ts': digest('before-local'),
    });
    expect(await readFile(join(root, 'keep.ts'), 'utf8')).toBe('local');
    await expect(readFile(join(root, 'delete.ts'))).rejects.toThrow();
    await writeFile(join(root, 'file.ts'), 'local edit');
    const again = await reconcileSnapshot(
      root,
      [
        { path: 'file.ts', content: 'remote2', hash: digest('remote2') },
        { path: 'new.ts', content: 'new', hash: digest('new') },
      ],
      result.baseline,
    );
    expect(again.conflicts).toContain('file.ts');
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('local edit');
  });
  it('rejects malformed incoming snapshots before changing files', async () => {
    const root = await fixture();
    await expect(
      reconcileSnapshot(root, [{ path: 'file.ts', content: 'bad', hash: digest('wrong') }], {
        'file.ts': digest('original'),
      }),
    ).rejects.toThrow('digest');
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('original');
  });
  it('serializes same-owner publishes and blocks folder publisher while an agent owns the file', async () => {
    const root = await fixture(),
      guard = await createWorkspaceGuard(root);
    await guard.reserve('agent-codex', ['file.ts']);
    await expect(guard.reserve('background-folder', ['file.ts'])).rejects.toThrow('reserved');
    const result = await Promise.allSettled([
      guard.publish('agent-codex', [
        { path: 'file.ts', baseHash: digest('original'), content: 'first' },
      ]),
      guard.publish('agent-codex', [
        { path: 'file.ts', baseHash: digest('original'), content: 'second' },
      ]),
    ]);
    expect(result.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('first');
  });
  it('omits newly sensitive local content without changing its existing bytes', async () => {
    const root = await fixture(),
      guard = await createWorkspaceGuard(root);
    await writeFile(join(root, 'file.ts'), 'API_KEY=do-not-share-this-value');
    expect(await guard.snapshot()).toEqual([]);
    expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('API_KEY=do-not-share-this-value');
  });
  it('caps aggregate workspace count across separate publishes without mutating the 501st file', async () => {
    const root = await fixture();
    await Promise.all(
      Array.from({ length: 499 }, (_, i) => writeFile(join(root, `existing-${i}.ts`), 'x')),
    );
    const guard = await createWorkspaceGuard(root);
    await guard.reserve('alice', ['extra.ts']);
    await expect(
      guard.publish('alice', [{ path: 'extra.ts', baseHash: null, content: 'overflow' }]),
    ).rejects.toThrow('Resulting workspace');
    await expect(readFile(join(root, 'extra.ts'))).rejects.toThrow();
    expect(await guard.snapshot()).toHaveLength(500);
    await guard.reserve('alice', ['file.ts']);
    await guard.publish('alice', [
      { path: 'file.ts', baseHash: digest('original'), content: null },
      { path: 'extra.ts', baseHash: null, content: 'replacement' },
    ]);
    expect(await guard.snapshot()).toHaveLength(500);
    expect(await readFile(join(root, 'extra.ts'), 'utf8')).toBe('replacement');
  });
  it('caps aggregate workspace bytes instead of only checking each publish batch', async () => {
    const root = await fixture();
    await rm(join(root, 'file.ts'));
    const content = 'a'.repeat(1024 * 1024);
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => writeFile(join(root, `large-${i}.ts`), content)),
    );
    const guard = await createWorkspaceGuard(root);
    await guard.reserve('alice', ['extra.ts']);
    await expect(
      guard.publish('alice', [{ path: 'extra.ts', baseHash: null, content: 'x' }]),
    ).rejects.toThrow('Resulting workspace');
    await expect(readFile(join(root, 'extra.ts'))).rejects.toThrow();
    expect(await guard.snapshot()).toHaveLength(16);
  });
  it('caps reservations across owners and permits existing renewals and reclaimed capacity', async () => {
    const root = await fixture(),
      guard = await createWorkspaceGuard(root);
    const paths = Array.from({ length: 500 }, (_, i) => `owned-${i}.ts`);
    await guard.reserve('alice', paths);
    await expect(guard.reserve('bob', ['overflow.ts'])).rejects.toThrow('500 active');
    expect(guard.locks()).toHaveLength(500);
    await guard.reserve('alice', [paths[0]!]);
    expect(guard.locks()).toHaveLength(500);
    await guard.release('alice', [paths[0]!]);
    await guard.reserve('bob', ['new-owner.ts']);
    expect(guard.locks()).toHaveLength(500);
  });
  it('reconciles a full 500-file snapshot as one bounded publish and replaces its full file set', async () => {
    const root = await fixture();
    await rm(join(root, 'file.ts'));
    const snapshot = Array.from({ length: 500 }, (_, index) => ({
      path: `source-${index}.ts`,
      content: `file ${index}`,
      hash: digest(`file ${index}`),
    }));
    const first = await reconcileSnapshot(root, snapshot, {});
    expect(first.conflicts).toEqual([]);
    expect(Object.keys(first.baseline)).toHaveLength(500);
    expect(await readFile(join(root, 'source-499.ts'), 'utf8')).toBe('file 499');
    const replacements = snapshot.map((file) => ({
      ...file,
      path: file.path.replace('source-', 'renamed-'),
    }));
    const second = await reconcileSnapshot(root, replacements, first.baseline);
    expect(second.conflicts).toEqual([]);
    expect(Object.keys(second.baseline)).toHaveLength(500);
    await expect(readFile(join(root, 'source-0.ts'))).rejects.toThrow();
    expect(await readFile(join(root, 'renamed-499.ts'), 'utf8')).toBe('file 499');
  });
});
