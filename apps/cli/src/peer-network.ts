import DHT from 'hyperdht';
import { createConnection, createServer, type Socket, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { invitationSchema, prepareTransfer, receiveTransfer } from '@coord/peer-transfer';

export const networkInvitationSchema = z
  .object({
    version: z.literal(1),
    transport: z.literal('hyperdht'),
    public_key: z.string().regex(/^[a-f0-9]{64}$/),
    transfer: invitationSchema,
  })
  .strict();
type NetworkOptions = { bootstrap?: { host: string; port: number }[] };

function bridge(local: Socket, peer: Duplex, active: Set<Duplex>) {
  active.add(local);
  active.add(peer);
  let localEnded = false;
  let peerEnded = false;
  local.on('end', () => {
    localEnded = true;
  });
  peer.on('end', () => {
    peerEnded = true;
  });
  const close = () => {
    local.destroy();
    peer.destroy();
    active.delete(local);
    active.delete(peer);
  };
  local.setTimeout(30000, close);
  local.on('error', close);
  peer.on('error', close);
  // A clean TCP close can occur while the encrypted stream is still flushing
  // buffered bytes. Let pipe finish normally; abort only premature closures.
  local.on('close', () => {
    active.delete(local);
    if (!localEnded) peer.destroy();
  });
  peer.on('close', () => {
    active.delete(peer);
    if (!peerEnded) local.destroy();
  });
  local.pipe(peer).pipe(local);
}

export async function prepareNetworkTransfer(
  options: { repoRoot: string; paths: string[]; ttlSeconds?: number },
  network: NetworkOptions = {},
  existingTransfer?: Awaited<ReturnType<typeof prepareTransfer>>,
) {
  // The existing authenticated TLS endpoint stays on loopback. DHT streams can
  // reach ONLY this fixed endpoint, never arbitrary local services.
  const transfer = existingTransfer ?? (await prepareTransfer(options));
  const target = new URL(transfer.invitation.url);
  const node = new DHT(network);
  node.on('error', () => {});
  const active = new Set<Duplex>();
  let closed = false;
  let expiry: NodeJS.Timeout | undefined;
  const server = node.createServer((peer) => {
    peer.on('error', () => {});
    if (closed || active.size >= 16 || Date.now() >= Date.parse(transfer.invitation.expires_at)) {
      peer.destroy();
      return;
    }
    bridge(
      createConnection({ host: '127.0.0.1', port: Number(target.port), allowHalfOpen: true }),
      peer,
      active,
    );
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    for (const socket of active) socket.destroy();
    await Promise.all([node.destroy({ force: true }), transfer.close()]);
  };
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      server.listen(DHT.keyPair()),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Automatic discovery unavailable')), 25000);
      }),
    ]);
    const remaining = Date.parse(transfer.invitation.expires_at) - Date.now();
    if (remaining <= 0) throw new Error('Transfer expired during discovery');
    expiry = setTimeout(() => void close(), remaining);
    expiry.unref();
    return {
      ...transfer,
      invitation: {
        version: 1 as const,
        transport: 'hyperdht' as const,
        public_key: server.address().publicKey.toString('hex'),
        transfer: transfer.invitation,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function receiveNetworkTransfer(
  input: unknown,
  destination: string,
  network: NetworkOptions = {},
) {
  const invitation = networkInvitationSchema.parse(input);
  // Reject expired invitations before contacting discovery peers.
  if (Date.parse(invitation.transfer.expires_at) <= Date.now())
    throw new Error('Invitation expired');
  const node = new DHT(network);
  node.on('error', () => {});
  const active = new Set<Duplex>();
  let accepted = false;
  const proxy = createServer({ allowHalfOpen: true }, (local) => {
    if (accepted) {
      local.destroy();
      return;
    }
    accepted = true;
    bridge(local, node.connect(Buffer.from(invitation.public_key, 'hex')), active);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.address() as AddressInfo;
    // TLS still checks the invitation's exact certificate pin and bearer token.
    return await receiveTransfer({
      invitation: {
        ...invitation.transfer,
        url: `https://127.0.0.1:${address.port}/transfers/${invitation.transfer.transfer_id}`,
      },
      destination,
    });
  } finally {
    for (const socket of active) socket.destroy();
    if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await node.destroy({ force: true });
  }
}
