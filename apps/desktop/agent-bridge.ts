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
export const agentSchemas = {
  coord_get_context: z.object({}).strict(),
  coord_create_task: z.object({ title: safeText(200, 1) }).strict(),
  coord_claim_task: z.object({ taskId: z.string().uuid() }).strict(),
  coord_announce_intent: z
    .object({
      summary: safeText(500, 1),
      paths: z
        .array(relativePathSchema.refine((path) => path.length <= 300, 'Path is too long'))
        .max(50),
    })
    .strict(),
  coord_send_message: z.object({ text: safeText(2000, 1) }).strict(),
};
export type AgentOperation = keyof typeof agentSchemas;
const operationNames = Object.keys(agentSchemas) as [AgentOperation, ...AgentOperation[]];
const requestSchema = z
  .object({
    projectId: z.string().uuid(),
    agent: z.enum(['codex', 'claude']),
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
export type AgentRequest = z.infer<typeof requestSchema>;

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

/** Local, authenticated, metadata-only IPC. It has no shell, filesystem or arbitrary HTTP operation. */
export async function startAgentBridge(options: {
  stateDirectory: string;
  coordinate: (
    projectId: string,
    operation: AgentOperation,
    input: Record<string, unknown>,
    agent: 'codex' | 'claude',
  ) => Promise<unknown>;
}) {
  if (process.platform === 'win32')
    throw new Error('Desktop agent integration currently requires macOS or Linux.');
  const stateRoot = await realpath(options.stateDirectory);
  const configDirectory = join(stateRoot, 'mcp');
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
      const input = agentSchemas[envelope.operation].parse(envelope.input);
      const result = await Promise.race([
        options.coordinate(envelope.projectId, envelope.operation, input, envelope.agent),
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

export async function callAgentBridge(configPath: string, input: AgentRequest): Promise<unknown> {
  try {
    const envelope = requestSchema.parse(input);
    agentSchemas[envelope.operation].parse(envelope.input);
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
      'Open COORD desktop, sign in, and select the connected project. Check its connection status and retry.',
    );
  }
}
