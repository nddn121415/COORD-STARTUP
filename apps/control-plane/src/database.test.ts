import { describe, expect, it } from 'vitest';
import { canonical, tokenHash } from './database.js';
import { publicError } from './server.js';
describe('safe protocol helpers', () => {
  it('canonicalizes nested object order but preserves array order', () => {
    expect(canonical({ b: [{ y: 2, x: 1 }], a: 1 })).toBe(canonical({ a: 1, b: [{ x: 1, y: 2 }] }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
  it('stores only one-way token hashes and does not expose database errors', () => {
    expect(tokenHash('private-token')).toHaveLength(64);
    expect(publicError(new Error('postgres password=private-token'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Coordination request failed. Try again with the same idempotency key.',
    });
  });
});

import { RateLimiter } from './rate-limit.js';
it('rate limits serial requests and bounds client tracking', () => {
  const limiter = new RateLimiter(2, 100, 1);
  limiter.take('a', 1);
  limiter.take('a', 2);
  expect(() => limiter.take('a', 3)).toThrow(/rate exceeded/);
  expect(() => limiter.take('b', 3)).toThrow(/busy/);
  expect(() => limiter.take('b', 102)).not.toThrow();
});
