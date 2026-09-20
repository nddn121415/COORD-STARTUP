import { describe, expect, it } from 'vitest';
import { FileConflictAnalyzer, type EffectiveWork } from './index.js';
import type { IntentPath } from '@coord/protocol';
const engine = new FileConflictAnalyzer();
const work = (
  session_id: string,
  mode: IntentPath['mode'],
  path = 'src/user.ts',
  from_path?: string,
): EffectiveWork => ({ session_id, paths: [{ mode, path, ...(from_path ? { from_path } : {}) }] });
describe('deterministic file conflicts', () => {
  it.each([
    ['modify', 'modify', 'warning'],
    ['delete', 'modify', 'high'],
    ['create', 'create', 'high'],
    ['read', 'modify', 'info'],
  ] as const)('%s + %s => %s', (a, b, severity) => {
    expect(engine.analyze([work('a', a), work('b', b)])[0]).toMatchObject({
      path: 'src/user.ts',
      severity,
    });
  });
  it('rename overlaps both original and destination', () => {
    const conflicts = engine.analyze([
      work('a', 'rename', 'src/new.ts', 'src/old.ts'),
      work('b', 'modify', 'src/old.ts'),
      work('c', 'modify', 'src/new.ts'),
    ]);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.every((c) => c.severity === 'high')).toBe(true);
  });
  it('ignores unrelated paths, read/read and same session overlap', () => {
    expect(
      engine.analyze([work('a', 'read'), work('b', 'read'), work('c', 'modify', 'other.ts')]),
    ).toEqual([]);
    expect(engine.analyze([work('a', 'modify'), work('a', 'delete')])).toEqual([]);
  });
  it('unions observation and intention with highest severity, no duplicate', () => {
    const input = [
      work('b', 'modify'),
      work('a', 'read'),
      { ...work('a', 'delete'), source: 'git' as const },
    ];
    expect(engine.analyze(input)).toHaveLength(1);
    expect(engine.analyze(input)[0].severity).toBe('high');
    expect(engine.analyze(input)).toEqual(engine.analyze([...input].reverse()));
  });
});
