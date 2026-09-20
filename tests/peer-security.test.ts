import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generate } from 'selfsigned';
import {
  prepareTransfer,
  receiveTransfer,
  transferLimits,
} from '../packages/peer-transfer/src/index.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-peer-security-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function maliciousPeer(respond: (req: IncomingMessage, res: ServerResponse) => void) {
  const tls = await generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    keySize: 2048,
  });
  const server = createServer({ key: tls.private, cert: tls.cert }, respond);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const transfer_id = randomUUID();
  return {
    version: 1,
    transfer_id,
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/transfers/${transfer_id}`,
    token: 'b'.repeat(64),
    certificate_pem: tls.cert,
    certificate_sha256: digest(new X509Certificate(tls.cert).raw),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}
function payload(id: string, paths: string[] = ['src/file.ts']) {
  return {
    manifest: {
      version: 1,
      transfer_id: id,
      files: paths.map((path) => ({ path, size: 1, sha256: digest('a') })),
      total_bytes: paths.length,
    },
    contents: paths.map(() => 'YQ=='),
  };
}

describe('independent direct peer adversarial review', () => {
  it('rejects authenticated traversal, Unicode/case collisions, invalid base64 and forged manifest fields without writes', async () => {
    const root = await directory(),
      destination = join(root, 'inbox');
    let body: unknown;
    const invitation = await maliciousPeer((_req, res) => res.end(JSON.stringify(body)));
    const id = invitation.transfer_id;
    const cases: unknown[] = [
      payload(id, ['../escape.ts']),
      payload(id, ['/absolute.ts']),
      payload(id, ['.ssh/id_rsa']),
      payload(id, ['src/a.ts', 'src/A.ts']),
      payload(id, ['src/é.ts', 'src/e\u0301.ts']),
      payload(id, ['src/a.ts', 'src/a.ts/child']),
      payload(id, ['src/a.ts', 'src/a.ts']),
      { ...payload(id), contents: ['YQ==='] },
      { ...payload(id), contents: [] },
      { ...payload(id), contents: ['Yg=='] },
      { ...payload(id), manifest: { ...payload(id).manifest, transfer_id: randomUUID() } },
      { ...payload(id), manifest: { ...payload(id).manifest, total_bytes: 0 } },
      {
        ...payload(id),
        manifest: {
          ...payload(id).manifest,
          files: [{ path: 'src/a.ts', size: -1, sha256: digest('a') }],
        },
      },
    ];
    for (body of cases) {
      await expect(receiveTransfer({ invitation, destination })).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }
  });

  it('aborts oversized authenticated streams before creating an inbox', async () => {
    const root = await directory();
    const invitation = await maliciousPeer((_req, res) => {
      res.end(Buffer.alloc(Math.ceil((transferLimits.totalBytes * 4) / 3) + 100001, 32));
    });
    await expect(receiveTransfer({ invitation, destination: join(root, 'inbox') })).rejects.toThrow(
      'too large',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('does not follow redirects or send a capability to an unpinned endpoint', async () => {
    const root = await directory();
    let redirectedRequests = 0;
    const substituted = await maliciousPeer((_req, res) => {
      redirectedRequests++;
      res.end('{}');
    });
    const invitation = await maliciousPeer((_req, res) => {
      res.writeHead(302, { Location: substituted.url }).end();
    });
    await expect(receiveTransfer({ invitation, destination: join(root, 'inbox') })).rejects.toThrow(
      '302',
    );
    await expect(
      receiveTransfer({
        invitation: {
          ...invitation,
          url: substituted.url.replace(substituted.transfer_id, invitation.transfer_id),
        },
        destination: join(root, 'inbox'),
      }),
    ).rejects.toThrow();
    expect(redirectedRequests).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it('stages executable-looking source as private data without touching existing files or following symlinks', async () => {
    const root = await directory(),
      source = join(root, 'source'),
      inbox = join(root, 'inbox');
    await mkdir(source);
    await mkdir(inbox);
    const marker = join(root, 'SHOULD_NOT_EXIST');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
    await writeFile(join(source, 'payload.js'), script);
    await writeFile(join(inbox, 'payload.js'), 'existing user file');
    const transfer = await prepareTransfer({ repoRoot: source, paths: ['payload.js'] });
    cleanup.push(transfer.close);
    const result = await receiveTransfer({ invitation: transfer.invitation, destination: inbox });
    expect(await readFile(join(result.directory, 'payload.js'), 'utf8')).toBe(script);
    expect(await readFile(join(inbox, 'payload.js'), 'utf8')).toBe('existing user file');
    await expect(readFile(marker)).rejects.toThrow();
    await symlink(inbox, join(root, 'link'));
    await expect(
      receiveTransfer({ invitation: transfer.invitation, destination: join(root, 'link/child') }),
    ).rejects.toThrow('symlink');
    await symlink(join(root, 'missing-external'), join(source, 'dangling'));
    await expect(
      prepareTransfer({ repoRoot: source, paths: ['dangling/new.ts'] }),
    ).rejects.toThrow();
  });
});
