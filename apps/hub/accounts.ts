import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
const derive = promisify(scrypt);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const credentials = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{3,32}$/),
    password: z.string().min(12).max(128),
  })
  .strict();
const projectName = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\x00-\x1f\x7f]+$/),
  })
  .strict();
export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type User = { id: string; username: string };
type Login = { user_id: string; kind: 'browser' | 'device'; hash: string; name: string };
type Project = { id: string; name: string; createdAt: number };
export function accountRoutes(options: {
  db: DatabaseSync;
  portalToken?: string;
  body: (r: IncomingMessage) => Promise<unknown>;
  exclusive: <T>(f: () => Promise<T>) => Promise<T>;
  create: (name: string) => Promise<Project>;
  detail: (id: string) => Promise<Record<string, unknown>>;
  invite: (id: string, peerId: string) => Promise<string>;
  revoke: (id: string, peerId: string) => Promise<void>;
}) {
  const { db } = options;
  if (options.portalToken && !/^[a-f0-9]{64}$/i.test(options.portalToken))
    throw new Error('COORD_PORTAL_TOKEN must be 64 hex characters');
  db.exec(`
 CREATE TABLE IF NOT EXISTS account_users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,salt TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS account_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS account_members(project_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(project_id,user_id)) STRICT;
 CREATE TABLE IF NOT EXISTS account_invites(hash TEXT PRIMARY KEY,project_id TEXT NOT NULL,expires INTEGER NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS account_pairs(hash TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL,user_id TEXT) STRICT;
 CREATE TABLE IF NOT EXISTS account_devices(project_id TEXT NOT NULL,peer_id TEXT NOT NULL,user_id TEXT NOT NULL,session_hash TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(project_id,peer_id)) STRICT;
 `);
  const rates = new Map<string, { n: number; until: number }>();
  let active = 0;
  function limit(key: string, max: number) {
    const now = Date.now();
    for (const [k, v] of rates) if (v.until <= now) rates.delete(k);
    const item = rates.get(key) ?? { n: 0, until: now + 60000 };
    if (item.n >= max || (!rates.has(key) && rates.size >= 2000))
      throw new AccountError(429, 'Too many requests. Try again later.');
    item.n++;
    rates.set(key, item);
  }
  const user = (id: string) =>
    db.prepare('SELECT id,username FROM account_users WHERE id=?').get(id) as User;
  function member(project: string, id: string, owner = false) {
    const row = db
      .prepare('SELECT role FROM account_members WHERE project_id=? AND user_id=?')
      .get(project, id);
    if (!row || (owner && row.role !== 'owner'))
      throw new AccountError(403, 'Project access denied');
    return String(row.role);
  }
  function token(id: string, kind: 'browser' | 'device', name = '') {
    const value = secret();
    db.prepare('DELETE FROM account_sessions WHERE expires<=?').run(Date.now());
    if (
      Number(db.prepare('SELECT count(*) AS n FROM account_sessions WHERE user_id=?').get(id)!.n) >=
      30
    )
      throw new AccountError(409, 'Session limit reached');
    db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?)').run(
      hash(value),
      id,
      kind,
      name,
      Date.now() + (kind === 'browser' ? 7 : 30) * 86400000,
    );
    return { token: value, user: user(id) };
  }
  function authenticate(req: IncomingMessage) {
    const authorization = req.headers.authorization;
    const value = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new AccountError(401, 'Sign in required');
    const row = db
      .prepare('SELECT * FROM account_sessions WHERE hash=? AND expires>?')
      .get(hash(value), Date.now()) as Login | undefined;
    if (!row) throw new AccountError(401, 'Session expired');
    return row;
  }
  function browser(login: Login) {
    if (login.kind !== 'browser') throw new AccountError(403, 'Use the website for this action');
  }
  async function parsed<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
    const value = schema.safeParse(await options.body(req));
    if (!value.success) throw new AccountError(400, 'Invalid request');
    return value.data;
  }
  return async (req: IncomingMessage): Promise<unknown> => {
    const expected = Buffer.from(options.portalToken ?? '');
    const supplied = Buffer.from(String(req.headers['x-coord-portal-token'] ?? ''));
    if (
      !expected.length ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new AccountError(401, 'Unauthorized gateway');
    if (active >= 8) throw new AccountError(429, 'Too many requests');
    active++;
    try {
      limit('global', 300);
      const path = req.url ?? '',
        method = req.method;
      db.prepare('DELETE FROM account_pairs WHERE expires<=?').run(Date.now());
      db.prepare('DELETE FROM account_invites WHERE expires<=?').run(Date.now());
      if ((path === '/account/register' || path === '/account/login') && method === 'POST') {
        limit('auth', 40);
        const input = await parsed(req, credentials);
        limit('auth:' + input.username, 8);
        if (path.endsWith('register')) {
          if (Number(db.prepare('SELECT count(*) AS n FROM account_users').get()!.n) >= 500)
            throw new AccountError(409, 'Early access account limit reached');
          const salt = secret(),
            password = Buffer.from((await derive(input.password, salt, 64)) as Buffer).toString(
              'hex',
            );
          const id = randomUUID();
          try {
            db.prepare('INSERT INTO account_users VALUES(?,?,?,?)').run(
              id,
              input.username,
              password,
              salt,
            );
          } catch {
            throw new AccountError(409, 'Username unavailable');
          }
          return token(id, 'browser');
        }
        const found = db
          .prepare('SELECT * FROM account_users WHERE username=?')
          .get(input.username);
        const salt = found ? String(found.salt) : '0'.repeat(64);
        const actual = Buffer.from((await derive(input.password, salt, 64)) as Buffer);
        const expectedPassword = Buffer.from(
          found ? String(found.password) : '0'.repeat(128),
          'hex',
        );
        if (!found || !timingSafeEqual(actual, expectedPassword))
          throw new AccountError(401, 'Invalid username or password');
        return token(String(found.id), 'browser');
      }
      if (path === '/account/device/start' && method === 'POST') {
        limit('pair-start', 30);
        const input = await parsed(
          req,
          z.object({ name: z.string().trim().min(1).max(80) }).strict(),
        );
        if (Number(db.prepare('SELECT count(*) AS n FROM account_pairs').get()!.n) >= 200)
          throw new AccountError(429, 'Pairing is busy');
        const deviceCode = secret(),
          userCode = randomBytes(5).toString('hex').toUpperCase(),
          expiresAt = Date.now() + 600000;
        db.prepare('INSERT INTO account_pairs VALUES(?,?,?,?,NULL)').run(
          hash(deviceCode),
          userCode,
          input.name,
          expiresAt,
        );
        return { deviceCode, userCode, expiresAt };
      }
      if (path === '/account/device/poll' && method === 'POST') {
        const { deviceCode } = await parsed(
          req,
          z.object({ deviceCode: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        );
        limit('poll:' + hash(deviceCode), 30);
        const pair = db.prepare('SELECT * FROM account_pairs WHERE hash=?').get(hash(deviceCode));
        if (!pair) throw new AccountError(409, 'Pairing expired or already consumed');
        if (!pair.user_id) return { status: 'pending' };
        const result = token(String(pair.user_id), 'device', String(pair.name));
        db.prepare('DELETE FROM account_pairs WHERE hash=?').run(hash(deviceCode));
        return { status: 'approved', ...result };
      }
      const login = authenticate(req);
      const authenticatedExclusive = <T>(work: () => Promise<T>) =>
        options.exclusive(async () => {
          authenticate(req);
          return work();
        });
      limit('user:' + login.user_id, 120);
      if (path === '/account/device/approve' && method === 'POST') {
        browser(login);
        const { userCode } = await parsed(
          req,
          z
            .object({
              userCode: z
                .string()
                .toUpperCase()
                .regex(/^[A-F0-9]{10}$/),
            })
            .strict(),
        );
        authenticate(req);
        limit('approve:' + login.user_id, 10);
        const result = db
          .prepare(
            'UPDATE account_pairs SET user_id=? WHERE code=? AND user_id IS NULL AND expires>?',
          )
          .run(login.user_id, userCode, Date.now());
        if (!result.changes) throw new AccountError(409, 'Pairing code unavailable');
        return { ok: true };
      }
      if (path === '/account/logout' && method === 'POST') {
        await authenticatedExclusive(async () => {
          // Revoke authorization durably before any network await. The peer gate also
          // rejects this session immediately if a project's service is unavailable.
          db.prepare('DELETE FROM account_sessions WHERE hash=?').run(login.hash);
          if (login.kind === 'device') {
            const devices = db
              .prepare('SELECT project_id,peer_id FROM account_devices WHERE session_hash=?')
              .all(login.hash);
            await Promise.allSettled(
              devices.map((d) => options.revoke(String(d.project_id), String(d.peer_id))),
            );
            db.prepare('DELETE FROM account_devices WHERE session_hash=?').run(login.hash);
          }
        });
        return { ok: true };
      }
      if (path === '/account/workspace' && method === 'GET')
        return {
          user: user(login.user_id),
          projects: db
            .prepare(
              'SELECT p.id,p.name,m.role FROM projects p JOIN account_members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.created_at',
            )
            .all(login.user_id),
        };
      if (path === '/account/projects' && method === 'POST') {
        browser(login);
        const input = await parsed(req, projectName);
        return authenticatedExclusive(async () => {
          if (
            Number(
              db
                .prepare(
                  "SELECT count(*) AS n FROM account_members WHERE user_id=? AND role='owner'",
                )
                .get(login.user_id)!.n,
            ) >= 5
          )
            throw new AccountError(409, 'Project limit reached');
          const project = await options.create(input.name);
          db.prepare('INSERT INTO account_members VALUES(?,?,?)').run(
            project.id,
            login.user_id,
            'owner',
          );
          return { ...project, role: 'owner' };
        });
      }
      if (path === '/account/invitations/accept' && method === 'POST') {
        browser(login);
        const { key } = await parsed(
          req,
          z.object({ key: z.string().regex(/^coord-member\.[a-f0-9]{64}$/) }).strict(),
        );
        return authenticatedExclusive(async () => {
          const invite = db
            .prepare('SELECT project_id FROM account_invites WHERE hash=? AND expires>?')
            .get(hash(key), Date.now());
          if (!invite) throw new AccountError(409, 'Invitation expired or used');
          const project = String(invite.project_id);
          if (
            Number(
              db
                .prepare('SELECT count(*) AS n FROM account_members WHERE project_id=?')
                .get(project)!.n,
            ) >= 30
          )
            throw new AccountError(409, 'Member limit reached');
          db.prepare('INSERT OR IGNORE INTO account_members VALUES(?,?,?)').run(
            project,
            login.user_id,
            'member',
          );
          db.prepare('DELETE FROM account_invites WHERE hash=?').run(hash(key));
          return { ok: true, projectId: project };
        });
      }
      const match =
        /^\/account\/projects\/([a-f0-9-]{36})(?:\/(invitations|connect|members|devices)(?:\/([a-f0-9-]{36}|[a-f0-9]{64}))?)?$/.exec(
          path,
        );
      if (!match) throw new AccountError(404, 'Not found');
      const project = match[1]!,
        action = match[2],
        target = match[3];
      const role = member(project, login.user_id);
      if (!action && method === 'GET')
        return {
          ...(await options.detail(project)),
          role,
          members: db
            .prepare(
              'SELECT u.id,u.username,m.role FROM account_members m JOIN account_users u ON u.id=m.user_id WHERE m.project_id=?',
            )
            .all(project),
          devices: db
            .prepare(
              'SELECT peer_id AS id,user_id AS userId,name FROM account_devices WHERE project_id=?',
            )
            .all(project),
        };
      if (action === 'invitations' && method === 'POST' && !target) {
        browser(login);
        member(project, login.user_id, true);
        if (
          Number(
            db.prepare('SELECT count(*) AS n FROM account_invites WHERE project_id=?').get(project)!
              .n,
          ) >= 30
        )
          throw new AccountError(409, 'Invitation limit reached');
        const key = 'coord-member.' + secret();
        db.prepare('INSERT INTO account_invites VALUES(?,?,?)').run(
          hash(key),
          project,
          Date.now() + 86400000,
        );
        return { key };
      }
      if (action === 'members' && target && method === 'DELETE') {
        browser(login);
        member(project, login.user_id, true);
        if (target === login.user_id) throw new AccountError(409, 'Owner cannot remove themselves');
        return authenticatedExclusive(async () => {
          member(project, login.user_id, true);
          for (const d of db
            .prepare('SELECT peer_id FROM account_devices WHERE project_id=? AND user_id=?')
            .all(project, target))
            await options.revoke(project, String(d.peer_id));
          db.prepare('DELETE FROM account_devices WHERE project_id=? AND user_id=?').run(
            project,
            target,
          );
          db.prepare('DELETE FROM account_invites WHERE project_id=?').run(project);
          db.prepare('DELETE FROM account_members WHERE project_id=? AND user_id=?').run(
            project,
            target,
          );
          return { ok: true };
        });
      }
      if (action === 'devices' && target && method === 'DELETE') {
        browser(login);
        if (!/^[a-f0-9]{64}$/.test(target)) throw new AccountError(400, 'Invalid device');
        return authenticatedExclusive(async () => {
          const currentRole = member(project, login.user_id);
          const device = db
            .prepare(
              'SELECT user_id,session_hash FROM account_devices WHERE project_id=? AND peer_id=?',
            )
            .get(project, target);
          if (!device) throw new AccountError(404, 'Device not found');
          if (currentRole !== 'owner' && device.user_id !== login.user_id)
            throw new AccountError(403, 'Device access denied');
          // A desktop session can connect to multiple projects. Revoke the whole
          // session so its old bearer cannot immediately recreate any device binding.
          const sessionHash = String(device.session_hash);
          db.prepare('DELETE FROM account_sessions WHERE hash=?').run(sessionHash);
          const devices = db
            .prepare('SELECT project_id,peer_id FROM account_devices WHERE session_hash=?')
            .all(sessionHash);
          await Promise.allSettled(
            devices.map((d) => options.revoke(String(d.project_id), String(d.peer_id))),
          );
          db.prepare('DELETE FROM account_devices WHERE session_hash=?').run(sessionHash);
          return { ok: true };
        });
      }
      if (action === 'connect' && method === 'POST' && !target) {
        if (login.kind !== 'device')
          throw new AccountError(403, 'Connect from the paired desktop app');
        const { peerId } = await parsed(
          req,
          z.object({ peerId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        );
        return authenticatedExclusive(async () => {
          member(project, login.user_id);
          const existing = db
            .prepare('SELECT user_id FROM account_devices WHERE project_id=? AND peer_id=?')
            .get(project, peerId);
          if (existing && existing.user_id !== login.user_id)
            throw new AccountError(409, 'Device belongs to another member');
          if (
            !existing &&
            Number(
              db
                .prepare('SELECT count(*) AS n FROM account_devices WHERE user_id=?')
                .get(login.user_id)!.n,
            ) >= 20
          )
            throw new AccountError(409, 'Device limit reached');
          const key = await options.invite(project, peerId);
          db.prepare('INSERT OR REPLACE INTO account_devices VALUES(?,?,?,?,?)').run(
            project,
            peerId,
            login.user_id,
            login.hash,
            login.name || user(login.user_id).username,
          );
          return { key };
        });
      }
      throw new AccountError(404, 'Not found');
    } finally {
      active--;
    }
  };
}
