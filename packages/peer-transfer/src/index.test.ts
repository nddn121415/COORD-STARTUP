import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generate } from 'selfsigned';
import { prepareTransfer, receiveTransfer } from './index.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-peer-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/code.ts'), 'export const answer = 42;\n');
  return root;
}
async function start(root: string) {
  const peer = await prepareTransfer({ repoRoot: root, paths: ['src/code.ts'] });
  cleanup.push(peer.close);
  return peer;
}
describe('direct peer transfer', () => {
  it('sends actual immutable selected bytes over TLS to new inboxes without Git or cloud', async () => {
    const root = await fixture();
    const peer = await start(root);
    await writeFile(join(root, 'src/code.ts'), 'changed after snapshot');
    const destination = join(root, 'inbox');
    const first = await receiveTransfer({ invitation: peer.invitation, destination });
    const second = await receiveTransfer({ invitation: peer.invitation, destination });
    expect(first.directory).not.toBe(second.directory);
    expect(await readFile(join(first.directory, 'src/code.ts'), 'utf8')).toBe(
      'export const answer = 42;\n',
    );
    expect((await stat(join(first.directory, 'src/code.ts'))).mode & 0o777).toBe(0o600);
    expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
  });
  it('rejects wrong capability, pin and expired invitations', async () => {
    const root = await fixture();
    const peer = await start(root);
    const destination = join(root, 'inbox');
    await expect(
      receiveTransfer({ invitation: { ...peer.invitation, token: '0'.repeat(64) }, destination }),
    ).rejects.toThrow('403');
    await expect(
      receiveTransfer({
        invitation: { ...peer.invitation, certificate_sha256: '0'.repeat(64) },
        destination,
      }),
    ).rejects.toThrow('pin');
    await expect(
      receiveTransfer({
        invitation: { ...peer.invitation, expires_at: new Date(0).toISOString() },
        destination,
      }),
    ).rejects.toThrow('expired');
  });
  it('rejects traversal, duplicate/case collisions, symlinks, secrets and binary', async () => {
    const root = await fixture();
    await symlink(join(root, 'src/code.ts'), join(root, 'link.ts'));
    await writeFile(join(root, 'config.ts'), 'API_KEY=abcdefgh123456789');
    await writeFile(join(root, 'raw.bin'), Buffer.from([0, 255]));
    for (const paths of [
      ['../escape'],
      ['.env'],
      ['link.ts'],
      ['src/code.ts', 'src/CODE.ts'],
      ['config.ts'],
      ['raw.bin'],
      ['src'],
    ]) {
      await expect(prepareTransfer({ repoRoot: root, paths })).rejects.toThrow();
    }
  });
  it('rejects oversized files and unsupported lifetime', async () => {
    const root = await fixture();
    await writeFile(join(root, 'big.txt'), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    await expect(prepareTransfer({ repoRoot: root, paths: ['big.txt'] })).rejects.toThrow('4 MiB');
    await expect(
      prepareTransfer({ repoRoot: root, paths: ['src/code.ts'], ttlSeconds: 901 }),
    ).rejects.toThrow('TTL');
  });
  it('expires sender automatically', async () => {
    const root = await fixture();
    const peer = await prepareTransfer({ repoRoot: root, paths: ['src/code.ts'], ttlSeconds: 1 });
    cleanup.push(peer.close);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(
      receiveTransfer({ invitation: peer.invitation, destination: join(root, 'inbox') }),
    ).rejects.toThrow('expired');
  });
  it('rejects symlink inbox ancestry', async () => {
    const root = await fixture();
    const peer = await start(root);
    await symlink(join(root, 'src'), join(root, 'inbox'));
    await expect(
      receiveTransfer({ invitation: peer.invitation, destination: join(root, 'inbox') }),
    ).rejects.toThrow('symlink');
  });
  it('authenticates pinned TLS before sending any capability to a substituted peer', async () => {
    const root = await fixture();
    const peer = await start(root);
    const tls = await generate([{ name: 'commonName', value: 'localhost' }], {
      algorithm: 'sha256',
    });
    let requests = 0;
    const server = createServer({ key: tls.private, cert: tls.cert }, (_req, res) => {
      requests++;
      res.end('{}');
    });
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', ok);
    });
    cleanup.push(() => new Promise<void>((ok) => server.close(() => ok())));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/transfers/${peer.invitation.transfer_id}`;
    await expect(
      receiveTransfer({
        invitation: { ...peer.invitation, url },
        destination: join(root, 'inbox'),
      }),
    ).rejects.toThrow();
    expect(requests).toBe(0);
  });
  it('validates malicious authenticated manifests and digests before writing anything', async () => {
    const root = await fixture();
    const tls = await generate([{ name: 'commonName', value: 'localhost' }], {
      algorithm: 'sha256',
    });
    const id = randomUUID();
    let path = 'src/code.ts';
    let sha256 = '0'.repeat(64);
    const server = createServer({ key: tls.private, cert: tls.cert }, (_req, res) =>
      res.end(
        JSON.stringify({
          manifest: {
            version: 1,
            transfer_id: id,
            total_bytes: 1,
            files: [{ path, size: 1, sha256 }],
          },
          contents: ['YQ=='],
        }),
      ),
    );
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', ok);
    });
    cleanup.push(() => new Promise<void>((ok) => server.close(() => ok())));
    const invitation = {
      version: 1,
      transfer_id: id,
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/transfers/${id}`,
      token: 'a'.repeat(64),
      certificate_pem: tls.cert,
      certificate_sha256: createHash('sha256')
        .update(new X509Certificate(tls.cert).raw)
        .digest('hex'),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    const destination = join(root, 'inbox');
    await expect(receiveTransfer({ invitation, destination })).rejects.toThrow('digest');
    path = '../escape';
    sha256 = createHash('sha256').update('a').digest('hex');
    await expect(receiveTransfer({ invitation, destination })).rejects.toThrow();
    expect(await readdir(root)).not.toContain('inbox');
  });
});
