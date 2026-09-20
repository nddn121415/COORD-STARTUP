import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Connector } from '../packages/connector/src/index.js';
import { createControlPlane, seedDemo } from '../apps/control-plane/src/index.js';
import { withTestDatabase } from './db.js';
import type { ProjectEvent } from '../packages/protocol/src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
const exec = promisify(execFile);
const key = () => randomUUID();
async function repo(path: string) {
  await mkdir(join(path, 'src'), { recursive: true });
  await exec('git', ['init', '-b', 'main', path]);
  await writeFile(join(path, 'src/user.ts'), 'export const user = {};\n');
  await exec('git', ['-C', path, 'add', '.']);
  await exec('git', [
    '-C',
    path,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
}
async function eventually(predicate: () => boolean | Promise<boolean>, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for expected durable coordination state');
}
function result(raw: unknown): any {
  const response = CallToolResultSchema.parse(raw);
  if (response.isError) throw new Error(JSON.stringify(response.content));
  const text = response.content.find((c) => c.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Expected MCP text result');
  // Bridge returns a trust notice plus a JSON object.
  return JSON.parse(text.text.slice(text.text.indexOf('{'))).data;
}
describe('two-machine scenario against real PostgreSQL and sockets', () => {
  it(
    'coordinates Waled/Codex and Sarah/Claude, transfers ownership, and replays missed events',
    async () =>
      withTestDatabase(async (pool) => {
        const temp = await mkdtemp(join(tmpdir(), 'coord-e2e-'));
        const aRoot = join(temp, 'laptop-a'),
          bRoot = join(temp, 'laptop-b');
        await repo(aRoot);
        await exec('git', ['clone', aRoot, bRoot]);
        const seed = await seedDemo(pool),
          server = await createControlPlane({ pool, port: 0, sweepMs: 40 });
        const aEvents: ProjectEvent[] = [],
          bEvents: ProjectEvent[] = [];
        const common = {
          url: server.url,
          projectId: seed.projectId,
          repositoryId: seed.repositoryId,
          heartbeatMs: 1000,
          renewMs: 1500,
          reconcileMs: 1500,
        };
        const a = new Connector({
          ...common,
          token: seed.waled.token,
          repoRoot: aRoot,
          agent: 'codex',
          stateDir: join(temp, 'a-state'),
          onEvent: (e) => {
            aEvents.push(e);
          },
        });
        const b = new Connector({
          ...common,
          token: seed.sarah.token,
          repoRoot: bRoot,
          agent: 'claude',
          stateDir: join(temp, 'b-state'),
          onEvent: (e) => {
            bEvents.push(e);
          },
        });
        try {
          await a.start();
          await b.start();
          const snapshot: any = await a.call('coord_get_project_context', {});
          expect(
            snapshot.agents
              .filter((s: any) => s.online)
              .map((s: any) => s.user_name)
              .sort(),
          ).toEqual(['Sarah', 'Waled']);
          const create = { title: 'Profile editing', idempotency_key: key() };
          const profile: any = await a.call('coord_create_task', create);
          expect((await a.call('coord_create_task', create)).task).toEqual(profile.task);
          const reset: any = await b.call('coord_create_task', {
            title: 'Password reset',
            idempotency_key: key(),
          });
          const lease: any = await a.call('coord_claim_task', {
            task_id: profile.task.id,
            idempotency_key: key(),
          });
          await b.call('coord_claim_task', { task_id: reset.task.id, idempotency_key: key() });
          await a.call('coord_announce_work', {
            task_id: profile.task.id,
            summary: 'Profile editing',
            paths: [
              { path: 'src/user.ts', mode: 'modify' },
              { path: 'src/profile.ts', mode: 'create' },
            ],
            idempotency_key: key(),
          });
          const warning: any = await b.call('coord_announce_work', {
            task_id: reset.task.id,
            summary: 'Password reset',
            paths: [
              { path: 'src/user.ts', mode: 'modify' },
              { path: 'src/auth.ts', mode: 'create' },
            ],
            idempotency_key: key(),
          });
          expect(warning.conflicts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: 'src/user.ts', severity: 'warning' }),
            ]),
          );
          await eventually(
            () =>
              aEvents.some((e) => e.type === 'conflict.created') &&
              bEvents.some((e) => e.type === 'conflict.created'),
          );
          expect(
            (
              await pool.query(
                "SELECT COUNT(*) FROM project_events WHERE project_id=$1 AND type='conflict.created'",
                [seed.projectId],
              )
            ).rows[0].count,
          ).toBe('1');
          const sent: any = await a.call('coord_send_message', {
            recipient: { type: 'session', id: b.sessionId },
            kind: 'note',
            body: 'I am only changing avatar/profile fields.',
            idempotency_key: key(),
          });
          await eventually(() =>
            bEvents.some(
              (e) =>
                e.type === 'message.created' && (e.payload.message as any).id === sent.message.id,
            ),
          );
          const fact: any = await a.call('coord_record_fact', {
            type: 'decision',
            title: 'Avatar storage',
            statement: 'Use S3-compatible object storage.',
            status: 'accepted',
            provenance: { task_id: profile.task.id, paths: ['src/profile.ts'] },
            idempotency_key: key(),
          });
          expect((await b.call('coord_get_project_context', { include: ['facts'] })).facts).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: fact.fact.id })]),
          );
          const handoff: any = await a.call('coord_create_handoff', {
            task_id: profile.task.id,
            to: { session_id: b.sessionId },
            summary: 'Continue profile integration',
            completed: ['Defined profile fields'],
            remaining: ['Finish avatar endpoint'],
            blockers: [],
            paths: ['src/user.ts'],
            tests: ['Prototype checks pass'],
            fact_ids: [fact.fact.id],
            first_action: 'Review profile intent',
            idempotency_key: key(),
          });
          const accepted: any = await b.call('coord_accept_handoff', {
            handoff_id: handoff.handoff.id,
            expected_version: handoff.handoff.version,
            idempotency_key: key(),
          });
          expect(accepted.handoff.status).toBe('accepted');
          await expect(
            a.call('coord_renew_task', {
              task_id: profile.task.id,
              claim_id: lease.claim_id,
              idempotency_key: key(),
            }),
          ).rejects.toMatchObject({ code: 'CLAIM_NOT_OWNED' });
          expect(
            (await b.call('coord_get_project_context', { include: ['claims'] })).claims,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ task_id: profile.task.id, session_id: b.sessionId }),
            ]),
          );
          // Git observes paths independently of announcements, never contents or secrets.
          await writeFile(join(aRoot, 'src/user.ts'), 'export const user = { avatar: true };\n');
          await writeFile(join(aRoot, '.env'), 'SECRET=never-upload-this');
          const observed = await a.refreshGit();
          expect(observed.unstaged).toContain('src/user.ts');
          expect(JSON.stringify(observed)).not.toContain('never-upload-this');
          expect(JSON.stringify(observed)).not.toContain('.env');
          // Stop transport without ending session; replay must use its private durable cursor.
          await eventually(() => b.status().afterSeq >= aEvents.at(-1)!.seq);
          const cursor = b.status().afterSeq,
            previousSession = b.sessionId;
          await b.stop(false);
          const offlineMessage = {
            recipient: { type: 'session', id: previousSession },
            kind: 'question',
            body: 'Review profile fields after reconnect',
            idempotency_key: key(),
          };
          const missing: any = await a.call('coord_send_message', offlineMessage);
          await a.call('coord_record_fact', {
            type: 'known_issue',
            title: 'Offline note',
            statement: 'Connector replay required',
            idempotency_key: key(),
          });
          await a.call('coord_announce_work', {
            summary: 'Rename shared file',
            paths: [{ path: 'src/user-v2.ts', from_path: 'src/user.ts', mode: 'rename' }],
            idempotency_key: key(),
          });
          await b.start();
          expect(b.sessionId).toBe(previousSession);
          await eventually(() =>
            bEvents.some(
              (e) =>
                e.seq > cursor &&
                e.type === 'message.created' &&
                (e.payload.message as any).id === missing.message.id,
            ),
          );
          await eventually(
            () =>
              bEvents.some((e) => e.seq > cursor && e.type === 'fact.created') &&
              bEvents.some((e) => e.seq > cursor && e.type === 'conflict.created'),
          );
          expect(new Set(bEvents.map((e) => e.seq)).size).toBe(bEvents.length);
          expect((await a.call('coord_send_message', offlineMessage)).message).toEqual(
            missing.message,
          );
          expect(
            (await pool.query('SELECT COUNT(*) FROM messages WHERE id=$1', [missing.message.id]))
              .rows[0].count,
          ).toBe('1');
          await b.call('coord_release_task', {
            task_id: profile.task.id,
            claim_id: accepted.claim_id,
            idempotency_key: key(),
          });
        } finally {
          await a.stop();
          await b.stop();
          await server.close();
          await rm(temp, { recursive: true, force: true });
        }
      }),
    30_000,
  );
  it(
    'runs the real stdio MCP entry against control plane and Git checkout',
    async () =>
      withTestDatabase(async (pool) => {
        const temp = await mkdtemp(join(tmpdir(), 'coord-mcp-e2e-')),
          root = join(temp, 'checkout'),
          home = join(temp, 'home');
        await repo(root);
        await mkdir(join(root, '.coord'), { recursive: true });
        await mkdir(home);
        const seed = await seedDemo(pool),
          server = await createControlPlane({ pool, port: 0, sweepMs: 50 });
        await writeFile(
          join(root, '.coord', 'binding.json'),
          JSON.stringify({
            projectId: seed.projectId,
            repositoryId: seed.repositoryId,
            url: server.url,
          }),
          { mode: 0o600 },
        );
        await writeFile(
          join(home, 'credentials.json'),
          JSON.stringify({ url: server.url, token: seed.waled.token }),
          { mode: 0o600 },
        );
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [
            '--import',
            'tsx',
            resolve('packages/mcp-server/src/main.ts'),
            '--repo',
            root,
            '--agent',
            'codex',
          ],
          cwd: process.cwd(),
          env: { ...env, COORD_HOME: home },
          stderr: 'pipe',
        });
        let stderr = '';
        transport.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        const client = new Client({ name: 'real-codex-mcp-harness', version: '1.0.0' });
        try {
          await client.connect(transport);
          const tools = await client.listTools();
          expect(tools.tools).toHaveLength(12);
          const context = result(
            await client.callTool({ name: 'coord_get_project_context', arguments: {} }),
          );
          expect(context.agents.some((a: any) => a.user_name === 'Waled')).toBe(true);
          const task = result(
            await client.callTool({
              name: 'coord_create_task',
              arguments: { title: 'Real stdio task', idempotency_key: key() },
            }),
          );
          expect(task.task.title).toBe('Real stdio task');
          expect(
            (await pool.query('SELECT COUNT(*) FROM tasks WHERE id=$1', [task.task.id])).rows[0]
              .count,
          ).toBe('1');
          expect(stderr).not.toContain(seed.waled.token);
        } finally {
          await client.close();
          await transport.close();
          await server.close();
          await rm(temp, { recursive: true, force: true });
        }
      }),
    30_000,
  );
});
