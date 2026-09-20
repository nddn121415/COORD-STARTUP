import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { validateRelativePath, type GitObservation, type IntentPath } from '@coord/protocol';
const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const { stdout } = await exec(
    'git',
    [
      '-c',
      'core.quotepath=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    },
  );
  return stdout;
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function discoverRepository(cwd: string) {
  const root = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  const gitDir = await realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
  const commonDir = await realpath(
    resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim()),
  );
  return { root, gitDir, commonDir, worktreeId: digest(root + '\0' + gitDir) };
}
export async function assertSafeLocalPath(root: string, candidate: string): Promise<string> {
  const path = validateRelativePath(candidate);
  const canonicalRoot = await realpath(root);
  let current = resolve(canonicalRoot, path);
  // Check the nearest existing ancestor as deleted/new paths may not exist yet.
  while (current !== canonicalRoot) {
    try {
      await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = dirname(current);
      continue;
    }
    // An existing dangling symlink is not a nonexistent path: fail closed instead
    // of walking above it and accidentally authorizing a future external target.
    let canonical: string;
    try {
      canonical = await realpath(current);
    } catch {
      throw new Error('Path has an unresolved symlink or inaccessible ancestor');
    }
    const rel = relative(canonicalRoot, canonical);
    if (rel.startsWith('../') || rel === '..' || isAbsolute(rel))
      throw new Error('Path resolves outside repository');
    if (rel) validateRelativePath(rel);
    break;
  }
  return path;
}
export type ParsedStatus = Pick<
  GitObservation,
  'paths' | 'staged' | 'unstaged' | 'untracked' | 'deleted' | 'renames'
>;
export function parsePorcelain(status: string): ParsedStatus {
  const output: ParsedStatus = {
    paths: [],
    staged: [],
    unstaged: [],
    untracked: [],
    deleted: [],
    renames: [],
  };
  const tokens = status.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const row = tokens[i];
    if (!row) continue;
    const x = row[0],
      y = row[1],
      path = row.slice(3);
    const renamed = x === 'R' || y === 'R',
      copied = x === 'C' || y === 'C';
    const from = renamed || copied ? tokens[++i] : undefined;
    if (x === '!' && y === '!') continue;
    try {
      validateRelativePath(path);
      if (from) validateRelativePath(from);
    } catch {
      continue;
    }
    if (x === '?' && y === '?') {
      output.untracked.push(path);
      output.paths.push({ path, mode: 'create' });
      continue;
    }
    if (x !== ' ' && x !== '?') output.staged.push(path);
    if (y !== ' ' && y !== '?') output.unstaged.push(path);
    let mode: IntentPath['mode'] = x === 'A' || copied ? 'create' : 'modify';
    if (x === 'D' || y === 'D') {
      mode = 'delete';
      output.deleted.push(path);
    }
    if (renamed && from) {
      mode = 'rename';
      output.renames.push({ from_path: from, path });
    }
    output.paths.push({ path, mode, ...(renamed && from ? { from_path: from } : {}) });
  }
  return output;
}
export async function observeGit(cwd: string, repositoryId: string): Promise<GitObservation> {
  const info = await discoverRepository(cwd);
  const [raw, branch, head] = await Promise.all([
    git(info.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames']),
    git(info.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(
      (s) => s.trim(),
      () => null,
    ),
    git(info.root, ['rev-parse', '--verify', 'HEAD']).then(
      (s) => s.trim(),
      () => null,
    ),
  ]);
  const parsed = parsePorcelain(raw);
  const paths: IntentPath[] = [];
  for (const entry of parsed.paths) {
    try {
      await assertSafeLocalPath(info.root, entry.path);
      if (entry.from_path) await assertSafeLocalPath(info.root, entry.from_path);
      paths.push(entry);
    } catch {
      /* Unsafe metadata is deliberately filtered. */
    }
  }
  const allowed = new Set(paths.map((p) => p.path));
  return {
    repository_id: repositoryId,
    worktree_id: info.worktreeId,
    branch,
    head,
    paths,
    staged: parsed.staged.filter((p) => allowed.has(p)),
    unstaged: parsed.unstaged.filter((p) => allowed.has(p)),
    untracked: parsed.untracked.filter((p) => allowed.has(p)),
    deleted: parsed.deleted.filter((p) => allowed.has(p)),
    renames: parsed.renames.filter((p) => allowed.has(p.path)),
  };
}
/** Native watches are hints only. A bounded periodic Git reconciliation is authoritative. */
export async function watchRepository(
  cwd: string,
  refresh: () => Promise<void>,
  options: { debounceMs?: number; reconcileMs?: number; onError?: (error: unknown) => void } = {},
) {
  const info = await discoverRepository(cwd);
  let timer: ReturnType<typeof setTimeout> | undefined,
    running = false,
    again = false,
    closed = false;
  const run = async () => {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await refresh();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), options.debounceMs ?? 250);
  };
  const watchers: FSWatcher[] = [];
  for (const dir of new Set([info.root, info.gitDir, info.commonDir])) {
    try {
      const watcher = watch(dir, { recursive: dir === info.root }, (_event, filename) => {
        if (
          filename?.toString().includes('.coord/') &&
          !filename.toString().endsWith('.coord/refresh')
        )
          return;
        schedule();
      });
      watcher.on('error', (error) => options.onError?.(error));
      watchers.push(watcher);
    } catch (error) {
      options.onError?.(
        error,
      ); /* Periodic reconciliation still works on unsupported filesystems. */
    }
  }
  const interval = setInterval(() => void run(), options.reconcileMs ?? 15000);
  return () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(interval);
    for (const watcher of watchers) watcher.close();
  };
}

/** Worktree locations are local diagnostic data and must never be sent to the cloud. */
export async function listWorktrees(
  cwd: string,
): Promise<
  { root: string; head: string | null; branch: string | null; bare: boolean; detached: boolean }[]
> {
  const raw = await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  const result: {
    root: string;
    head: string | null;
    branch: string | null;
    bare: boolean;
    detached: boolean;
  }[] = [];
  let entry: (typeof result)[number] | undefined;
  for (const token of raw.split('\0')) {
    if (!token) {
      if (entry) result.push(entry);
      entry = undefined;
      continue;
    }
    if (token.startsWith('worktree '))
      entry = { root: token.slice(9), head: null, branch: null, bare: false, detached: false };
    else if (entry && token.startsWith('HEAD ')) entry.head = token.slice(5);
    else if (entry && token.startsWith('branch '))
      entry.branch = token.slice(7).replace(/^refs\/heads\//, '');
    else if (entry && token === 'bare') entry.bare = true;
    else if (entry && token === 'detached') entry.detached = true;
  }
  if (entry) result.push(entry);
  return result;
}
