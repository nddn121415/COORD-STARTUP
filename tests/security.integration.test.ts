import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTestDatabase } from './db.js';
import { ControlPlaneService, seedDemo } from '../apps/control-plane/src/index.js';
import { maxPayloadBytes } from '../packages/protocol/src/index.js';
import type { SessionContext } from '../apps/control-plane/src/service.js';
import type { Pool } from 'pg';

async function sessions(pool: Pool) {
  const seed = await seedDemo(pool),
    service = new ControlPlaneService(pool);
  async function connect(
    token: string,
    projectId: string,
    repositoryId: string,
    agent: string,
    sessionId = randomUUID(),
  ): Promise<SessionContext> {
    await service.hello(token, {
      protocol_version: 1,
      project_id: projectId,
      repository_id: repositoryId,
      session_id: sessionId,
      agent,
      device_name: agent,
      after_seq: 0,
    });
    return { token, projectId, sessionId };
  }
  const a = await connect(seed.waled.token, seed.projectId, seed.repositoryId, 'codex');
  const b = await connect(seed.sarah.token, seed.projectId, seed.repositoryId, 'claude');
  const outsider = await connect(
    seed.outsider.token,
    seed.outsider.projectId,
    'private-demo-repository',
    'other',
  );
  return { seed, service, connect, a, b, outsider };
}
const key = () => ({ idempotency_key: randomUUID() });

describe('independent adversarial security review', () => {
  it('prevents a valid large handoff from poisoning every client durable replay', async () =>
    withTestDatabase(async (pool) => {
      const { service, a, b } = await sessions(pool);
      const { task } = await service.request(a, 'coord_create_task', {
        title: 'Large handoff',
        ...key(),
      });
      await service.request(a, 'coord_claim_task', { task_id: task.id, ...key() });
      const input = {
        task_id: task.id,
        to: { session_id: b.sessionId },
        summary: 'Large but valid metadata',
        completed: Array.from({ length: 100 }, () => 'a'.repeat(1600)),
        ...key(),
      };
      expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(maxPayloadBytes);
      const result = await service.request(a, 'coord_create_handoff', input);
      expect(
        Buffer.byteLength(
          JSON.stringify({ type: 'response', request_id: randomUUID(), ok: true, result }),
        ),
      ).toBeLessThanOrEqual(maxPayloadBytes);
      const { rows } = await pool.query('SELECT * FROM project_events WHERE project_id=$1', [
        a.projectId,
      ]);
      for (const row of rows) {
        expect(
          Buffer.byteLength(
            JSON.stringify({
              type: 'event',
              event: { ...row, seq: Number(row.seq), timestamp: row.timestamp.toISOString() },
            }),
          ),
        ).toBeLessThanOrEqual(maxPayloadBytes);
      }
    }));

  it('bounds context snapshots when many valid messages exceed one transport frame', async () =>
    withTestDatabase(async (pool) => {
      const { service, a } = await sessions(pool);
      for (let i = 0; i < 40; i++)
        await service.request(a, 'coord_send_message', {
          recipient: { type: 'project' },
          body: 'a'.repeat(7900),
          ...key(),
        });
      const result = await service.request(a, 'coord_get_project_context', {
        include: ['messages'],
        limit: 50,
      });
      expect(
        Buffer.byteLength(
          JSON.stringify({ type: 'response', request_id: randomUUID(), ok: true, result }),
        ),
      ).toBeLessThanOrEqual(maxPayloadBytes);
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages.length).toBeLessThan(40);
      expect(result.truncated_sections).toContain('messages');
      expect(
        Number(
          (await pool.query('SELECT count(*) FROM messages WHERE project_id=$1', [a.projectId]))
            .rows[0].count,
        ),
      ).toBe(40);
    }));

  it('does not let concurrent foreign-project hello upserts overwrite session identity metadata', async () =>
    withTestDatabase(async (pool) => {
      const { seed, service } = await sessions(pool);
      // Ensure both ownership reads complete before either insert, reproducing the race deterministically.
      await pool.query(
        'CREATE FUNCTION slow_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END $$',
      );
      await pool.query(
        'CREATE TRIGGER slow_session_insert BEFORE INSERT ON agent_sessions FOR EACH ROW EXECUTE FUNCTION slow_session_insert()',
      );
      const sessionId = randomUUID();
      const hello = (project_id: string, repository_id: string, agent: string) => ({
        protocol_version: 1,
        project_id,
        repository_id,
        session_id: sessionId,
        agent,
        device_name: agent,
        after_seq: 0,
      });
      const attempts = await Promise.allSettled([
        service.hello(seed.waled.token, hello(seed.projectId, seed.repositoryId, 'codex')),
        service.hello(
          seed.outsider.token,
          hello(seed.outsider.projectId, 'private-demo-repository', 'other'),
        ),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = (
        await pool.query('SELECT project_id,agent,device_id FROM agent_sessions WHERE id=$1', [
          sessionId,
        ])
      ).rows[0];
      expect(row.agent).toBe(row.project_id === seed.projectId ? 'codex' : 'other');
      expect(row.device_id).toBe(
        row.project_id === seed.projectId ? seed.waled.deviceId : seed.outsider.deviceId,
      );
    }));

  it('rejects forged sessions, stolen claims, unauthorized/stale handoffs and cross-project references', async () =>
    withTestDatabase(async (pool) => {
      const { seed, service, a, b, outsider } = await sessions(pool);
      await expect(
        service.request({ ...b, sessionId: a.sessionId }, 'coord_get_project_context', {}),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const { task } = await service.request(a, 'coord_create_task', {
        title: 'Owned task',
        ...key(),
      });
      const claim = await service.request(a, 'coord_claim_task', { task_id: task.id, ...key() });
      await expect(
        service.request(b, 'coord_release_task', {
          task_id: task.id,
          claim_id: claim.claim_id,
          ...key(),
        }),
      ).rejects.toMatchObject({ code: 'CLAIM_NOT_OWNED' });
      await expect(
        service.request(outsider, 'coord_claim_task', { task_id: task.id, ...key() }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        service.request(a, 'coord_send_message', {
          recipient: { type: 'user', id: seed.outsider.userId },
          body: 'Foreign recipient',
          ...key(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const { handoff } = await service.request(a, 'coord_create_handoff', {
        task_id: task.id,
        to: { session_id: b.sessionId },
        summary: 'Transfer',
        ...key(),
      });
      await expect(
        service.request(a, 'coord_accept_handoff', {
          handoff_id: handoff.id,
          expected_version: handoff.version,
          ...key(),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.request(b, 'coord_accept_handoff', {
          handoff_id: handoff.id,
          expected_version: handoff.version + 1,
          ...key(),
        }),
      ).rejects.toMatchObject({ code: 'STALE_VERSION' });
      await pool.query(
        "UPDATE task_claims SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [claim.claim_id],
      );
      await expect(
        service.request(a, 'coord_renew_task', {
          task_id: task.id,
          claim_id: claim.claim_id,
          ...key(),
        }),
      ).rejects.toMatchObject({ code: 'CLAIM_NOT_OWNED' });
      await pool.query('UPDATE devices SET revoked_at=now() WHERE id=$1', [seed.waled.deviceId]);
      await expect(service.request(a, 'coord_get_project_context', {})).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }));
});
