import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTransfer, receiveTransfer } from '@coord/peer-transfer';

/** Exercise real HTTPS with disposable files; never touches a user's checkout. */
export async function runPeerDemo(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coord-demo-')));
  let sender: Awaited<ReturnType<typeof prepareTransfer>> | undefined;
  try {
    const source = join(root, 'sender');
    await mkdir(source);
    const sample = 'export const greeting = "Hello from the other computer!";\n';
    await writeFile(join(source, 'hello.ts'), sample);
    console.log('1/3 Created a sample file in a temporary sender folder.');
    sender = await prepareTransfer({ repoRoot: source, paths: ['hello.ts'], ttlSeconds: 60 });
    console.log('2/3 Sending directly over encrypted HTTPS on this computer…');
    const received = await receiveTransfer({
      invitation: sender.invitation,
      destination: join(root, 'receiver'),
    });
    if ((await readFile(join(received.directory, 'hello.ts'), 'utf8')) !== sample)
      throw new Error('Received sample differs from the original');
    console.log('3/3 Received hello.ts and verified its contents and SHA-256.');
    console.log('\nPASS — direct file transfer works. No Git, account or database was used.');
    console.log(
      'This tests one computer. A second computer still needs a reachable LAN/VPN address.',
    );
  } finally {
    await sender?.close();
    await rm(root, { recursive: true, force: true });
    console.log('Temporary demo files removed; your project was not changed.');
  }
}
