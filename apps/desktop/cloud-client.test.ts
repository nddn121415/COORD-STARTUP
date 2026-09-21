import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCloudClient, type CloudRequest } from './cloud-client.js';
import { AccountRequestError } from './account-client.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const context = { agents: [], locks: [], peers: [] };
const entry = (path: string, content: string) => ({
  path,
  hash: hash(content),
  contentBase64: Buffer.from(content).toString('base64'),
});
it('downloads a full one-MiB UTF-8 file, verifies its digest, and caches unchanged revisions', async () => {
  const file = entry('large.ts', 'a'.repeat(1024 * 1024));
  const remote = vi.fn<CloudRequest>(async (op) =>
    op === 'manifest' ? { files: [{ path: file.path, hash: file.hash }], context } : file,
  );
  const client = createCloudClient(remote);
  const result = (await client.request('snapshot', {}, 'agent')) as any;
  expect(result.files[0].content).toHaveLength(1024 * 1024);
  const unchanged = (await client.request('snapshot', { digest: result.digest }, 'agent')) as any;
  expect(unchanged.files).toBeUndefined();
  expect(remote.mock.calls.filter(([op]) => op === 'read')).toHaveLength(1);
  expect(
    ((await client.request('read', { paths: ['large.ts'] }, 'agent')) as any).files[0].hash,
  ).toBe(file.hash);
  expect(remote.mock.calls.filter(([op]) => op === 'read')).toHaveLength(1);
});
it('restarts changed manifests without returning a mixture of revisions', async () => {
  let revision = 0;
  const old = entry('file.ts', 'old'),
    next = entry('file.ts', 'new');
  const remote: CloudRequest = async (op) => {
    if (op === 'manifest') {
      const file = revision ? next : old;
      return { files: [{ path: file.path, hash: file.hash }], context };
    }
    if (!revision++) throw new AccountRequestError('File changed', 409);
    return next;
  };
  const result = (await createCloudClient(remote).request('snapshot', {}, 'agent')) as any;
  expect(result.files).toEqual([{ path: 'file.ts', hash: next.hash, content: 'new' }]);
});
it('rejects tampered or non-UTF-8 downloaded content before exposing a snapshot', async () => {
  const good = entry('file.ts', 'valid');
  for (const contentBase64 of [
    Buffer.from('tampered').toString('base64'),
    Buffer.from([0xff]).toString('base64'),
  ]) {
    const remote: CloudRequest = async (op) =>
      op === 'manifest'
        ? { files: [{ path: good.path, hash: good.hash }], context }
        : { ...good, contentBase64 };
    await expect(createCloudClient(remote).request('snapshot', {}, 'agent')).rejects.toThrow();
  }
});
it('stages a multi-file publication then commits once, with deletion and UTF-8 intact', async () => {
  const remote = vi.fn<CloudRequest>(async (op) =>
    op === 'commit'
      ? {
          ok: true,
          files: [
            { path: 'file.ts', hash: hash('π') },
            { path: 'gone.ts', hash: null },
          ],
        }
      : { ok: true },
  );
  const result = (await createCloudClient(remote).request(
    'publish',
    {
      changes: [
        { path: 'file.ts', baseHash: null, content: 'π' },
        { path: 'gone.ts', baseHash: hash('old'), content: null },
      ],
    },
    'agent',
  )) as any;
  expect(result.files).toHaveLength(2);
  expect(remote.mock.calls.map(([op]) => op)).toEqual(['stage', 'stage', 'commit']);
  const first = remote.mock.calls[0]![1];
  expect(Buffer.from(first.contentBase64 as string, 'base64').toString()).toBe('π');
  expect(remote.mock.calls.every(([, input]) => input.batchId === first.batchId)).toBe(true);
  expect(remote.mock.calls[1]![1].contentBase64).toBeNull();
});
it('aborts failed staged batches and never commits partially uploaded source', async () => {
  let staged = 0;
  const remote = vi.fn<CloudRequest>(async (op) => {
    if (op === 'stage' && ++staged === 2) throw new AccountRequestError('Reservation held', 409);
    return { ok: true };
  });
  await expect(
    createCloudClient(remote).request(
      'publish',
      {
        changes: [
          { path: 'a.ts', baseHash: null, content: 'a' },
          { path: 'b.ts', baseHash: null, content: 'b' },
        ],
      },
      'agent',
    ),
  ).rejects.toThrow('Reservation held');
  expect(remote.mock.calls.map(([op]) => op)).toEqual(['stage', 'stage', 'abort']);
});
it('rejects invalid sizes before uploading any part of a publication', async () => {
  const remote = vi.fn<CloudRequest>();
  await expect(
    createCloudClient(remote).request(
      'publish',
      { changes: [{ path: 'a.ts', baseHash: null, content: 'π'.repeat(1024 * 1024) }] },
      'agent',
    ),
  ).rejects.toThrow('1 MiB');
  expect(remote).not.toHaveBeenCalled();
});
it('never uploads credentials or protected project configuration', async () => {
  const remote = vi.fn<CloudRequest>();
  const client = createCloudClient(remote);
  for (const change of [
    { path: '.coord/private.json', baseHash: null, content: '{}' },
    { path: 'keys.ts', baseHash: null, content: 'API_KEY="private_literal_123"' },
  ])
    await expect(client.request('publish', { changes: [change] }, 'agent')).rejects.toThrow();
  expect(remote).not.toHaveBeenCalled();
});
