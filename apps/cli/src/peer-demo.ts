import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTransfer, receiveTransfer } from '@coord/peer-transfer';
import { prepareNetworkTransfer, receiveNetworkTransfer } from './peer-network.js';

/** Exercise real HTTPS with disposable files; never touches a user's checkout. */
export async function runPeerDemo(options: { wifi?: boolean } = {}): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-demo-')));
  let sender:
    | Awaited<ReturnType<typeof prepareTransfer>>
    | Awaited<ReturnType<typeof prepareNetworkTransfer>>
    | undefined;
  try {
    const source = join(root, 'sender');
    await mkdir(source);
    const sample = 'export const greeting = "Hello from the other computer!";\n';
    await writeFile(join(source, 'hello.ts'), sample);
    console.log('1/3 Created a sample file in a temporary sender folder.');
    sender = await (options.wifi ? prepareNetworkTransfer : prepareTransfer)({
      repoRoot: source,
      paths: ['hello.ts'],
      ttlSeconds: 90,
    });
    console.log(
      options.wifi
        ? '2/3 Discovering the peer automatically over the internet and sending encrypted data…'
        : '2/3 Sending directly over encrypted HTTPS on this computer…',
    );
    const received =
      'transfer' in sender.invitation
        ? await receiveNetworkTransfer(sender.invitation, join(root, 'receiver'))
        : await receiveTransfer({
            invitation: sender.invitation,
            destination: join(root, 'receiver'),
          });
    if ((await readFile(join(received.directory, 'hello.ts'), 'utf8')) !== sample)
      throw new Error('Received sample differs from the original');
    console.log('3/3 Received hello.ts and verified its contents and SHA-256.');
    console.log('\nPASS — direct file transfer works. No Git, account or database was used.');
    console.log(
      options.wifi
        ? 'Automatic discovery worked here. Two physical computers and restrictive networks still need testing.'
        : 'This tests one computer. Run demo --wifi to also test automatic internet peer discovery.',
    );
  } finally {
    await sender?.close();
    await rm(root, { recursive: true, force: true });
    console.log('Temporary demo files removed; your project was not changed.');
  }
}
