import { afterEach, expect, it } from 'vitest';
import createTestnet from 'hyperdht/testnet.js';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNetworkTransfer, receiveNetworkTransfer } from './peer-network.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-network-test-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const net = await createTestnet(3);
  cleanup.push(() => net.destroy());
  await writeFile(join(root, 'hello.ts'), 'export const wifi = true;\n');
  await writeFile(join(root, 'large.txt'), 'sample data\n'.repeat(100000));
  const options = { bootstrap: net.bootstrap };
  const sender = await prepareNetworkTransfer(
    { repoRoot: root, paths: ['hello.ts', 'large.txt'] },
    options,
  );
  cleanup.push(sender.close);
  return { root, options, sender };
}
it('discovers the sender by public key and stages a real encrypted transfer without an IP invitation', async () => {
  const { root, options, sender } = await fixture();
  const received = await receiveNetworkTransfer(sender.invitation, join(root, 'inbox'), options);
  expect(await readFile(join(received.directory, 'hello.ts'), 'utf8')).toBe(
    'export const wifi = true;\n',
  );
  expect(await readFile(join(received.directory, 'large.txt'), 'utf8')).toBe(
    'sample data\n'.repeat(100000),
  );
  expect(sender.invitation.transport).toBe('hyperdht');
}, 30000);
it('rejects tampered capabilities and certificate pins through the automatic transport', async () => {
  const { root, options, sender } = await fixture();
  for (const field of ['token', 'certificate_sha256'] as const) {
    await expect(
      receiveNetworkTransfer(
        {
          ...sender.invitation,
          transfer: { ...sender.invitation.transfer, [field]: '0'.repeat(64) },
        },
        join(root, 'inbox'),
        options,
      ),
    ).rejects.toThrow();
  }
}, 30000);
it('rejects expired and malformed invitations before attempting discovery', async () => {
  await expect(receiveNetworkTransfer({ transport: 'hyperdht' }, '/unused')).rejects.toThrow();
  const { root, options, sender } = await fixture();
  await expect(
    receiveNetworkTransfer(
      {
        ...sender.invitation,
        transfer: { ...sender.invitation.transfer, expires_at: new Date(0).toISOString() },
      },
      join(root, 'inbox'),
      options,
    ),
  ).rejects.toThrow('expired');
}, 30000);
