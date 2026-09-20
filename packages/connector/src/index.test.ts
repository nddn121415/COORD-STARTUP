import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Connector, writePrivateJson } from './index.js';
import { git } from '@coord/git-intel';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(condition: () => boolean) {
  const end = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'coord-connector-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await git(directory, ['init', '-b', 'main']);
  await writeFile(join(directory, 'local.ts'), 'LOCAL CONTENT NEVER UPLOADED');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  const projectId = randomUUID(),
    requests: { operation: string; input: Record<string, unknown> }[] = [],
    hellos: { session_id: string; after_seq: number }[] = [];
  server.on('connection', (socket) =>
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'hello') {
        hellos.push(frame);
        socket.send(
          JSON.stringify({
            type: 'welcome',
            session_id: frame.session_id,
            project_id: projectId,
            latest_seq: 0,
          }),
        );
      } else {
        requests.push(frame);
        let result: unknown = { accepted: true };
        if (frame.operation === 'coord_claim_task')
          result = {
            claim_id: randomUUID(),
            task: { id: frame.input.task_id },
            lease_expires_at: new Date(Date.now() + 5000).toISOString(),
          };
        socket.send(
          JSON.stringify({ type: 'response', request_id: frame.request_id, ok: true, result }),
        );
      }
    }),
  );
  const options = {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: 'device-token',
    projectId,
    repositoryId: 'explicit-repo',
    repoRoot: directory,
    stateDir: join(directory, 'private-state'),
    agent: 'codex' as const,
    heartbeatMs: 50,
    renewMs: 50,
    reconcileMs: 60000,
  };
  const client = new Connector(options);
  cleanup.push(() => client.stop(false));
  await client.start();
  return { client, options, directory, requests, hellos, server };
}
describe('connector lifecycle and privacy', () => {
  it('sends metadata only and keeps credentials/cursor files private', async () => {
    const f = await fixture();
    const observation = f.requests.find((r) => r.operation === 'coord_observe_git');
    expect(observation).toBeDefined();
    expect(JSON.stringify(observation)).not.toContain('LOCAL CONTENT');
    expect(JSON.stringify(observation)).not.toContain(f.directory);
    const privateFile = join(f.directory, 'credentials', 'test.json');
    await writePrivateJson(privateFile, { token: 'never-log' });
    expect((await stat(privateFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.directory, 'credentials'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(privateFile, 'utf8'))).toEqual({ token: 'never-log' });
  });
  it('retains session across network loss but rotates after graceful end', async () => {
    const f = await fixture();
    const initial = f.client.sessionId;
    await f.client.stop(false);
    await f.client.start();
    expect(f.client.sessionId).toBe(initial);
    await f.client.stop();
    await f.client.start();
    expect(f.client.sessionId).not.toBe(initial);
  });
  it('prevents simultaneous reuse of a persisted session', async () => {
    const f = await fixture();
    const duplicate = new Connector(f.options);
    await expect(duplicate.start()).rejects.toThrow('already running');
    expect(f.client.status().connected).toBe(true);
  });
  it('renews active claims and declared intent independently from heartbeat', async () => {
    const f = await fixture();
    const taskId = randomUUID();
    await f.client.call('coord_claim_task', {
      task_id: taskId,
      lease_seconds: 5,
      idempotency_key: randomUUID(),
    });
    await f.client.call('coord_announce_work', {
      task_id: taskId,
      summary: 'Implement',
      paths: [{ path: 'local.ts', mode: 'modify' }],
      ttl_seconds: 5,
      idempotency_key: randomUUID(),
    });
    await until(
      () =>
        f.requests.some((r) => r.operation === 'coord_renew_task') &&
        f.requests.filter((r) => r.operation === 'coord_announce_work').length >= 2,
    );
    expect(f.requests.some((r) => r.operation === 'coord_heartbeat')).toBe(true);
  });
  it('rejects local symlink escape in intent, handoff and fact provenance before sending', async () => {
    const f = await fixture();
    await symlink(tmpdir(), join(f.directory, 'outside'));
    await symlink(
      join(tmpdir(), 'coord-nonexistent-' + randomUUID()),
      join(f.directory, 'dangling'),
    );
    await expect(
      f.client.call('coord_announce_work', {
        summary: 'unsafe',
        paths: [{ path: 'dangling/new.ts', mode: 'create' }],
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow('unresolved');
    const before = f.requests.length;
    await expect(
      f.client.call('coord_announce_work', {
        summary: 'unsafe',
        paths: [{ path: 'outside/file.ts', mode: 'modify' }],
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow('outside');
    await expect(
      f.client.call('coord_record_fact', {
        type: 'constraint',
        title: 'Paths',
        statement: 'Unsafe path',
        provenance: { paths: ['outside/file.ts'] },
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow('outside');
    await expect(
      f.client.call('coord_create_handoff', {
        task_id: randomUUID(),
        to: { session_id: randomUUID() },
        summary: 'unsafe',
        paths: ['outside/file.ts'],
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow('outside');
    expect(
      f.requests
        .slice(before)
        .some((r) =>
          ['coord_announce_work', 'coord_record_fact', 'coord_create_handoff'].includes(
            r.operation,
          ),
        ),
    ).toBe(false);
    await expect(
      f.client.call('coord_get_project_context', { project_id: randomUUID() }),
    ).rejects.toThrow('binding');
  });
});
