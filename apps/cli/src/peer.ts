import { Command, InvalidArgumentError } from 'commander';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { prepareTransfer, receiveTransfer } from '@coord/peer-transfer';
import { coordHome } from '@coord/connector';
import {
  prepareNetworkTransfer,
  receiveNetworkTransfer,
  networkInvitationSchema,
} from './peer-network.js';

function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError('Expected a nonnegative integer.');
  return Number(value);
}

async function readInvitation(path: string): Promise<unknown> {
  try {
    const file = await open(
      resolve(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 16384 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error('Invalid invitation file');
      const buffer = Buffer.alloc(16385);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > 16384) throw new Error('Invitation too large');
      return JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(
      'Invitation must be a readable, owner-only regular JSON file (chmod 600), at most 16 KiB; symlinks are refused.',
    );
  }
}

async function saveInvitation(path: string, invitation: unknown): Promise<void> {
  // Refuse a symlinked immediate parent and never replace an existing file.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!(await lstat(dirname(path))).isDirectory()) throw new Error('Invalid invitation directory');
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(invitation, null, 2) + '\n');
  } finally {
    await file.close();
  }
}

export function registerPeerCommands(
  program: Command,
  repo: () => string,
  output: (value: unknown) => void,
): void {
  program
    .command('share-files')
    .description(
      'Serve explicitly selected files directly over pinned TLS; no Git or COORD login required',
    )
    .requiredOption(
      '--file <path>',
      'Project-relative file to send; repeat for multiple files',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      '--invite-out <path>',
      'New private invitation file (default: COORD home/invitations/<transfer-id>.json)',
    )
    .option(
      '--host <host>',
      'Local interface to bind; use 0.0.0.0 for another computer',
      '127.0.0.1',
    )
    .option(
      '--advertise-host <host>',
      'Sender address reachable from the receiving computer',
      '127.0.0.1',
    )
    .option(
      '--wifi',
      'Automatically find and connect peers over normal internet/Wi-Fi, without IP setup',
    )
    .option('--port <port>', 'Listening port; 0 chooses an available port', integer, 0)
    .option('--ttl <seconds>', 'Invitation lifetime in seconds', integer, 300)
    .action(
      async (opts: {
        file: string[];
        inviteOut?: string;
        host: string;
        advertiseHost: string;
        port: number;
        ttl: number;
        wifi?: boolean;
      }) => {
        let transfer:
          | Awaited<ReturnType<typeof prepareTransfer>>
          | Awaited<ReturnType<typeof prepareNetworkTransfer>>;
        try {
          transfer = opts.wifi
            ? await prepareNetworkTransfer({
                repoRoot: resolve(repo()),
                paths: opts.file,
                ttlSeconds: opts.ttl,
              })
            : await prepareTransfer({
                repoRoot: resolve(repo()),
                paths: opts.file,
                host: opts.host,
                advertiseHost: opts.advertiseHost,
                port: opts.port,
                ttlSeconds: opts.ttl,
              });
        } catch {
          throw new Error(
            'Cannot share files. Check selected paths, secret-file exclusions, size limits, bind address, port and lifetime. Automatic Wi-Fi mode also needs internet and UDP peer connectivity.',
          );
        }
        const invitationPath = resolve(
          opts.inviteOut ??
            join(coordHome(), 'invitations', `${transfer.manifest.transfer_id}.json`),
        );
        try {
          await saveInvitation(invitationPath, transfer.invitation);
        } catch {
          await transfer.close();
          throw new Error(
            'Cannot save private invitation. Choose a new --invite-out path in a writable directory.',
          );
        }
        const expiresAt =
          'transfer' in transfer.invitation
            ? transfer.invitation.transfer.expires_at
            : transfer.invitation.expires_at;
        output({
          connection: opts.wifi ? 'automatic-peer-discovery' : 'direct-https',
          sharing: true,
          file_count: transfer.manifest.files.length,
          total_bytes: transfer.manifest.total_bytes,
          ...(opts.wifi ? {} : { endpoint: transfer.address }),
          expires_at: expiresAt,
          invitation_file: invitationPath,
          next: 'The invitation grants access until expiry. Send it through a secure channel. Keep this command running; Ctrl-C revokes access.',
        });
        await new Promise<void>((done) => {
          const stop = () => {
            clearTimeout(timer);
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
            void transfer.close().then(done, () => {
              process.stderr.write('COORD: Could not cleanly stop the file sender.\n');
              process.exitCode = 1;
              done();
            });
          };
          const timer = setTimeout(stop, Math.max(1, Date.parse(expiresAt) - Date.now()));
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      },
    );
  program
    .command('receive-files')
    .description(
      'Receive selected files directly into a new review directory; never applies or executes them',
    )
    .requiredOption('--invite <path>', 'Private invitation JSON file from the sender')
    .option('--inbox <path>', 'Parent directory for a new transfer folder (default: .coord/inbox)')
    .action(async (opts: { invite: string; inbox?: string }) => {
      const invitation = await readInvitation(opts.invite);
      let result: Awaited<ReturnType<typeof receiveTransfer>>;
      try {
        result = networkInvitationSchema.safeParse(invitation).success
          ? await receiveNetworkTransfer(
              invitation,
              resolve(opts.inbox ?? join(repo(), '.coord', 'inbox')),
            )
          : await receiveTransfer({
              invitation,
              destination: resolve(opts.inbox ?? join(repo(), '.coord', 'inbox')),
            });
      } catch {
        throw new Error(
          'Transfer failed. Check invitation validity, sender reachability, certificate pin, file policy, and writable inbox. No files were applied to your project.',
        );
      }
      output({
        received: true,
        directory: result.directory,
        files: result.manifest.files,
        hashes_verified: true,
        applied: false,
        next: 'Review and compare the staged files, then manually copy only the changes you accept into your project.',
      });
    });
}
