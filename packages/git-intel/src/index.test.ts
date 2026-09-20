import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, rename, symlink, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeLocalPath,
  discoverRepository,
  git,
  observeGit,
  parsePorcelain,
  watchRepository,
  listWorktrees,
} from './index.js';
const dirs: string[] = [];
async function fixture(committed = true) {
  const root = await mkdtemp(join(tmpdir(), 'coord-git-'));
  dirs.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.test']);
  if (committed) {
    await writeFile(join(root, 'file.txt'), 'original\n');
    await writeFile(join(root, 'delete.txt'), 'delete\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
  }
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe('native Git metadata', () => {
  it('observes clean, unborn and detached repositories without remotes', async () => {
    const root = await fixture();
    const clean = await observeGit(root, 'repo');
    expect(clean.paths).toEqual([]);
    expect(clean.branch).toBe('main');
    expect(clean.head).toMatch(/^[a-f0-9]{40}$/);
    await git(root, ['checkout', '--detach']);
    expect((await observeGit(root, 'repo')).branch).toBeNull();
    const empty = await fixture(false);
    expect(await observeGit(empty, 'repo')).toMatchObject({
      branch: 'main',
      head: null,
      paths: [],
    });
  });
  it('separates index/worktree changes, untracked paths, deletes and renames', async () => {
    const root = await fixture();
    await writeFile(join(root, 'file.txt'), 'staged\n');
    await git(root, ['add', 'file.txt']);
    await writeFile(join(root, 'file.txt'), 'unstaged\n');
    await rename(join(root, 'delete.txt'), join(root, 'renamed file.txt'));
    await git(root, ['add', '-A']);
    await writeFile(join(root, 'file.txt'), 'unstaged again\n');
    await writeFile(join(root, 'untracked.txt'), 'not uploaded');
    const state = await observeGit(root, 'repo');
    expect(state.staged).toContain('file.txt');
    expect(state.unstaged).toContain('file.txt');
    expect(state.untracked).toEqual(['untracked.txt']);
    expect(state.renames).toContainEqual({ from_path: 'delete.txt', path: 'renamed file.txt' });
    await rm(join(root, 'file.txt'));
    expect((await observeGit(root, 'repo')).deleted).toContain('file.txt');
    expect(JSON.stringify(state)).not.toContain('not uploaded');
    expect(JSON.stringify(state)).not.toContain(root);
  });
  it('has stable opaque distinct identities for linked worktrees', async () => {
    const root = await fixture();
    const worktree = join(root, 'other-worktree');
    await git(root, ['worktree', 'add', '-b', 'feature', worktree]);
    const a = await discoverRepository(root),
      b = await discoverRepository(worktree);
    expect(a.commonDir).toBe(b.commonDir);
    expect(a.worktreeId).not.toBe(b.worktreeId);
    expect((await observeGit(worktree, 'repo')).branch).toBe('feature');
    expect(await listWorktrees(root)).toHaveLength(2);
  });
  it('filters sensitive paths and rejects symlink escape including missing children', async () => {
    const root = await fixture();
    await writeFile(join(root, '.env'), 'TOKEN=private');
    await writeFile(join(root, 'secret.json'), '{}');
    await symlink(tmpdir(), join(root, 'escape'));
    await symlink(join(root, '.env'), join(root, 'innocent.txt'));
    await symlink(join(tmpdir(), 'coord-missing-target-' + Date.now()), join(root, 'dangling'));
    await expect(assertSafeLocalPath(root, 'dangling/new.ts')).rejects.toThrow('unresolved');
    await mkdir(join(root, 'nested'));
    await symlink(tmpdir(), join(root, 'nested', 'link'));
    await expect(assertSafeLocalPath(root, 'nested/link/missing/deeper/file.ts')).rejects.toThrow(
      'outside',
    );
    await expect(assertSafeLocalPath(root, 'innocent.txt')).rejects.toThrow('sensitive');
    const result = await observeGit(root, 'repo');
    expect(result.paths).toEqual([]);
    await expect(assertSafeLocalPath(root, 'escape/new.txt')).rejects.toThrow('outside');
    await expect(assertSafeLocalPath(root, '../../etc/passwd')).rejects.toThrow();
    await expect(assertSafeLocalPath(root, '/etc/passwd')).rejects.toThrow();
  });
  it('ignores inherited Git directory overrides and disables local fsmonitor hooks', async () => {
    const root = await fixture(),
      external = await fixture();
    const hook = join(root, 'monitor.sh');
    await writeFile(hook, '#!/bin/sh\ntouch "$(dirname "$0")/hook-ran"\n');
    await chmod(hook, 0o700);
    await git(root, ['config', 'core.fsmonitor', hook]);
    vi.stubEnv('GIT_DIR', join(external, '.git'));
    vi.stubEnv('GIT_WORK_TREE', external);
    vi.stubEnv('GIT_INDEX_FILE', join(external, '.git', 'index'));
    expect((await discoverRepository(root)).root).not.toBe(
      (await discoverRepository(external)).root,
    );
    const result = await observeGit(root, 'repo');
    expect(result.untracked).toContain('monitor.sh');
    await expect(access(join(root, 'hook-ran'))).rejects.toThrow();
  });
  it('debounces watch events and reconciles periodically', async () => {
    const root = await fixture();
    let refreshes = 0;
    const close = await watchRepository(
      root,
      async () => {
        refreshes++;
      },
      { debounceMs: 20, reconcileMs: 50 },
    );
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'new.ts'), 'local');
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(refreshes).toBeGreaterThan(0);
    } finally {
      close();
    }
    const count = refreshes;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(refreshes).toBe(count);
  });
});
it('parses zero-delimited rename names and preserves spaces without quote guessing', () => {
  expect(parsePorcelain('R  new name.ts\0old name.ts\0?? x.ts\0').paths).toEqual([
    { path: 'new name.ts', from_path: 'old name.ts', mode: 'rename' },
    { path: 'x.ts', mode: 'create' },
  ]);
});
