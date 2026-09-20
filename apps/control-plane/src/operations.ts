import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CoordError, defaults } from '@coord/protocol';
import type { ControlPlaneService, SessionContext, Identity } from './service.js';
type Row = Record<string, any>;
function handoffView(row: Row): Row {
  const { body, ...columns } = row;
  return { ...body, ...columns };
}
export async function perform(
  service: ControlPlaneService,
  db: PoolClient,
  context: SessionContext,
  identity: Identity,
  operation: string,
  input: Row,
): Promise<Row> {
  const { projectId: p, sessionId: s } = context;
  const emit = (type: string, payload: Row) => service.emit(db, p, type, payload);
  const task = () => service.reference(db, 'tasks', input.task_id, p);
  const claim = async () => {
    await task();
    const row = (
      await db.query(
        'SELECT * FROM task_claims WHERE project_id=$1 AND task_id=$2 AND session_id=$3 AND id=$4 AND lease_expires_at>now()',
        [p, input.task_id, s, input.claim_id],
      )
    ).rows[0];
    if (!row)
      throw new CoordError(
        'CLAIM_NOT_OWNED',
        'Claim is expired, missing, or belongs to another session.',
      );
    return row;
  };
  switch (operation) {
    case 'coord_get_project_context': {
      const result: Row = { project_id: p, session_id: s };
      const include = input.include ?? [
        'agents',
        'tasks',
        'claims',
        'intents',
        'conflicts',
        'messages',
        'facts',
        'handoffs',
      ];
      const limit = input.limit ?? 100;
      const queries: Record<string, string> = {
        agents:
          "SELECT a.id,a.id AS session_id,a.user_id,u.name AS user_name,a.agent,a.online,a.last_seen,a.observation->>'branch' AS branch,a.observation->>'head' AS head FROM agent_sessions a JOIN users u ON u.id=a.user_id WHERE a.project_id=$1 ORDER BY a.last_seen DESC LIMIT $2",
        tasks: 'SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT $2',
        claims:
          'SELECT *,id AS claim_id FROM task_claims WHERE project_id=$1 AND lease_expires_at>now() ORDER BY lease_expires_at DESC LIMIT $2',
        intents:
          'SELECT * FROM work_intents WHERE project_id=$1 AND expires_at>now() ORDER BY expires_at DESC LIMIT $2',
        messages: 'SELECT * FROM messages WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT $2',
        facts:
          'SELECT * FROM project_facts WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT $2',
        handoffs: 'SELECT * FROM handoffs WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT $2',
      };
      for (const name of include)
        result[name] =
          name === 'conflicts'
            ? await service.conflicts(db, p)
            : (await db.query(queries[name], [p, limit])).rows;
      if (result.handoffs) result.handoffs = result.handoffs.map(handoffView);
      return result;
    }
    case 'coord_create_task': {
      for (const id of input.depends_on ?? []) await service.reference(db, 'tasks', id, p);
      const row = (
        await db.query(
          'INSERT INTO tasks(id,project_id,title,detail,definition_of_done,depends_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [
            randomUUID(),
            p,
            input.title,
            input.detail ?? null,
            input.definition_of_done ?? null,
            input.depends_on ?? [],
            s,
          ],
        )
      ).rows[0];
      await emit('task.created', { task: row });
      return { task: row };
    }
    case 'coord_claim_task': {
      const current = await task();
      if (['done', 'cancelled'].includes(current.status))
        throw new CoordError('TASK_CLOSED', 'Closed tasks cannot be claimed.');
      const held = (await db.query('SELECT * FROM task_claims WHERE task_id=$1', [input.task_id]))
        .rows[0];
      if (held) throw new CoordError('TASK_ALREADY_CLAIMED', 'Task already has an active lease.');
      const row = (
        await db.query(
          "INSERT INTO task_claims(id,project_id,task_id,session_id,lease_expires_at) VALUES($1,$2,$3,$4,now()+($5::integer*interval '1 second')) RETURNING *",
          [randomUUID(), p, input.task_id, s, input.lease_seconds ?? defaults.leaseSeconds],
        )
      ).rows[0];
      const updated = (
        await db.query(
          "UPDATE tasks SET status='doing',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [input.task_id],
        )
      ).rows[0];
      await emit('task.claimed', {
        task: updated,
        claim_id: row.id,
        session_id: s,
        lease_expires_at: row.lease_expires_at,
      });
      return { task: updated, claim_id: row.id, lease_expires_at: row.lease_expires_at };
    }
    case 'coord_renew_task': {
      await claim();
      const row = (
        await db.query(
          "UPDATE task_claims SET lease_expires_at=now()+($2::integer*interval '1 second') WHERE id=$1 RETURNING *",
          [input.claim_id, input.lease_seconds ?? defaults.leaseSeconds],
        )
      ).rows[0];
      await emit('claim.renewed', {
        task_id: input.task_id,
        claim_id: row.id,
        lease_expires_at: row.lease_expires_at,
      });
      return { claim_id: row.id, lease_expires_at: row.lease_expires_at };
    }
    case 'coord_release_task': {
      await claim();
      await db.query('DELETE FROM task_claims WHERE id=$1', [input.claim_id]);
      const updated = (
        await db.query(
          "UPDATE tasks SET status='todo',version=version+1,updated_at=now() WHERE id=$1 AND status='doing' RETURNING *",
          [input.task_id],
        )
      ).rows[0];
      if (updated) await emit('task.updated', { task: updated });
      await emit('task.released', {
        task_id: input.task_id,
        claim_id: input.claim_id,
        reason: input.reason ?? null,
      });
      return { released: true };
    }
    case 'coord_update_task': {
      const current = await task();
      if (current.version !== input.expected_version)
        throw new CoordError('STALE_VERSION', 'Task version has changed.');
      const held = (await db.query('SELECT * FROM task_claims WHERE task_id=$1', [input.task_id]))
        .rows[0];
      if (held && held.session_id !== s)
        throw new CoordError('CLAIM_NOT_OWNED', 'Only current lease owner can update this task.');
      const row = (
        await db.query(
          'UPDATE tasks SET status=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [input.task_id, input.status],
        )
      ).rows[0];
      if (['done', 'cancelled'].includes(input.status))
        await db.query('DELETE FROM task_claims WHERE task_id=$1', [input.task_id]);
      await emit('task.updated', { task: row });
      return { task: row };
    }
    case 'coord_announce_work': {
      if (input.task_id) await task();
      const row = (
        await db.query(
          "INSERT INTO work_intents(id,project_id,session_id,task_id,summary,base_commit,paths,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::integer*interval '1 second')) ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id,summary=excluded.summary,base_commit=excluded.base_commit,paths=excluded.paths,expires_at=excluded.expires_at,version=work_intents.version+1 RETURNING *",
          [
            randomUUID(),
            p,
            s,
            input.task_id ?? null,
            input.summary,
            input.base_commit ?? null,
            JSON.stringify(input.paths),
            input.ttl_seconds ?? defaults.intentTtlSeconds,
          ],
        )
      ).rows[0];
      await emit('intent.announced', { intent: row });
      return { intent_id: row.id, version: row.version, conflicts: await service.conflicts(db, p) };
    }
    case 'coord_check_conflicts': {
      if (input.intent_id) await service.reference(db, 'work_intents', input.intent_id, p);
      const conflicts = await service.conflicts(db, p);
      if (!input.intent_id) return { conflicts };
      const intent = await service.reference(db, 'work_intents', input.intent_id, p);
      return {
        conflicts: conflicts.filter(
          (c) => c.left_session === intent.session_id || c.right_session === intent.session_id,
        ),
      };
    }
    case 'coord_send_message': {
      const recipient = input.recipient;
      if (recipient.type === 'session')
        await service.checkRecipient(db, p, { session_id: recipient.id });
      if (recipient.type === 'user') await service.checkRecipient(db, p, { user_id: recipient.id });
      if (recipient.type === 'task') await service.reference(db, 'tasks', recipient.id, p);
      if (recipient.type === 'project' && recipient.id && recipient.id !== p)
        throw new CoordError('FORBIDDEN', 'Message recipient differs from project.');
      for (const ref of input.refs ?? []) {
        const found = await db.query(
          'SELECT id FROM tasks WHERE project_id=$1 AND id=$2 UNION ALL SELECT id FROM messages WHERE project_id=$1 AND id=$2 UNION ALL SELECT id FROM project_facts WHERE project_id=$1 AND id=$2 UNION ALL SELECT id FROM handoffs WHERE project_id=$1 AND id=$2 UNION ALL SELECT id FROM conflicts WHERE project_id=$1 AND id=$2',
          [p, ref],
        );
        if (!found.rowCount)
          throw new CoordError('NOT_FOUND', 'Message reference is not in this project.');
      }
      const row = (
        await db.query(
          'INSERT INTO messages(id,project_id,session_id,recipient,kind,body,refs) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [randomUUID(), p, s, recipient, input.kind, input.body, input.refs ?? []],
        )
      ).rows[0];
      await emit('message.created', { message: row });
      return { message: row };
    }
    case 'coord_record_fact': {
      if (input.provenance?.task_id)
        await service.reference(db, 'tasks', input.provenance.task_id, p);
      const row = (
        await db.query(
          'INSERT INTO project_facts(id,project_id,session_id,type,title,statement,structured,status,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            randomUUID(),
            p,
            s,
            input.type,
            input.title,
            input.statement,
            input.structured ?? null,
            input.status ?? 'proposed',
            input.provenance ?? null,
          ],
        )
      ).rows[0];
      await emit('fact.created', { fact: row });
      return { fact: row };
    }
    case 'coord_create_handoff': {
      await task();
      await service.checkRecipient(db, p, input.to);
      const held = (await db.query('SELECT * FROM task_claims WHERE task_id=$1', [input.task_id]))
        .rows[0];
      if (!held || held.session_id !== s)
        throw new CoordError(
          'CLAIM_NOT_OWNED',
          'Creating a handoff requires an active task lease.',
        );
      for (const id of input.fact_ids ?? []) await service.reference(db, 'project_facts', id, p);
      const { idempotency_key: _key, project_id: _project, ...body } = input;
      const row = (
        await db.query(
          'INSERT INTO handoffs(id,project_id,task_id,from_session_id,recipient,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [randomUUID(), p, input.task_id, s, input.to, body],
        )
      ).rows[0];
      await emit('handoff.created', { handoff: handoffView(row) });
      return { handoff: handoffView(row) };
    }
    case 'coord_accept_handoff': {
      const handoff = await service.reference(db, 'handoffs', input.handoff_id, p);
      if (handoff.status !== 'pending' || handoff.version !== input.expected_version)
        throw new CoordError(
          'STALE_VERSION',
          'Handoff was already accepted or version has changed.',
        );
      const to = handoff.recipient;
      if ((to.user_id && to.user_id !== identity.user_id) || (to.session_id && to.session_id !== s))
        throw new CoordError('FORBIDDEN', 'Handoff is addressed to another recipient.');
      const current = await service.reference(db, 'tasks', handoff.task_id, p);
      if (['done', 'cancelled'].includes(current.status))
        throw new CoordError('TASK_CLOSED', 'Closed task cannot accept handoff.');
      const held = (await db.query('SELECT * FROM task_claims WHERE task_id=$1', [handoff.task_id]))
        .rows[0];
      if (held && held.session_id !== handoff.from_session_id && held.session_id !== s)
        throw new CoordError('TASK_ALREADY_CLAIMED', 'Task is now leased to another session.');
      await db.query('DELETE FROM task_claims WHERE task_id=$1', [handoff.task_id]);
      const lease = (
        await db.query(
          "INSERT INTO task_claims(id,project_id,task_id,session_id,lease_expires_at) VALUES($1,$2,$3,$4,now()+($5::integer*interval '1 second')) RETURNING *",
          [randomUUID(), p, handoff.task_id, s, defaults.leaseSeconds],
        )
      ).rows[0];
      const row = (
        await db.query(
          "UPDATE handoffs SET status='accepted',accepted_by=$2,accepted_at=now(),version=version+1 WHERE id=$1 RETURNING *",
          [handoff.id, s],
        )
      ).rows[0];
      const updated = (
        await db.query(
          "UPDATE tasks SET status='doing',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [handoff.task_id],
        )
      ).rows[0];
      await emit('task.updated', { task: updated });
      await emit('handoff.accepted', {
        handoff: handoffView(row),
        claim_id: lease.id,
        session_id: s,
        lease_expires_at: lease.lease_expires_at,
      });
      return {
        handoff: handoffView(row),
        claim_id: lease.id,
        lease_expires_at: lease.lease_expires_at,
      };
    }
    case 'coord_heartbeat': {
      const before = (await db.query('SELECT online FROM agent_sessions WHERE id=$1', [s])).rows[0];
      await db.query('UPDATE agent_sessions SET last_seen=now(),online=true WHERE id=$1', [s]);
      if (!before.online) {
        await emit('session.online', { session_id: s, user_id: identity.user_id });
        await service.conflicts(db, p);
      }
      return { online: true };
    }
    case 'coord_observe_git': {
      const repository = (await db.query('SELECT repository_id FROM projects WHERE id=$1', [p]))
        .rows[0].repository_id;
      if (input.observation.repository_id !== repository)
        throw new CoordError(
          'REPOSITORY_MISMATCH',
          'Git observation does not match project repository.',
        );
      await db.query('UPDATE agent_sessions SET observation=$2 WHERE id=$1', [
        s,
        input.observation,
      ]);
      await emit('git.observed', { session_id: s, observation: input.observation });
      return { conflicts: await service.conflicts(db, p) };
    }
    case 'coord_end_session': {
      await db.query('UPDATE agent_sessions SET ended_at=now(),online=false WHERE id=$1', [s]);
      const released = (
        await db.query(
          'DELETE FROM task_claims WHERE project_id=$1 AND session_id=$2 RETURNING task_id',
          [p, s],
        )
      ).rows;
      for (const row of released) {
        const updated = (
          await db.query(
            "UPDATE tasks SET status='todo',version=version+1,updated_at=now() WHERE id=$1 AND status='doing' RETURNING *",
            [row.task_id],
          )
        ).rows[0];
        if (updated) await emit('task.updated', { task: updated });
      }
      await db.query('DELETE FROM work_intents WHERE project_id=$1 AND session_id=$2', [p, s]);
      await emit('session.ended', { session_id: s });
      await service.conflicts(db, p);
      return { ended: true };
    }
    default:
      throw new CoordError('UNKNOWN_OPERATION', 'Unknown coordination operation.');
  }
}
