import { installCodexIntegration } from '@coord/adapter-codex';
import { installClaudeIntegration } from '@coord/adapter-claude';
import { createServer, request } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { relativePathSchema, safeText } from '@coord/protocol';

const maxBytes = 262144;
const deadlineMs = 10000;
export const localAgentSchemas = {
  context: z.object({}).strict(),
  workspace: z.object({ label: safeText(100, 1).optional() }).strict(),
  submit: z.object({}).strict(),
  read: z.object({ paths: z.array(relativePathSchema).min(1).max(50) }).strict(),
  heartbeat: z
    .object({ agent: z.enum(['codex', 'claude']), label: safeText(100, 1).optional() })
    .strict(),
  reserve: z
    .object({ paths: z.array(relativePathSchema).min(1).max(50), summary: safeText(500, 1) })
    .strict(),
  publish: z
    .object({
      changes: z
        .array(
          z
            .object({
              path: relativePathSchema,
              content: z.string().max(180000).nullable(),
              baseHash: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
  release: z.object({ paths: z.array(relativePathSchema).max(50).optional() }).strict(),
};
export type LocalAgentOperation = keyof typeof localAgentSchemas;
const operationNames = Object.keys(localAgentSchemas) as [
  LocalAgentOperation,
  ...LocalAgentOperation[],
];
const requestSchema = z
  .object({
    sessionId: z.string().uuid(),
    folder: z.string().min(1),
    operation: z.enum(operationNames),
    input: z.record(z.unknown()),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    socketPath: z.string().max(103),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type LocalAgentRequest = z.infer<typeof requestSchema>;

async function assertOwned(path: string, kind: 'directory' | 'file' | 'socket') {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (kind === 'directory'
      ? !stat.isDirectory()
      : kind === 'file'
        ? !stat.isFile()
        : !stat.isSocket()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('COORD local bridge requires owner-only files and directories.');
  }
  return stat;
}
async function readConfig(path: string) {
  await assertOwned(dirname(path), 'directory');
  await assertOwned(path, 'file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Invalid bridge config');
    const buffer = Buffer.alloc(8193);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 8192) throw new Error('Invalid bridge config');
    const value = configSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    if (!isAbsolute(value.socketPath)) throw new Error('Invalid bridge socket');
    await assertOwned(dirname(value.socketPath), 'directory');
    await assertOwned(value.socketPath, 'socket');
    return value;
  } finally {
    await handle.close();
  }
}

/** Return fixed public explanations, never callback exception text or local paths. */
function domainRejection(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  const cloudReasons: Record<string, [string, string]> = {
    'Another agent reserved this path': [
      'reserved',
      'Another agent owns a required file. Read coord_context to identify its reservation, then work on different files or wait for release.',
    ],
    'Reserve this file before publishing': [
      'reservation_required',
      'Reserve every changed path with coord_reserve before publishing or submitting.',
    ],
    'File reservation expired': [
      'reservation_required',
      'Your reservation expired. Read the latest shared files, reconcile your edits, then reserve the paths again before publishing.',
    ],
    'File changed; refresh before publishing': [
      'stale_base',
      'A shared file changed after your base was read. Read its current contents and base hash, reconcile your edits, then reserve and publish again. Do not overwrite newer work.',
    ],
    'File changed; refresh the project': [
      'stale_base',
      'Shared files changed while being read. Retry coord_read or coord_workspace to obtain the current version before editing.',
    ],
  };
  if (Object.hasOwn(cloudReasons, error.message)) {
    const [code, reason] = cloudReasons[error.message]!;
    return { rejected: true, code, reason };
  }
  const reasons: [string, string, string][] = [
    [
      'File reserved by ',
      'reserved',
      'Another agent owns a required file. Read coord_context to identify its reservation, then work on different files or wait for release.',
    ],
    [
      'Reservation required for ',
      'reservation_required',
      'Reserve every changed path with coord_reserve before publishing or submitting. Your previous reservation may have expired.',
    ],
    [
      'File changed since reservation: ',
      'stale_base',
      'A file changed after your base was read. Read its current contents and base hash, reconcile your edits, then reserve and publish again. Do not overwrite the newer work.',
    ],
    [
      'File changed before publish: ',
      'stale_base',
      'A file changed during publication. Read the latest shared version and reconcile before retrying.',
    ],
    [
      'Create your agent workspace first',
      'workspace_required',
      'Call coord_workspace first, edit only inside the returned directory, then reserve and submit your changes.',
    ],
    [
      'An edited file is excluded from sharing: ',
      'protected_file',
      'An edited file is excluded from sharing. Remove protected-file edits from this submission.',
    ],
    [
      'Host is unavailable. Changes remain local until COORD reconnects.',
      'host_offline',
      'The host is offline. Keep edits in your isolated workspace and retry after COORD reconnects.',
    ],
    [
      'Project host is offline',
      'host_offline',
      'The host is offline. Keep edits in your isolated workspace and retry after COORD reconnects.',
    ],
    [
      'Peer disconnected',
      'host_offline',
      'The peer disconnected. Keep local edits and retry after COORD reconnects.',
    ],
    [
      'Protected workspace path',
      'protected_file',
      'This path is protected and cannot be shared. Choose a project source file.',
    ],
    [
      'Credential-like file content is protected',
      'protected_file',
      'The file contains credential-like content and cannot be shared. Remove secrets before submitting.',
    ],
    [
      'No active reservations to renew',
      'reservation_required',
      'Your reservations expired. Read current shared state and reserve your intended files again.',
    ],
    [
      'Duplicate, overlapping or case-colliding paths',
      'overlapping_paths',
      'The request contains overlapping or duplicate paths. Submit a unique set of non-overlapping paths.',
    ],
  ];
  for (const [prefix, code, reason] of reasons) {
    const matches = prefix.endsWith(' ')
      ? error.message.startsWith(prefix)
      : error.message === prefix;
    if (matches) return { rejected: true, code, reason };
  }
  return undefined;
}

/** Local authenticated IPC; only the controller can perform guarded project writes. */
export async function startLocalAgentBridge(options: {
  stateDirectory: string;
  getFolder: () => string | undefined;
  request: (
    operation: LocalAgentOperation,
    input: Record<string, unknown>,
    sessionId: string,
  ) => Promise<unknown>;
}) {
  if (process.platform === 'win32')
    throw new Error('Desktop agent integration currently requires macOS or Linux.');
  const stateRoot = await realpath(options.stateDirectory);
  const configDirectory = join(stateRoot, 'local-mcp');
  await mkdir(configDirectory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await assertOwned(configDirectory, 'directory');
  const configPath = join(configDirectory, 'bridge.json');
  try {
    await assertOwned(configPath, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // A short private path avoids the platform's ~104-byte Unix-socket path limit.
  const socketDirectory = await mkdtemp(join(await realpath('/tmp'), 'coord-agent-'));
  await chmod(socketDirectory, 0o700);
  const socketPath = join(socketDirectory, 'ipc.sock');
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    res.setHeader('Content-Type', 'application/json');
    const finish = (status: number, value: unknown) => {
      if (!res.destroyed && !res.writableEnded) res.writeHead(status).end(JSON.stringify(value));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      finish(401, { ok: false });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/coord') {
      finish(404, { ok: false });
      return;
    }
    if (active >= 8) {
      finish(429, { ok: false });
      return;
    }
    active++;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const part = Buffer.from(chunk);
        size += part.length;
        if (size > maxBytes) {
          finish(413, { ok: false });
          return;
        }
        chunks.push(part);
      }
      const envelope = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (options.getFolder() !== envelope.folder)
        throw new Error('This project is not selected in COORD.');
      const input = localAgentSchemas[envelope.operation].parse(envelope.input);
      const result = await Promise.race([
        options.request(envelope.operation, input, envelope.sessionId).catch((error: unknown) => {
          const rejection = domainRejection(error);
          if (rejection) return rejection;
          throw error;
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out')), deadlineMs);
        }),
      ]);
      const response = JSON.stringify({ ok: true, result });
      if (Buffer.byteLength(response) > maxBytes) {
        finish(413, { ok: false });
        return;
      }
      if (!res.destroyed && !res.writableEnded) res.writeHead(200).end(response);
    } catch {
      finish(400, { ok: false });
    } finally {
      clearTimeout(timeout);
      active--;
    }
  });
  server.maxConnections = 16;
  server.requestTimeout = deadlineMs;
  server.headersTimeout = deadlineMs;
  server.timeout = deadlineMs;
  try {
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(socketPath, () => {
        server.off('error', fail);
        ok();
      });
    });
    await chmod(socketPath, 0o600);
    const temporary = join(configDirectory, `.bridge-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, socketPath, token }), {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, configPath);
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    configPath,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      // Never delete a replacement bridge's credentials after an app restart.
      try {
        if (JSON.parse(await readFile(configPath, 'utf8')).token === token) await rm(configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally {
        await rm(socketDirectory, { recursive: true, force: true });
      }
    },
  };
}

export async function callLocalAgentBridge(
  configPath: string,
  input: LocalAgentRequest,
): Promise<unknown> {
  try {
    const envelope = requestSchema.parse(input);
    localAgentSchemas[envelope.operation].parse(envelope.input);
    const config = await readConfig(resolve(configPath));
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > maxBytes) throw new Error('Request too large');
    return await new Promise((ok, fail) => {
      const req = request(
        {
          socketPath: config.socketPath,
          path: '/coord',
          method: 'POST',
          agent: false,
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) req.destroy(new Error('Response too large'));
            else chunks.push(chunk);
          });
          res.on('error', fail);
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) throw new Error('Request failed');
              const result = z
                .object({ ok: z.literal(true), result: z.unknown() })
                .strict()
                .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              ok(result.result);
            } catch {
              fail(new Error('Invalid bridge response'));
            }
          });
        },
      );
      const timeout = setTimeout(
        () => req.destroy(new Error('Request timed out')),
        deadlineMs + 1000,
      );
      req.once('close', () => clearTimeout(timeout));
      req.once('error', fail);
      req.end(body);
    });
  } catch {
    throw new Error(
      'Open COORD desktop and select the connected local project. Check its connection status and retry.',
    );
  }
}

/** Install once per project; each MCP process gets its own automatic session identity. */
export async function installLocalAgents(options: {
  folder: string;
  bridgePath: string;
  command: string;
  args: string[];
}) {
  const results: { agent: string; installed: boolean; message: string }[] = [];
  for (const agent of ['codex', 'claude'] as const) {
    const spec = {
      command: options.command,
      args: [
        ...options.args,
        '--bridge',
        options.bridgePath,
        '--agent',
        agent,
        '--folder',
        options.folder,
      ],
    };
    try {
      if (agent === 'codex')
        await installCodexIntegration({
          ...spec,
          configPath: join(options.folder, '.codex', 'config.toml'),
        });
      else await installClaudeIntegration({ ...spec, repoRoot: options.folder });
      results.push({
        agent,
        installed: true,
        message:
          'Project integration installed. Restart existing agent sessions. Codex project trust and Claude MCP approval remain controlled by the coding tool.',
      });
    } catch (error) {
      results.push({
        agent,
        installed: false,
        message: error instanceof Error ? error.message : 'Integration could not be installed.',
      });
    }
  }
  return results;
}
