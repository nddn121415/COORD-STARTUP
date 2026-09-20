import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { factInputSchema, handoffInputSchema } from './index.js';
it('validates structured fact provenance and credential filtering', () => {
  const fact = {
    idempotency_key: 'fact-1',
    type: 'decision',
    title: 'Avatar storage',
    statement: 'Use object storage',
    provenance: { task_id: randomUUID(), paths: ['src/avatar.ts'] },
  };
  expect(factInputSchema.parse(fact).status).toBe('proposed');
  expect(
    factInputSchema.safeParse({ ...fact, provenance: { paths: ['../../private'] } }).success,
  ).toBe(false);
  expect(
    factInputSchema.safeParse({ ...fact, structured: { token: 'sk-' + 'a'.repeat(32) } }).success,
  ).toBe(false);
});
it('requires exactly one handoff recipient and bounds lists', () => {
  const h = {
    idempotency_key: 'h',
    task_id: randomUUID(),
    to: { session_id: randomUUID() },
    summary: 'Profile fields done',
  };
  expect(handoffInputSchema.parse(h).completed).toEqual([]);
  expect(handoffInputSchema.safeParse({ ...h, to: {} }).success).toBe(false);
  expect(
    handoffInputSchema.safeParse({ ...h, to: { session_id: randomUUID(), user_id: randomUUID() } })
      .success,
  ).toBe(false);
  expect(handoffInputSchema.safeParse({ ...h, completed: Array(101).fill('x') }).success).toBe(
    false,
  );
});
