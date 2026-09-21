import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPeerSession, type PeerOptions } from './peer-session.js';
import { createWorkspaceGuard, type WorkspaceChange } from './workspace-guard.js';
import { AccountRequestError } from './account-client.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-cloud-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const canonical = join(root, 'canonical');
  await mkdir(canonical);
  const guard = await createWorkspaceGuard(canonical);
  const staged = new Map<string, WorkspaceChange[]>();
  let available = true;
  const projectId = randomUUID(),
    website = 'https://coord.example';
  const cloudRequest: NonNullable<PeerOptions['cloud']>['request'] = async (
    origin,
    project,
    peer,
    session,
    op,
    input,
  ) => {
    expect(origin).toBe(website);
    expect(project).toBe(projectId);
    if (!available) throw new AccountRequestError('Service unavailable', 503);
    const owner = `${peer}:${session}`,
      batchKey = `${owner}:${input.batchId}`;
    if (op === 'manifest')
      return {
        files: (await guard.snapshot()).map(({ path, hash }) => ({ path, hash })),
        context: { agents: [], locks: guard.locks(), peers: [] },
      };
    if (op === 'read') {
      const file = (await guard.snapshot()).find((f) => f.path === input.path);
      if (!file) throw new AccountRequestError('File unavailable', 404);
      if (file.hash !== input.hash) throw new AccountRequestError('File changed', 409);
      return {
        path: file.path,
        hash: file.hash,
        contentBase64: Buffer.from(file.content).toString('base64'),
      };
    }
    if (op === 'reserve')
      await guard.reserve(owner, input.paths as string[]).catch((error: Error) => {
        throw new AccountRequestError(error.message, 409);
      });
    if (op === 'release') await guard.release(owner, input.paths as string[] | undefined);
    if (op === 'stage')
      staged.set(batchKey, [
        ...(staged.get(batchKey) ?? []),
        {
          path: input.path as string,
          baseHash: input.baseHash as string | null,
          content:
            input.contentBase64 === null
              ? null
              : Buffer.from(input.contentBase64 as string, 'base64').toString('utf8'),
        },
      ]);
    if (op === 'commit') {
      const files = await guard.publish(owner, staged.get(batchKey)!).catch((error: Error) => {
        throw new AccountRequestError(error.message, 409);
      });
      staged.delete(batchKey);
      return { ok: true, files };
    }
    if (op === 'abort') staged.delete(batchKey);
    return { ok: true };
  };
  async function client(name: string, initial?: string) {
    const folder = join(root, name);
    await mkdir(folder);
    if (initial) await writeFile(join(folder, 'file.ts'), initial);
    let signedIn = true;
    const options: PeerOptions = {
      stateDirectory: join(root, `${name}-state`),
      pollMs: 60_000,
      cloud: { currentWebsite: () => (signedIn ? website : undefined), request: cloudRequest },
    };
    const peer = await createPeerSession(options);
    cleanup.push(() => peer.dispose());
    await peer.joinCloud(projectId, folder, website);
    return {
      peer,
      folder,
      options,
      signOut: () => {
        signedIn = false;
      },
    };
  }
  return {
    root,
    client,
    guard,
    projectId,
    website,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}
it('shares folder edits over HTTPS, keeps collaboration alive after the first contributor closes, and resumes from saved state', async () => {
  const { client } = await fixture();
  const a = await client('a', 'original'),
    b = await client('b');
  expect(b.peer.getState().status).toBe('connected');
  expect(b.peer.getState().authority).toBe('service');
  expect(await readFile(join(b.folder, 'file.ts'), 'utf8')).toBe('original');
  await a.peer.dispose();
  await writeFile(join(b.folder, 'file.ts'), 'second computer');
  await b.peer.refresh();
  const c = await client('c');
  expect(await readFile(join(c.folder, 'file.ts'), 'utf8')).toBe('second computer');
  await b.peer.dispose();
  const resumed = await createPeerSession(b.options);
  cleanup.push(() => resumed.dispose());
  expect(resumed.getState().status).toBe('connected');
  expect(
    ((await resumed.request('read', { paths: ['file.ts'] }, 'agent')) as any).files[0].content,
  ).toBe('second computer');
});
it('enforces reservations across cloud agents and preserves conflicting local drafts through offline reconnect', async () => {
  const { client, setAvailable } = await fixture();
  const a = await client('a', 'original'),
    b = await client('b');
  await a.peer.request('reserve', { paths: ['file.ts'] }, 'agent-a');
  await expect(b.peer.request('reserve', { paths: ['file.ts'] }, 'agent-b')).rejects.toThrow();
  const original = ((await a.peer.request('read', { paths: ['file.ts'] }, 'agent-a')) as any)
    .files[0];
  await a.peer.request(
    'publish',
    { changes: [{ path: 'file.ts', baseHash: original.hash, content: 'shared revision' }] },
    'agent-a',
  );
  await a.peer.request('release', {}, 'agent-a');
  setAvailable(false);
  await writeFile(join(b.folder, 'file.ts'), 'offline draft');
  await b.peer.refresh();
  expect(b.peer.getState().status).toBe('offline');
  expect(await readFile(join(b.folder, 'file.ts'), 'utf8')).toBe('offline draft');
  setAvailable(true);
  await b.peer.refresh();
  expect(b.peer.getState().status).toBe('connected');
  expect(b.peer.getState().conflicts).toContain('file.ts');
  expect(await readFile(join(b.folder, 'file.ts'), 'utf8')).toBe('offline draft');
  expect(
    ((await b.peer.request('read', { paths: ['file.ts'] }, 'agent-b')) as any).files[0].content,
  ).toBe('shared revision');
});
it('keeps local files safe when resumed without sign-in or after the website changes', async () => {
  const { client, website, projectId, root } = await fixture();
  const a = await client('a', 'original');
  a.signOut();
  await expect(a.peer.request('context', {}, 'agent')).rejects.toThrow('Sign in');
  await a.peer.refresh();
  expect(a.peer.getState().status).toBe('offline');
  await a.peer.dispose();
  const wrong = await createPeerSession({
    ...a.options,
    cloud: { ...a.options.cloud!, currentWebsite: () => 'https://other.example' },
  });
  cleanup.push(() => wrong.dispose());
  expect(wrong.getState().status).toBe('offline');
  await expect(wrong.request('context', {}, 'agent')).rejects.toThrow('Sign in');
  const next = join(root, 'new');
  await mkdir(next);
  await expect(wrong.joinCloud(projectId, next, website)).rejects.toThrow('Sign in');
  expect(await readFile(join(a.folder, 'file.ts'), 'utf8')).toBe('original');
});
it('rejects a cloud response that finishes after a project disconnect', async () => {
  const { client } = await fixture();
  const a = await client('a', 'original');
  const original = a.options.cloud!.request;
  let ready: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  a.options.cloud!.request = async (...args) => {
    const response = await original(...args);
    ready!();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return response;
  };
  const reading = a.peer.request('context', {}, 'old-agent');
  const rejected = expect(reading).rejects.toThrow('changed');
  await entered;
  await a.peer.disconnect();
  finish!();
  await rejected;
  expect(a.peer.getState().status).toBe('idle');
  expect(await readFile(join(a.folder, 'file.ts'), 'utf8')).toBe('original');
});
