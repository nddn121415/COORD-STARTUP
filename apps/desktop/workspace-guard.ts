import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceLimits, safePath, textBytes } from './workspace-validation.js';

export type SnapshotFile = { path: string; content: string; hash: string };
export type WorkspaceChange = { path: string; baseHash: string | null; content: string | null };
export type WorkspaceLock = { path: string; owner: string; expiresAt: number };
export { workspaceLimits } from './workspace-validation.js';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const pathKey = (path: string) => safePath(path).normalize('NFC').toLowerCase();
function uniquePaths(paths: string[]) {
  const keys = paths.map(pathKey);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => keys.some((other) => key !== other && key.startsWith(other + '/')))
  )
    throw new Error('Duplicate, overlapping or case-colliding paths');
}
async function canonicalRoot(root: string) {
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Choose a workspace folder');
  return canonical;
}
async function checkPath(root: string, path: string) {
  safePath(path);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symlink paths are protected');
      if (current !== join(root, path) && !info.isDirectory())
        throw new Error('Path ancestor is not a folder');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return join(root, path);
}
async function readCurrent(root: string, path: string): Promise<Buffer | null> {
  const absolute = await checkPath(root, path);
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > workspaceLimits.fileBytes)
      throw new Error('Only regular files up to 1 MiB are supported');
    if ((await realpath(absolute)) !== absolute) throw new Error('Path changed while reading');
    const named = await lstat(absolute);
    if (named.dev !== before.dev || named.ino !== before.ino)
      throw new Error('File changed while reading');
    const bytes = Buffer.alloc(workspaceLimits.fileBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      count !== before.size ||
      count > workspaceLimits.fileBytes ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error('File changed while reading');
    return Buffer.from(bytes.subarray(0, count));
  } finally {
    await handle.close();
  }
}
async function createParents(root: string, path: string) {
  await checkPath(root, path);
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
      throw new Error('Unsafe workspace folder');
  }
}

/** Serializes guarded operations. Editors writing outside this API remain outside the lease system. */
export async function createWorkspaceGuard(
  folder: string,
  options: { leaseMs?: number; now?: () => number } = {},
) {
  const root = await canonicalRoot(folder),
    now = options.now ?? Date.now,
    leaseMs = options.leaseMs ?? workspaceLimits.leaseMs;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > workspaceLimits.leaseMs)
    throw new Error('Invalid lease duration');
  const reservations = new Map<string, WorkspaceLock>();
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  }
  function prune() {
    for (const [key, lock] of reservations) if (lock.expiresAt <= now()) reservations.delete(key);
  }
  function ownerId(owner: string) {
    if (
      typeof owner !== 'string' ||
      !owner.trim() ||
      owner.length > 200 ||
      /[\x00-\x1f\x7f]/.test(owner)
    )
      throw new Error('Invalid owner');
  }
  function assertReserved(owner: string, paths: string[]) {
    prune();
    for (const path of paths) {
      const lock = reservations.get(pathKey(path));
      if (!lock || lock.owner !== owner || lock.path !== path)
        throw new Error(`Reservation required for ${path}`);
    }
  }
  async function snapshot(): Promise<SnapshotFile[]> {
    const result: SnapshotFile[] = [];
    let total = 0,
      visited = 0;
    async function walk(prefix: string) {
      const entries = await readdir(join(root, prefix), { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 20_000) throw new Error('Workspace contains too many entries');
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        try {
          safePath(path);
        } catch {
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await checkPath(root, path);
          await walk(path);
          continue;
        }
        if (!entry.isFile()) continue;
        let bytes: Buffer | null;
        try {
          bytes = await readCurrent(root, path);
          if (!bytes) continue;
          const content = bytes.toString('utf8');
          if (!Buffer.from(content).equals(bytes)) continue;
          textBytes(content);
        } catch (error) {
          if (/changed|Symlink|Unsafe/.test((error as Error).message)) throw error;
          continue;
        }
        total += bytes.length;
        if (total > workspaceLimits.totalBytes || result.length >= workspaceLimits.files)
          throw new Error('Workspace snapshot exceeds 500 files or 16 MiB');
        result.push({ path, content: bytes.toString('utf8'), hash: hash(bytes) });
      }
    }
    await walk('');
    uniquePaths(result.map((file) => file.path));
    return result;
  }
  return {
    snapshot: () => serialized(snapshot),
    locks() {
      prune();
      return [...reservations.values()].map((lock) => ({ ...lock }));
    },
    reserve(owner: string, paths: string[]) {
      return serialized(async () => {
        ownerId(owner);
        if (!paths.length || paths.length > workspaceLimits.files)
          throw new Error('Select 1–500 files');
        uniquePaths(paths);
        prune();
        const resultingLocks = new Set([...reservations.keys(), ...paths.map(pathKey)]);
        if (resultingLocks.size > workspaceLimits.files)
          throw new Error('Workspace exceeds 500 active reservations');
        for (const path of paths) {
          await checkPath(root, path);
          const key = pathKey(path);
          for (const [other, lock] of reservations)
            if (
              (other === key || other.startsWith(key + '/') || key.startsWith(other + '/')) &&
              (lock.owner !== owner || lock.path !== path)
            )
              throw new Error(`File reserved by ${lock.owner}: ${path}`);
        }
        const expiresAt = now() + leaseMs;
        for (const path of paths) reservations.set(pathKey(path), { path, owner, expiresAt });
        return paths.map((path) => ({ ...reservations.get(pathKey(path))! }));
      });
    },
    release(owner: string, paths?: string[]) {
      return serialized(async () => {
        ownerId(owner);
        const keys = paths?.map(pathKey);
        for (const [key, lock] of reservations)
          if (lock.owner === owner && (!keys || keys.includes(key))) reservations.delete(key);
      });
    },
    renew(owner: string) {
      return serialized(async () => {
        ownerId(owner);
        prune();
        const owned = [...reservations.values()].filter((lock) => lock.owner === owner);
        if (!owned.length) throw new Error('No active reservations to renew');
        for (const lock of owned) lock.expiresAt = now() + leaseMs;
        return owned.map((lock) => ({ ...lock }));
      });
    },
    publish(owner: string, changes: WorkspaceChange[]) {
      return serialized(async () => {
        ownerId(owner);
        if (!changes.length || changes.length > workspaceLimits.files)
          throw new Error('Publish 1–500 file changes');
        uniquePaths(changes.map((change) => change.path));
        assertReserved(
          owner,
          changes.map((change) => change.path),
        );
        let total = 0;
        const prepared: { path: string; before: Buffer | null; after: Buffer | null }[] = [];
        for (const change of changes) {
          if (change.baseHash !== null && !hashPattern.test(change.baseHash))
            throw new Error('Invalid base hash');
          const after = change.content === null ? null : textBytes(change.content);
          total += after?.length ?? 0;
          if (total > workspaceLimits.totalBytes) throw new Error('Publish exceeds 16 MiB');
          const before = await readCurrent(root, change.path);
          if ((before ? hash(before) : null) !== change.baseHash)
            throw new Error(`File changed since reservation: ${change.path}`);
          prepared.push({ path: change.path, before, after });
        }
        const resultingFiles = new Map(
          (await snapshot()).map((file) => [file.path, Buffer.byteLength(file.content, 'utf8')]),
        );
        for (const file of prepared) {
          if (file.after) resultingFiles.set(file.path, file.after.length);
          else resultingFiles.delete(file.path);
        }
        uniquePaths([...resultingFiles.keys()]);
        const resultingBytes = [...resultingFiles.values()].reduce((sum, size) => sum + size, 0);
        if (
          resultingFiles.size > workspaceLimits.files ||
          resultingBytes > workspaceLimits.totalBytes
        )
          throw new Error('Resulting workspace exceeds 500 files or 16 MiB');
        // Stage every write before touching selected files. The final recheck detects
        // ordinary editor changes during preparation; hostile local races are not a sandbox.
        const staging = await mkdtemp(join(root, '.coord-write-'));
        const applied: typeof prepared = [];
        try {
          for (let index = 0; index < prepared.length; index++) {
            const file = prepared[index]!;
            if (file.after)
              await writeFile(join(staging, String(index)), file.after, {
                mode: 0o600,
                flag: 'wx',
              });
          }
          assertReserved(
            owner,
            prepared.map((file) => file.path),
          );
          for (const file of prepared) {
            const current = await readCurrent(root, file.path);
            if ((current ? hash(current) : null) !== (file.before ? hash(file.before) : null))
              throw new Error(`File changed before publish: ${file.path}`);
          }
          for (let index = 0; index < prepared.length; index++) {
            const file = prepared[index]!;
            await createParents(root, file.path);
            const target = await checkPath(root, file.path);
            if (file.after) await rename(join(staging, String(index)), target);
            else if (file.before) await rm(target);
            applied.push(file);
          }
        } catch (error) {
          for (const file of applied.reverse()) {
            // Never roll back over a newer external edit. Preserve a recovery copy.
            const current = await readCurrent(root, file.path).catch(() => undefined);
            if (
              current === undefined ||
              (current ? hash(current) : null) !== (file.after ? hash(file.after) : null)
            ) {
              if (file.before)
                await writeFile(
                  join(staging, `recovery-${randomBytes(8).toString('hex')}`),
                  file.before,
                  { mode: 0o600 },
                );
              throw new Error(
                `Publish interrupted by local edit; recovery files preserved in ${staging}`,
              );
            }
            if (file.before) {
              const temp = join(staging, `rollback-${randomBytes(8).toString('hex')}`);
              await writeFile(temp, file.before, { mode: 0o600 });
              await rename(temp, join(root, file.path));
            } else await rm(join(root, file.path), { force: true });
          }
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        await rm(staging, { recursive: true, force: true });
        return prepared.map((file) => ({
          path: file.path,
          hash: file.after ? hash(file.after) : null,
        }));
      });
    },
  };
}

/** Reconcile an approved peer mirror while retaining every diverged local file. */
export async function reconcileSnapshot(
  folder: string,
  snapshot: SnapshotFile[],
  previous: Record<string, string>,
) {
  if (
    !Array.isArray(snapshot) ||
    snapshot.length > workspaceLimits.files ||
    Object.keys(previous).length > workspaceLimits.files
  )
    throw new Error('Snapshot too large');
  uniquePaths(snapshot.map((file) => file.path));
  uniquePaths(Object.keys(previous));
  let total = 0;
  for (const file of snapshot) {
    safePath(file.path);
    const bytes = textBytes(file.content);
    total += bytes.length;
    if (total > workspaceLimits.totalBytes || hash(bytes) !== file.hash)
      throw new Error('Invalid snapshot content or digest');
  }
  for (const [path, digest] of Object.entries(previous)) {
    safePath(path);
    if (!hashPattern.test(digest)) throw new Error('Invalid previous hash');
  }
  const root = await canonicalRoot(folder),
    guard = await createWorkspaceGuard(root),
    baseline: Record<string, string> = Object.assign(Object.create(null), previous),
    conflicts: string[] = [];
  const incoming = new Map(snapshot.map((file) => [file.path, file]));
  // A whole snapshot must not alias an existing tracked path by Unicode/case.
  const allPaths = [...new Set([...incoming.keys(), ...Object.keys(previous)])];
  uniquePaths(allPaths);
  const changes: WorkspaceChange[] = [];
  for (const path of allPaths) {
    const file = incoming.get(path),
      oldHash = Object.hasOwn(previous, path) ? previous[path] : undefined;
    let bytes: Buffer | null;
    try {
      bytes = await readCurrent(root, path);
    } catch {
      conflicts.push(path);
      continue;
    }
    const currentHash = bytes ? hash(bytes) : null;
    if (file && currentHash === file.hash) {
      baseline[path] = file.hash;
      continue;
    }
    if (!file && currentHash === null) {
      delete baseline[path];
      continue;
    }
    if (currentHash !== (oldHash ?? null)) {
      conflicts.push(path);
      continue;
    }
    changes.push({ path, baseHash: currentHash, content: file?.content ?? null });
  }
  // Normal snapshots (including an empty mirror receiving 500 files) publish
  // once. A complete 500-file replacement can include 500 removals plus 500
  // creations; remove unchanged obsolete files first in two bounded batches.
  changes.sort((a, b) => Number(a.content !== null) - Number(b.content !== null));
  for (let offset = 0; offset < changes.length; offset += workspaceLimits.files) {
    const batch = changes.slice(offset, offset + workspaceLimits.files),
      paths = batch.map((change) => change.path);
    try {
      await guard.reserve('peer-reconcile', paths);
      await guard.publish('peer-reconcile', batch);
      for (const change of batch) {
        const file = incoming.get(change.path);
        if (file) baseline[change.path] = file.hash;
        else delete baseline[change.path];
      }
    } catch {
      // A concurrent local edit invalidates the batch. No staged content is
      // applied, and the previous baselines remain available for review.
      conflicts.push(...changes.slice(offset).map((change) => change.path));
      break;
    } finally {
      await guard.release('peer-reconcile', paths);
    }
  }
  return { baseline, conflicts };
}
