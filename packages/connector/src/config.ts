import { mkdir, writeFile, rename, readFile, chmod, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverRepository, digest } from '@coord/git-intel';
import { agentKindSchema } from '@coord/protocol';
import { validateServerUrl } from '@coord/realtime-client';
export const coordHome = () => process.env.COORD_HOME || join(homedir(), '.coord');
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink())
    throw new Error('COORD state directory must not be a symlink');
  await chmod(path, 0o700);
}
export async function writePrivateJson(path: string, data: unknown) {
  await privateDirectory(dirname(path));
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export interface Credentials {
  url: string;
  token: string;
}
export async function loadCredentials(): Promise<Credentials> {
  const file = join(coordHome(), 'credentials.json');
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o077) !== 0)
      throw new Error('Credentials must be a regular private file (chmod 600)');
    let value: Credentials;
    try {
      value = JSON.parse(await readFile(file, 'utf8')) as Credentials;
    } catch {
      throw new Error('Invalid private credential file. Run coord login again.');
    }
    try {
      validateServerUrl(value.url);
    } catch {
      throw new Error('Invalid server URL in private credential file. Run coord login again.');
    }
    if (
      typeof value.token !== 'string' ||
      !value.token ||
      value.token.length > 1024 ||
      /\s/.test(value.token)
    )
      throw new Error('Invalid token in private credential file. Run coord login again.');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Not logged in. Run coord login --url URL --token-file FILE first.');
    throw error;
  }
}
export async function loadLocalConfig(cwd: string) {
  const { root } = await discoverRepository(cwd);
  const credentials = await loadCredentials();
  let binding: { projectId: string; repositoryId: string; url: string };
  try {
    binding = JSON.parse(await readFile(join(root, '.coord', 'binding.json'), 'utf8'));
  } catch {
    throw new Error('Checkout is not bound. Run coord join --project PROJECT_ID first.');
  }
  if (!binding.projectId || !binding.repositoryId || binding.url !== credentials.url)
    throw new Error('Project binding does not match current login server. Run coord join again.');
  return {
    ...credentials,
    projectId: binding.projectId,
    repositoryId: binding.repositoryId,
    repoRoot: root,
    stateDir: join(coordHome(), 'sessions'),
  };
}

export function sessionStatePath(options: {
  url: string;
  projectId: string;
  repoRoot: string;
  agent: string;
  stateDir?: string;
  sessionId?: string;
}) {
  const key = digest(
    [
      options.url,
      options.projectId,
      options.repoRoot,
      options.agent,
      options.sessionId ?? 'default',
    ].join('\0'),
  );
  return join(options.stateDir ?? join(coordHome(), 'sessions'), key + '.json');
}
/** Inspect the default persistent MCP/daemon cursor without opening a cloud session. */
export async function loadPersistedCursor(repoRoot: string, agent: string) {
  const config = await loadLocalConfig(repoRoot);
  const path = sessionStatePath({ ...config, agent: agentKindSchema.parse(agent) });
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (info.mode & 0o077) !== 0)
      throw new Error('Unsafe local session state file');
    let state: { sessionId: unknown; afterSeq: unknown };
    try {
      state = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('Invalid local session state file');
    }
    if (
      !state ||
      typeof state.sessionId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(state.sessionId) ||
      typeof state.afterSeq !== 'number' ||
      !Number.isSafeInteger(state.afterSeq) ||
      state.afterSeq < 0
    )
      throw new Error('Invalid local session state file');
    return { session_id: state.sessionId, after_seq: state.afterSeq };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        'No persisted session for this checkout and agent. Start its MCP connection or coord daemon once first.',
      );
    throw error;
  }
}
