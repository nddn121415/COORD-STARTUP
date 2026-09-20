import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { containsSecret, validateRelativePath } from '../packages/protocol/src/paths.js';

// Run the actual portal handler and SQL against SQLite. Only Sites identity and R2 are injected;
// this deliberately does not claim to verify the hosted Sites authentication ingress.
let database: DatabaseSync | undefined;
let principal: { userId: string; email: string; displayName: string } | null;
let handle: (req: Request) => Promise<Response>;
let objects: Map<string, Uint8Array>;
const alice = { userId: 'alice', email: 'alice@example.test', displayName: 'Alice' };
const bob = { userId: 'bob', email: 'bob@example.test', displayName: 'Bob' };
const carol = { userId: 'carol', email: 'carol@example.test', displayName: 'Carol' };
const site = 'https://coord.example.test';

function encryptionKey() {
  return generateKeyPairSync('x25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
}
function envelope() {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const encrypted = Buffer.concat([cipher.update('encrypted test metadata'), cipher.final()]);
  return {
    version: 1,
    ephemeralKey: encryptionKey(),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

beforeEach(async () => {
  database?.close();
  database = new DatabaseSync(':memory:');
  objects = new Map();
  principal = alice;
  database.exec(
    await readFile(
      new URL('../apps/portal/drizzle/0000_stormy_vanisher.sql', import.meta.url),
      'utf8',
    ),
  );
  function prepare(sql: string) {
    let bindings: (string | number | null)[] = [];
    const stmt = {
      bind(...args: (string | number | null)[]) {
        bindings = args;
        return stmt;
      },
      first() {
        return database!.prepare(sql).get(...bindings) ?? null;
      },
      all() {
        return { results: database!.prepare(sql).all(...bindings) };
      },
      run() {
        return { meta: { changes: Number(database!.prepare(sql).run(...bindings).changes) } };
      },
    };
    return stmt;
  }
  const env = {
    DB: {
      prepare,
      batch(statements: ReturnType<typeof prepare>[]) {
        database!.exec('BEGIN');
        try {
          const results = statements.map((s) => s.run());
          database!.exec('COMMIT');
          return results;
        } catch (error) {
          database!.exec('ROLLBACK');
          throw error;
        }
      },
    },
    FILES: {
      async put(key: string, data: Uint8Array) {
        objects.set(key, new Uint8Array(data));
      },
      async get(key: string) {
        const data = objects.get(key);
        return data ? { body: data, size: data.length } : null;
      },
      async delete(key: string) {
        objects.delete(key);
      },
    },
  };
  const source = (await readFile(new URL('../apps/portal/lib/api.ts', import.meta.url), 'utf8'))
    .replace(
      /^import\s.+?from\s+['"](?:cloudflare:workers|\.\.\/app\/chatgpt-auth|\.\/paths)['"];?\s*$/gm,
      '',
    )
    .replace('export async function handle', 'async function handle');
  const javascript = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
  }).outputText;
  handle = new Function(
    'env',
    'getChatGPTUser',
    'containsSecret',
    'validateRelativePath',
    `${javascript}\nreturn handle;`,
  )(env, async () => principal, containsSecret, validateRelativePath);
});
afterEach(() => {
  database?.close();
  database = undefined;
});
async function api(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    bearer?: string;
    origin?: string | null;
    bytes?: Uint8Array;
  } = {},
) {
  const method = options.method ?? (options.body || options.bytes ? 'POST' : 'GET');
  const headers = new Headers();
  if (options.bearer) headers.set('Authorization', `Bearer ${options.bearer}`);
  if (options.origin !== null) headers.set('Origin', options.origin ?? site);
  let body: BodyInit | undefined;
  if (options.bytes) body = options.bytes as BodyInit;
  else if (options.body) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  return handle(new Request(`${site}/api/${path}`, { method, headers, body }));
}
async function pair(user = alice) {
  principal = user;
  const start = await api('device/start', {
    body: { name: `${user.displayName} laptop`, encryptionKey: encryptionKey() },
  });
  expect(start.status).toBe(200);
  const result = await start.json();
  expect((await api('device/approve', { body: { userCode: result.userCode } })).status).toBe(200);
  const approved = await (
    await api('device/poll', { body: { deviceCode: result.deviceCode } })
  ).json();
  return { token: result.deviceCode as string, id: approved.deviceId as string };
}
async function team() {
  principal = alice;
  const projectId = (await (await api('projects', { body: { name: 'Shared project' } })).json()).id;
  const a = await pair(alice);
  const b = await pair(bob);
  principal = alice;
  expect((await api('invitations', { body: { projectId, email: bob.email } })).status).toBe(200);
  principal = bob;
  const workspace = await (await api('workspace')).json();
  expect(
    (await api('invitations/accept', { body: { id: workspace.invitations[0].id } })).status,
  ).toBe(200);
  return { projectId, a, b };
}

describe('portal authorization against actual handler and SQLite', () => {
  it('requires authenticated browser approval and exact Origin before a pairing secret becomes usable', async () => {
    const start = await (
      await api('device/start', { body: { name: 'Laptop', encryptionKey: encryptionKey() } })
    ).json();
    expect((await api('desktop/state', { bearer: start.deviceCode })).status).toBe(401);
    principal = null;
    expect((await api('device/approve', { body: { userCode: start.userCode } })).status).toBe(401);
    principal = alice;
    expect(
      (
        await api('device/approve', {
          body: { userCode: start.userCode },
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await api('device/approve', { body: { userCode: start.userCode }, origin: null })).status,
    ).toBe(403);
    expect((await api('device/approve', { body: { userCode: start.userCode } })).status).toBe(200);
    expect((await api('device/approve', { body: { userCode: start.userCode } })).status).toBe(409);
    expect((await api('desktop/state', { bearer: start.deviceCode })).status).toBe(200);
    const row = database!.prepare('SELECT * FROM devices').get()!;
    expect(row.token_hash).not.toBe(start.deviceCode);
    expect(JSON.stringify(row)).not.toContain(start.deviceCode);
    database!.prepare('UPDATE devices SET revoked=1').run();
    expect((await api('desktop/state', { bearer: start.deviceCode })).status).toBe(401);
  });

  it('isolates project membership and lease claims across separate users/devices', async () => {
    const { projectId, a, b } = await team();
    const c = await pair(carol);
    expect((await api(`desktop/context?projectId=${projectId}`, { bearer: c.token })).status).toBe(
      403,
    );
    principal = bob;
    expect((await api('invitations', { body: { projectId, email: carol.email } })).status).toBe(
      403,
    );
    const created = await (
      await api('desktop/tasks', {
        bearer: a.token,
        body: { projectId, action: 'create', title: 'Task' },
      })
    ).json();
    expect(
      (
        await api('desktop/tasks', {
          bearer: a.token,
          body: { projectId, action: 'claim', taskId: created.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api('desktop/tasks', {
          bearer: b.token,
          body: { projectId, action: 'claim', taskId: created.id },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api('desktop/tasks', {
          bearer: b.token,
          body: { projectId, action: 'complete', taskId: created.id },
        })
      ).status,
    ).toBe(409);
    database!.prepare('UPDATE tasks SET lease_until=0').run();
    expect(
      (
        await api('desktop/tasks', {
          bearer: b.token,
          body: { projectId, action: 'claim', taskId: created.id },
        })
      ).status,
    ).toBe(200);
  });

  it('rejects sensitive/traversal paths in direct bearer API calls, independently of MCP validation', async () => {
    const { projectId, a } = await team();
    for (const path of [
      '.env',
      '.ssh/id_rsa',
      'src/secrets.json',
      'C:/outside',
      'x%2fy',
      'x//y',
      '../escape',
      'src/a\u007f',
    ]) {
      expect(
        (
          await api('desktop/intent', {
            bearer: a.token,
            body: { projectId, summary: 'Unsafe path', paths: [path] },
          })
        ).status,
        path,
      ).toBe(400);
    }
    expect(
      (
        await api('desktop/intent', {
          bearer: a.token,
          body: { projectId, summary: 'Normal file', paths: ['src/user.ts'] },
        })
      ).status,
    ).toBe(200);
  });

  it('limits ciphertext transfer reads to the intended authorized recipient, enforces readiness/expiry and deletes acknowledged bytes', async () => {
    const { projectId, a, b } = await team();
    const c = await pair(carol);
    const created = await api('desktop/transfers', {
      bearer: a.token,
      body: {
        projectId,
        recipientDeviceId: b.id,
        expiresAt: Date.now() + 60000,
        envelope: envelope(),
      },
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(
      (await api(`desktop/transfers/${id}/ack`, { method: 'POST', bearer: b.token })).status,
    ).toBe(409);
    expect(
      (
        await api(`desktop/transfers/${id}/blob`, {
          method: 'PUT',
          bearer: b.token,
          bytes: new Uint8Array(32),
        })
      ).status,
    ).toBe(403);
    const ciphertext = new Uint8Array(32).fill(37);
    expect(
      (
        await api(`desktop/transfers/${id}/blob`, {
          method: 'PUT',
          bearer: a.token,
          bytes: ciphertext,
        })
      ).status,
    ).toBe(200);
    expect((await api(`desktop/transfers/${id}/blob`, { bearer: a.token })).status).toBe(403);
    expect((await api(`desktop/transfers/${id}/blob`, { bearer: c.token })).status).toBe(403);
    expect(
      new Uint8Array(
        await (await api(`desktop/transfers/${id}/blob`, { bearer: b.token })).arrayBuffer(),
      ),
    ).toEqual(ciphertext);
    database!
      .prepare('DELETE FROM members WHERE project_id=? AND user_id=?')
      .run(projectId, bob.userId);
    expect((await api(`desktop/transfers/${id}/blob`, { bearer: b.token })).status).toBe(403);
    database!
      .prepare('INSERT INTO members(project_id,user_id) VALUES(?,?)')
      .run(projectId, bob.userId);
    expect(
      (await api(`desktop/transfers/${id}/ack`, { method: 'POST', bearer: b.token })).status,
    ).toBe(200);
    expect(objects.has(id)).toBe(false);
    expect((await api(`desktop/transfers/${id}/blob`, { bearer: b.token })).status).toBe(404);
  });

  it('keeps pending transfers invisible and cleans expired ciphertext on authenticated polling', async () => {
    const { projectId, a, b } = await team();
    const { id } = await (
      await api('desktop/transfers', {
        bearer: a.token,
        body: {
          projectId,
          recipientDeviceId: b.id,
          expiresAt: Date.now() + 60000,
          envelope: envelope(),
        },
      })
    ).json();
    expect((await (await api('desktop/state', { bearer: b.token })).json()).transfers).toEqual([]);
    expect(
      (
        await api(`desktop/transfers/${id}/blob`, {
          method: 'PUT',
          bearer: a.token,
          bytes: new Uint8Array(32),
        })
      ).status,
    ).toBe(200);
    expect((await (await api('desktop/state', { bearer: b.token })).json()).transfers).toHaveLength(
      1,
    );
    database!.prepare('UPDATE transfers SET expires_at=? WHERE id=?').run(Date.now() - 1, id);
    expect((await api(`desktop/transfers/${id}/blob`, { bearer: b.token })).status).toBe(404);
    expect((await api('desktop/state', { bearer: b.token })).status).toBe(200);
    expect(objects.has(id)).toBe(false);
  });

  it('bounds UTF-8 context bytes and reports overlaps between online devices', async () => {
    const { projectId, a, b } = await team();
    for (const bearer of [a.token, b.token]) {
      expect((await api('desktop/heartbeat', { bearer, body: { projectId } })).status).toBe(200);
      expect(
        (
          await api('desktop/intent', {
            bearer,
            body: { projectId, summary: 'Editing', paths: ['src/user.ts'] },
          })
        ).status,
      ).toBe(200);
    }
    const first = await (
      await api(`desktop/context?projectId=${projectId}`, { bearer: a.token })
    ).json();
    expect(first.agents).toHaveLength(2);
    expect(first.conflicts[0].paths).toContain('src/user.ts');
    for (let i = 0; i < 50; i++)
      expect(
        (
          await api('desktop/messages', {
            bearer: a.token,
            body: { projectId, text: '界'.repeat(2000) },
          })
        ).status,
      ).toBe(200);
    const result = await (
      await api(`desktop/context?projectId=${projectId}`, { bearer: a.token })
    ).json();
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(180000);
    expect(result.truncated).toBe(true);
  });

  it('refuses plaintext or malformed encrypted envelopes before creating mailbox records', async () => {
    const { projectId, a, b } = await team();
    for (const invalid of [
      { plaintext: 'source contents' },
      { ...envelope(), tag: 'bad' },
      { ...envelope(), unexpected: 'raw source' },
      { ...envelope(), ephemeralKey: 'YWJjZA==' },
      { ...envelope(), iv: 'invalid' },
    ]) {
      const response = await api('desktop/transfers', {
        bearer: a.token,
        body: {
          projectId,
          recipientDeviceId: b.id,
          expiresAt: Date.now() + 60000,
          envelope: invalid,
        },
      });
      expect(response.status).toBe(400);
    }
    expect(Number(database!.prepare('SELECT count(*) AS n FROM transfers').get()!.n)).toBe(0);
  });
});
