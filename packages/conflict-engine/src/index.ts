import type { IntentPath } from '@coord/protocol';

export interface EffectiveWork {
  session_id: string;
  task_id?: string;
  paths: IntentPath[];
  source?: 'intent' | 'git';
}
export interface ConflictCandidate {
  left_session: string;
  right_session: string;
  left_task?: string;
  right_task?: string;
  path: string;
  type: string;
  severity: 'info' | 'warning' | 'high';
  evidence: Record<string, unknown>;
}
export interface ConflictAnalyzer {
  analyze(work: EffectiveWork[]): ConflictCandidate[];
}
type Entry = {
  mode: IntentPath['mode'];
  task_id?: string;
  source: string;
  from_path?: string;
  to_path?: string;
};
const severityRank = { info: 0, warning: 1, high: 2 };
function classify(a: Entry, b: Entry): Pick<ConflictCandidate, 'type' | 'severity'> | null {
  if (a.mode === 'read' && b.mode === 'read') return null;
  if (a.mode === 'read' || b.mode === 'read') return { type: 'read_write', severity: 'info' };
  if (a.mode === 'rename' || b.mode === 'rename')
    return { type: 'rename_overlap', severity: 'high' };
  if (a.mode === 'delete' || b.mode === 'delete')
    return { type: 'delete_overlap', severity: 'high' };
  if (a.mode === 'create' && b.mode === 'create')
    return { type: 'create_collision', severity: 'high' };
  return { type: 'write_overlap', severity: 'warning' };
}
/** Pure, deterministic analyzer. Paths are validated at the protocol boundary. */
export class FileConflictAnalyzer implements ConflictAnalyzer {
  analyze(work: EffectiveWork[]): ConflictCandidate[] {
    const files = new Map<string, Map<string, Entry[]>>();
    for (const item of work) {
      for (const path of item.paths) {
        for (const name of new Set([
          path.path,
          ...(path.mode === 'rename' && path.from_path ? [path.from_path] : []),
        ])) {
          let sessions = files.get(name);
          if (!sessions) files.set(name, (sessions = new Map()));
          const entries = sessions.get(item.session_id) ?? [];
          entries.push({
            mode: path.mode,
            task_id: item.task_id,
            source: item.source ?? 'intent',
            ...(path.from_path ? { from_path: path.from_path, to_path: path.path } : {}),
          });
          sessions.set(item.session_id, entries);
        }
      }
    }
    const result: ConflictCandidate[] = [];
    for (const [path, sessions] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const ids = [...sessions.keys()].sort();
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          let chosen: ConflictCandidate | undefined;
          const leftEntries = sessions
            .get(ids[i])!
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          const rightEntries = sessions
            .get(ids[j])!
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          for (const a of leftEntries)
            for (const b of rightEntries) {
              const match = classify(a, b);
              if (!match) continue;
              const candidate: ConflictCandidate = {
                left_session: ids[i],
                right_session: ids[j],
                ...(a.task_id ? { left_task: a.task_id } : {}),
                ...(b.task_id ? { right_task: b.task_id } : {}),
                path,
                ...match,
                evidence: { left: a, right: b },
              };
              if (
                !chosen ||
                severityRank[candidate.severity] > severityRank[chosen.severity] ||
                (candidate.severity === chosen.severity &&
                  JSON.stringify(candidate) < JSON.stringify(chosen))
              )
                chosen = candidate;
            }
          if (chosen) result.push(chosen);
        }
    }
    return result;
  }
}
