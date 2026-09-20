import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a),
      bk = Object.keys(b);
    return (
      ak.length === bk.length &&
      ak.every((k) => Object.hasOwn(b, k) && same((a as JsonObject)[k], (b as JsonObject)[k]))
    );
  }
  return false;
}
export async function assertRegular(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Refusing non-regular config file: ${path}`);
    if (stat.size > 1024 * 1024) throw new Error(`Config file exceeds 1 MiB: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function readOptional(path: string): Promise<string | undefined> {
  await assertRegular(path);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export async function prepareDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Refusing non-directory or symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}
/** Atomic replacement, private byte-for-byte backup, and optimistic concurrent-edit detection. */
export async function replaceConfig(
  path: string,
  before: string | undefined,
  after: string,
): Promise<string | undefined> {
  await prepareDirectory(dirname(path));
  if ((await readOptional(path)) !== before)
    throw new Error(`Config changed during installation; retry: ${path}`);
  if (before === after) return undefined;
  const backup = before === undefined ? undefined : `${path}.coord-backup-${randomUUID()}`;
  if (backup) await writeFile(backup, before!, { mode: 0o600, flag: 'wx' });
  const temp = `${path}.coord-tmp-${randomUUID()}`;
  try {
    await writeFile(temp, after, { mode: 0o600, flag: 'wx' });
    if ((await readOptional(path)) !== before)
      throw new Error(`Config changed during installation; retry: ${path}`);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return backup;
}
export function json(text: string | undefined, label: string): JsonObject {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON; fix its syntax before retrying.`);
  }
  return object(value, label);
}
export function commandSpec(command: string, args: string[]): { command: string; args: string[] } {
  if (
    !command ||
    [command, ...args].some(
      (v) => typeof v !== 'string' || v.includes('\0') || v.includes('\n') || v.includes('\r'),
    )
  ) {
    throw new Error('Integration command and arguments must be nonempty safe single-line strings');
  }
  return { command, args: [...args] };
}
