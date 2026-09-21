import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createCloudAuthority, type CloudOptions } from './cloud.js';
import { accountRoutes, AccountError } from './accounts.js';
import { createPeerSession, type PeerOptions } from '../desktop/peer-session.js';

type Project = { id: string; name: string; createdAt: number };
type Session = Awaited<ReturnType<typeof createPeerSession>>;
export type HubOptions = {
  dataDirectory: string;
  adminToken: string;
  portalToken?: string;
  port?: number;
  host?: string;
  cloud?: CloudOptions;
  network?: PeerOptions['network'];
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  createdAt: z.number().int().positive(),
});
async function jsonBody(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new HttpError(415, 'Use application/json');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const part of req) {
    const chunk = Buffer.from(part);
    bytes += chunk.length;
    if (bytes > 4096) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
function reply(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    })
    .end(JSON.stringify(value));
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Hub data directories must not be symlinks');
  await chmod(path, 0o700);
  return realpath(path);
}
async function acquireSingleton(root: string) {
  const path = join(root, 'singleton.sqlite');
  for (const candidate of [path, path + '-journal', path + '-wal', path + '-shm']) {
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe hub lock file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const lock = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch {
    lock.close();
    throw new Error('Another hub is already using this data directory');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.close();
  };
}
/** Private administration API. Public peer traffic uses authenticated encrypted DHT sessions. */
export async function createHub(options: HubOptions) {
  if (
    options.portalToken &&
    (!/^[a-f0-9]{64}$/i.test(options.portalToken) || options.portalToken === options.adminToken)
  )
    throw new Error('COORD_PORTAL_TOKEN must be a distinct random64hex token');
  if (!/^[a-f0-9]{64,256}$/i.test(options.adminToken) || options.adminToken.length % 2 !== 0)
    throw new Error(
      'COORD_HUB_ADMIN_TOKEN must be a random token of at least 32 bytes encoded as hexadecimal',
    );
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new Error('Invalid hub port');
  if (options.cloud && !options.portalToken)
    throw new Error('Cloud mode requires COORD_PORTAL_TOKEN');
  const cloud = options.cloud ? createCloudAuthority(options.cloud) : undefined;
  const root = await privateDirectory(options.dataDirectory);
  const releaseSingleton = await acquireSingleton(root);
  try {
    const projectsDirectory = await privateDirectory(join(root, 'projects'));
    const databasePath = join(root, 'registry.sqlite');
    for (const candidate of [
      databasePath,
      databasePath + '-wal',
      databasePath + '-shm',
      databasePath + '-journal',
    ]) {
      try {
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe hub registry');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const db = new DatabaseSync(databasePath);
    try {
      await chmod(databasePath, 0o600);
      db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS cloud_projects(id TEXT PRIMARY KEY) STRICT;',
      );
    } catch (error) {
      db.close();
      throw error;
    }
    const sessions = new Map<string, Session>();
    let closing = false,
      closed = false,
      active = 0;
    let mutations: Promise<unknown> = Promise.resolve();
    const expected = Buffer.from(`Bearer ${options.adminToken}`);
    function exclusive<T>(work: () => Promise<T>): Promise<T> {
      const next = mutations.then(() => {
        if (closing) throw new HttpError(503, 'Hub is stopping');
        return work();
      });
      mutations = next.catch(() => {});
      return next;
    }
    const projects = () =>
      db
        .prepare('SELECT id,name,created_at AS createdAt FROM projects ORDER BY created_at,id')
        .all()
        .map((row) => projectSchema.parse(row));
    const lookup = (id: string) => {
      const row = db
        .prepare('SELECT id,name,created_at AS createdAt FROM projects WHERE id=?')
        .get(id);
      if (!row) throw new HttpError(404, 'Project not found');
      return projectSchema.parse(row);
    };
    async function start(project: Project) {
      const existing = sessions.get(project.id);
      if (existing?.getState().status === 'hosting') return existing;
      await existing?.dispose();
      sessions.delete(project.id);
      const directory = await privateDirectory(join(projectsDirectory, project.id));
      const folder = await privateDirectory(join(directory, 'mirror'));
      const stateDirectory = await privateDirectory(join(directory, 'state'));
      const session = await createPeerSession({
        stateDirectory,
        network: options.network,
        autoApproveInvitations: true,
        watchFolder: false,
        authorizePeer: db.prepare('SELECT 1 FROM cloud_projects WHERE id=?').get(project.id)
          ? (peerId: string) => cloud?.authorized(project.id, peerId) ?? false
          : options.portalToken
            ? (peerId: string) => {
                try {
                  if (
                    !db
                      .prepare('SELECT 1 FROM account_members WHERE project_id=? LIMIT 1')
                      .get(project.id)
                  )
                    return true;
                  return Boolean(
                    db
                      .prepare(
                        `SELECT 1 FROM account_devices d
              JOIN account_sessions s ON s.hash=d.session_hash
              JOIN account_members m ON m.project_id=d.project_id AND m.user_id=d.user_id
              WHERE d.project_id=? AND d.peer_id=? AND s.user_id=d.user_id AND s.kind='device' AND s.expires>?`,
                      )
                      .get(project.id, peerId, Date.now()),
                  );
                } catch {
                  return false;
                }
              }
            : undefined,
      });
      try {
        if (session.getState().status === 'idle') await session.host(folder);
        if (session.getState().status !== 'hosting')
          throw new Error('Hub project peer service is unavailable');
        sessions.set(project.id, session);
        return session;
      } catch (error) {
        await session.dispose();
        throw error;
      }
    }
    try {
      for (const project of projects())
        await start(project).catch(() => {
          /* A failed project remains listed and retryable; never recreate its data. */
        });
    } catch (error) {
      db.close();
      throw error;
    }
    const accounts = cloud
      ? undefined
      : accountRoutes({
          db,
          portalToken: options.portalToken,
          body: jsonBody,
          exclusive,
          create: async (name) => {
            if (projects().length >= 20) throw new AccountError(409, 'Hub project limit reached');
            const project = { id: randomUUID(), name, createdAt: Date.now() };
            db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
              project.id,
              name,
              project.createdAt,
            );
            try {
              await start(project);
            } catch (error) {
              db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
              throw error;
            }
            return project;
          },
          detail: async (id) => {
            const project = lookup(id),
              state = sessions.get(id)?.getState();
            return {
              ...project,
              status: state?.status ?? 'offline',
              peers: state?.peers ?? [],
              files: state?.files ?? [],
              activity: state?.activity ?? [],
              conflicts: state?.conflicts ?? [],
            };
          },
          invite: async (id, peerId) => {
            const session = await start(lookup(id));
            await session.invite(peerId);
            const key = session.getState().key;
            if (!key) throw new AccountError(503, 'Invitation unavailable');
            return key;
          },
          revoke: async (id, peerId) => {
            await (await start(lookup(id))).revoke(peerId);
          },
        });
    const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
      void (async () => {
        if (req.headers.origin !== undefined)
          throw new HttpError(403, 'Browser requests are not allowed');
        if (req.url === '/healthz' && req.method === 'GET') {
          reply(res, 200, { ok: !closing });
          return;
        }
        if (req.url === '/cloud/connect' && req.method === 'POST') {
          const supplied = Buffer.from(
            typeof req.headers['x-coord-portal-token'] === 'string'
              ? req.headers['x-coord-portal-token']
              : '',
          );
          const expectedPortal = Buffer.from(options.portalToken ?? '');
          if (
            !cloud ||
            !options.portalToken ||
            supplied.length !== expectedPortal.length ||
            !timingSafeEqual(supplied, expectedPortal)
          )
            throw new HttpError(401, 'Unauthorized');
          if (closing || active >= 32) throw new HttpError(503, 'Hub unavailable');
          active++;
          try {
            const parsed = z
              .object({ projectId: z.string().uuid(), peerId: z.string().regex(/^[a-f0-9]{64}$/) })
              .strict()
              .safeParse(await jsonBody(req));
            if (!parsed.success) throw new HttpError(400, 'Invalid cloud project request');
            const { projectId, peerId } = parsed.data;
            const key = await exclusive(async () => {
              const remote = await cloud.project(projectId, peerId);
              if (!remote || !remote.allowed)
                throw new HttpError(403, 'Cloud project access denied');
              let project: Project;
              const existing = db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId);
              if (existing) {
                if (!db.prepare('SELECT 1 FROM cloud_projects WHERE id=?').get(projectId))
                  throw new HttpError(409, 'Project identity belongs to a local project');
                project = lookup(projectId);
              } else {
                if (projects().length >= 20) throw new HttpError(409, 'Hub project limit reached');
                project = { id: projectId, name: remote.name, createdAt: Date.now() };
                db.exec('BEGIN IMMEDIATE');
                try {
                  db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
                    project.id,
                    project.name,
                    project.createdAt,
                  );
                  db.prepare('INSERT INTO cloud_projects VALUES(?)').run(projectId);
                  db.exec('COMMIT');
                } catch (error) {
                  db.exec('ROLLBACK');
                  throw error;
                }
              }
              const session = await start(project);
              if (!(await cloud.authorized(projectId, peerId)))
                throw new HttpError(403, 'Cloud project access denied');
              await session.invite(peerId);
              const invitation = session.getState().key;
              if (!invitation) throw new HttpError(503, 'Invitation unavailable');
              return invitation;
            });
            reply(res, 200, { key });
          } finally {
            active--;
          }
          return;
        }
        if (req.url?.startsWith('/account/')) {
          if (!accounts) throw new HttpError(404, 'Accounts are managed by the cloud website');
          if (closing) throw new HttpError(503, 'Hub is stopping');
          reply(res, 200, await accounts(req));
          return;
        }
        const supplied = Buffer.from(req.headers.authorization ?? '');
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          throw new HttpError(401, 'Unauthorized');
        if (closing) throw new HttpError(503, 'Hub is stopping');
        if (active >= 32) throw new HttpError(429, 'Too many requests');
        active++;
        try {
          if (req.url === '/v1/projects' && req.method === 'GET') {
            reply(res, 200, {
              projects: projects().map((project) => ({
                ...project,
                status: sessions.get(project.id)?.getState().status ?? 'offline',
              })),
            });
            return;
          }
          if (req.url === '/v1/projects' && req.method === 'POST') {
            const body = z
              .object({
                name: z
                  .string()
                  .trim()
                  .min(1)
                  .max(100)
                  .regex(/^[^\x00-\x1f\x7f]+$/),
              })
              .strict()
              .safeParse(await jsonBody(req));
            if (!body.success) throw new HttpError(400, 'Invalid project name');
            const project = await exclusive(async () => {
              if (projects().length >= 20) throw new HttpError(409, 'Hub project limit reached');
              const created = { id: randomUUID(), name: body.data.name, createdAt: Date.now() };
              db.prepare('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(
                created.id,
                created.name,
                created.createdAt,
              );
              await start(created);
              return created;
            });
            reply(res, 201, project);
            return;
          }
          const match =
            /^\/v1\/projects\/([a-f0-9-]{36})(?:\/(invitations|peers)(?:\/([a-f0-9]{64}))?)?$/.exec(
              req.url ?? '',
            );
          if (!match || !z.string().uuid().safeParse(match[1]).success)
            throw new HttpError(404, 'Not found');
          const project = lookup(match[1]!);
          const action = match[2],
            peerId = match[3];
          if (!action && req.method === 'GET') {
            const state = sessions.get(project.id)?.getState();
            reply(res, 200, {
              ...project,
              status: state?.status ?? 'offline',
              peers: state?.peers ?? [],
              pending: state?.pending ?? [],
              files: state?.files ?? [],
              activity: state?.activity ?? [],
              conflicts: state?.conflicts ?? [],
            });
            return;
          }
          if (action === 'invitations' && !peerId && req.method === 'POST') {
            const key = await exclusive(async () => {
              const session = await start(project);
              await session.invite();
              return session.getState().key;
            });
            if (!key) throw new HttpError(503, 'Invitation unavailable');
            reply(res, 201, { key });
            return;
          }
          if (action === 'peers' && peerId && req.method === 'DELETE') {
            await exclusive(async () => {
              const session = await start(project);
              await session.revoke(peerId);
            });
            reply(res, 200, { ok: true });
            return;
          }
          throw new HttpError(404, 'Not found');
        } finally {
          active--;
        }
      })().catch((error) =>
        reply(
          res,
          error instanceof HttpError || error instanceof AccountError ? error.status : 503,
          {
            error:
              error instanceof HttpError || error instanceof AccountError
                ? error.message
                : 'Hub operation unavailable',
          },
        ),
      );
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.setTimeout(35000, (socket) => socket.destroy());
    server.maxConnections = 64;
    try {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
          server.off('error', fail);
          ok();
        });
      });
    } catch (error) {
      await Promise.allSettled([...sessions.values()].map((s) => s.dispose()));
      db.close();
      throw error;
    }
    const port = (server.address() as AddressInfo).port,
      host = options.host ?? '127.0.0.1';
    return {
      port,
      address: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
      async close() {
        if (closed) return;
        closed = true;
        closing = true;
        server.closeAllConnections();
        await new Promise<void>((ok) => server.close(() => ok()));
        await mutations;
        await Promise.allSettled([...sessions.values()].map((session) => session.dispose()));
        sessions.clear();
        try {
          db.close();
        } finally {
          releaseSingleton();
        }
      },
    };
  } catch (error) {
    releaseSingleton();
    throw error;
  }
}
