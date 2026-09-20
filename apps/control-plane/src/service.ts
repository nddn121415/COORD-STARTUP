import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CoordError, operationSchemas, defaults } from '@coord/protocol';
import { FileConflictAnalyzer } from '@coord/conflict-engine';
import { canonical, tokenHash, transaction } from './database.js';
import { perform } from './operations.js';
import { assertWireBudget, boundResult } from './wire-budget.js';

type Row = Record<string, any>;
export interface Identity {
  device_id: string;
  user_id: string;
  organization_id: string;
  user_name: string;
}
export interface SessionContext {
  token: string;
  projectId: string;
  sessionId: string;
}
export class ControlPlaneService {
  readonly analyzer = new FileConflictAnalyzer();
  constructor(
    readonly pool: Pool,
    readonly offlineMs: number = defaults.offlineMs,
  ) {}
  async authenticate(db: Pool | PoolClient, token: string): Promise<Identity> {
    const r = await db.query(
      'SELECT d.id AS device_id,d.user_id,u.organization_id,u.name AS user_name FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND d.expires_at>now()',
      [tokenHash(token)],
    );
    if (!r.rowCount)
      throw new CoordError('UNAUTHORIZED', 'Device token is invalid, expired, or revoked.');
    return r.rows[0];
  }
  async authorize(
    db: Pool | PoolClient,
    token: string,
    projectId: string,
    sessionId?: string,
  ): Promise<Identity> {
    const identity = await this.authenticate(db, token);
    if (
      !(
        await db.query('SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2', [
          projectId,
          identity.user_id,
        ])
      ).rowCount
    )
      throw new CoordError('FORBIDDEN', 'Project membership required.');
    if (
      sessionId &&
      !(
        await db.query(
          'SELECT 1 FROM agent_sessions WHERE id=$1 AND project_id=$2 AND device_id=$3 AND user_id=$4 AND ended_at IS NULL',
          [sessionId, projectId, identity.device_id, identity.user_id],
        )
      ).rowCount
    )
      throw new CoordError('FORBIDDEN', 'Session does not belong to this device or has ended.');
    return identity;
  }
  async emit(db: PoolClient, projectId: string, type: string, payload: Row) {
    const seq = Number(
      (
        await db.query(
          'UPDATE projects SET latest_seq=latest_seq+1 WHERE id=$1 RETURNING latest_seq',
          [projectId],
        )
      ).rows[0].latest_seq,
    );
    const event = {
      event_id: randomUUID(),
      project_id: projectId,
      seq,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    assertWireBudget({ type: 'event', event });
    await db.query(
      'INSERT INTO project_events(event_id,project_id,seq,type,payload,timestamp) VALUES($1,$2,$3,$4,$5,$6)',
      [event.event_id, projectId, seq, type, payload, event.timestamp],
    );
  }
  async hello(token: string, input: Row) {
    return transaction(this.pool, async (db) => {
      const identity = await this.authorize(db, token, input.project_id);
      const project = (
        await db.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE', [input.project_id])
      ).rows[0];
      await this.authorize(db, token, input.project_id);
      if (project.repository_id !== input.repository_id)
        throw new CoordError(
          'REPOSITORY_MISMATCH',
          'Checkout repository binding does not match this project.',
        );
      if (input.after_seq > Number(project.latest_seq))
        throw new CoordError('INVALID_CURSOR', 'Resume cursor exceeds project event sequence.');
      const previous = (
        await db.query('SELECT * FROM agent_sessions WHERE id=$1', [input.session_id])
      ).rows[0];
      if (
        previous &&
        (previous.project_id !== input.project_id ||
          previous.device_id !== identity.device_id ||
          previous.user_id !== identity.user_id ||
          previous.ended_at)
      )
        throw new CoordError(
          'FORBIDDEN',
          'Session identifier is already bound to another device, project, or ended session.',
        );
      const bound = await db.query(
        'INSERT INTO agent_sessions(id,project_id,user_id,device_id,agent,device_name) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET online=true,last_seen=now(),agent=excluded.agent,device_name=excluded.device_name WHERE agent_sessions.project_id=excluded.project_id AND agent_sessions.device_id=excluded.device_id AND agent_sessions.user_id=excluded.user_id AND agent_sessions.ended_at IS NULL RETURNING id',
        [
          input.session_id,
          input.project_id,
          identity.user_id,
          identity.device_id,
          input.agent,
          input.device_name,
        ],
      );
      if (!bound.rowCount)
        throw new CoordError(
          'FORBIDDEN',
          'Session identifier belongs to another device or project.',
        );
      if (!previous?.online)
        await this.emit(db, input.project_id, 'session.online', {
          session_id: input.session_id,
          user_id: identity.user_id,
          agent: input.agent,
        });
      const latest = await db.query('SELECT latest_seq FROM projects WHERE id=$1', [
        input.project_id,
      ]);
      return {
        session_id: input.session_id,
        project_id: input.project_id,
        latest_seq: Number(latest.rows[0].latest_seq),
      };
    });
  }
  async reference(db: PoolClient, table: string, id: string, projectId: string): Promise<Row> {
    const allowed = ['tasks', 'agent_sessions', 'project_facts', 'handoffs', 'work_intents'];
    if (!allowed.includes(table)) throw new Error('Internal reference table is not allowed');
    const row = (
      await db.query(`SELECT * FROM ${table} WHERE id=$1 AND project_id=$2`, [id, projectId])
    ).rows[0];
    if (!row) throw new CoordError('NOT_FOUND', 'Referenced object is not in this project.');
    return row;
  }
  async checkRecipient(db: PoolClient, projectId: string, to: Row) {
    if (to.session_id) await this.reference(db, 'agent_sessions', to.session_id, projectId);
    if (
      to.user_id &&
      !(
        await db.query('SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2', [
          projectId,
          to.user_id,
        ])
      ).rowCount
    )
      throw new CoordError('NOT_FOUND', 'Recipient is not a project member.');
    if (to.user_id && to.session_id) {
      const session = await this.reference(db, 'agent_sessions', to.session_id, projectId);
      if (session.user_id !== to.user_id)
        throw new CoordError('INVALID_RECIPIENT', 'Recipient user and session do not match.');
    }
  }
  async conflicts(db: PoolClient, projectId: string): Promise<Row[]> {
    const work: any[] = [];
    const sessions = (
      await db.query(
        "SELECT id,observation FROM agent_sessions WHERE project_id=$1 AND online=true AND ended_at IS NULL AND last_seen>now()-($2::double precision*interval '1 millisecond')",
        [projectId, this.offlineMs],
      )
    ).rows;
    const active = new Set(sessions.map((s) => s.id));
    const intents = (
      await db.query('SELECT * FROM work_intents WHERE project_id=$1 AND expires_at>now()', [
        projectId,
      ])
    ).rows;
    for (const intent of intents)
      if (active.has(intent.session_id))
        work.push({
          session_id: intent.session_id,
          task_id: intent.task_id ?? undefined,
          paths: intent.paths,
          source: 'intent',
        });
    for (const session of sessions)
      if (session.observation)
        work.push({ session_id: session.id, paths: session.observation.paths, source: 'git' });
    const candidates = this.analyzer.analyze(work);
    const prior = (
      await db.query("SELECT * FROM conflicts WHERE project_id=$1 AND status='active'", [projectId])
    ).rows;
    const fingerprints = new Set<string>();
    for (const candidate of candidates) {
      const fingerprint = createHash('sha256')
        .update(
          canonical({
            left_session: candidate.left_session,
            right_session: candidate.right_session,
            path: candidate.path,
            type: candidate.type,
          }),
        )
        .digest('hex');
      fingerprints.add(fingerprint);
      const old = prior.find((c) => c.fingerprint === fingerprint);
      if (old) {
        await db.query('UPDATE conflicts SET body=$1 WHERE id=$2', [candidate, old.id]);
        continue;
      }
      const row = (
        await db.query(
          "INSERT INTO conflicts(id,project_id,fingerprint,body) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,fingerprint) DO UPDATE SET body=excluded.body,status='active',resolved_at=NULL RETURNING *",
          [randomUUID(), projectId, fingerprint, candidate],
        )
      ).rows[0];
      await this.emit(db, projectId, 'conflict.created', {
        conflict: { ...row.body, id: row.id, project_id: projectId, status: 'active' },
      });
    }
    for (const old of prior)
      if (!fingerprints.has(old.fingerprint)) {
        await db.query("UPDATE conflicts SET status='resolved',resolved_at=now() WHERE id=$1", [
          old.id,
        ]);
        await this.emit(db, projectId, 'conflict.resolved', { conflict_id: old.id });
      }
    return (
      await db.query(
        "SELECT id,project_id,body,status,created_at FROM conflicts WHERE project_id=$1 AND status='active' ORDER BY created_at,id",
        [projectId],
      )
    ).rows.map((r) => ({
      ...r.body,
      id: r.id,
      project_id: r.project_id,
      status: r.status,
      created_at: r.created_at,
    }));
  }
  async expire(db: PoolClient, projectId: string) {
    const offline = (
      await db.query(
        "UPDATE agent_sessions SET online=false WHERE project_id=$1 AND online=true AND (last_seen<=now()-($2::double precision*interval '1 millisecond') OR NOT EXISTS(SELECT 1 FROM devices d WHERE d.id=agent_sessions.device_id AND d.revoked_at IS NULL AND d.expires_at>now()) OR NOT EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=agent_sessions.project_id AND m.user_id=agent_sessions.user_id)) RETURNING id",
        [projectId, this.offlineMs],
      )
    ).rows;
    for (const row of offline)
      await this.emit(db, projectId, 'session.offline', { session_id: row.id });
    const expired = (
      await db.query(
        'DELETE FROM task_claims WHERE project_id=$1 AND lease_expires_at<=now() RETURNING *',
        [projectId],
      )
    ).rows;
    for (const row of expired) {
      await this.emit(db, projectId, 'claim.expired', {
        task_id: row.task_id,
        claim_id: row.id,
        session_id: row.session_id,
      });
      const updated = (
        await db.query(
          "UPDATE tasks SET status='todo',version=version+1,updated_at=now() WHERE id=$1 AND status='doing' RETURNING *",
          [row.task_id],
        )
      ).rows[0];
      if (updated) await this.emit(db, projectId, 'task.updated', { task: updated });
    }
    const intents = (
      await db.query(
        'DELETE FROM work_intents WHERE project_id=$1 AND expires_at<=now() RETURNING *',
        [projectId],
      )
    ).rows;
    for (const row of intents)
      await this.emit(db, projectId, 'intent.expired', {
        intent_id: row.id,
        session_id: row.session_id,
      });
    if (offline.length || intents.length) await this.conflicts(db, projectId);
  }
  async sweep() {
    const projects = (await this.pool.query('SELECT id FROM projects')).rows;
    for (const project of projects)
      await transaction(this.pool, async (db) => {
        await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [project.id]);
        await this.expire(db, project.id);
      });
  }
  async request(context: SessionContext, operation: string, raw: unknown): Promise<Row> {
    if (!Object.hasOwn(operationSchemas, operation))
      throw new CoordError('UNKNOWN_OPERATION', 'Unknown coordination operation.');
    const input = (operationSchemas as Record<string, any>)[operation].parse(raw) as Row;
    if (input.project_id && input.project_id !== context.projectId)
      throw new CoordError('FORBIDDEN', 'Request project differs from connected project.');
    return transaction(this.pool, async (db) => {
      const identity = await this.authorize(
        db,
        context.token,
        context.projectId,
        context.sessionId,
      );
      await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [context.projectId]);
      // Recheck after acquiring the project lock so ended sessions cannot race requests.
      await this.authorize(db, context.token, context.projectId, context.sessionId);
      await this.expire(db, context.projectId);
      const digest = createHash('sha256').update(canonical({ operation, input })).digest('hex');
      if (input.idempotency_key) {
        const previous = (
          await db.query(
            'SELECT * FROM idempotency_keys WHERE project_id=$1 AND session_id=$2 AND key=$3',
            [context.projectId, context.sessionId, input.idempotency_key],
          )
        ).rows[0];
        if (previous) {
          if (previous.digest !== digest)
            throw new CoordError(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key was already used for different input.',
            );
          return previous.result;
        }
      }
      const result = boundResult(
        JSON.parse(
          JSON.stringify(await perform(this, db, context, identity, operation, input)),
        ) as Row,
      );
      if (input.idempotency_key)
        await db.query(
          'INSERT INTO audit_events(id,project_id,user_id,device_id,session_id,operation) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            context.projectId,
            identity.user_id,
            identity.device_id,
            context.sessionId,
            operation,
          ],
        );
      if (input.idempotency_key)
        await db.query(
          'INSERT INTO idempotency_keys(project_id,session_id,key,digest,result) VALUES($1,$2,$3,$4,$5)',
          [context.projectId, context.sessionId, input.idempotency_key, digest, result],
        );
      return result;
    });
  }
}
