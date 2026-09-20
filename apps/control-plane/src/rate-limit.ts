import { CoordError } from '@coord/protocol';
/** Bounded, per-process fixed-window limiter. Shared deployments also need edge limits. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; expires: number }>();
  constructor(
    readonly limit = 300,
    readonly windowMs = 60_000,
    readonly maxKeys = 10_000,
  ) {}
  take(key: string, now = Date.now()): void {
    let window = this.windows.get(key);
    if (!window || window.expires <= now) {
      for (const [id, value] of this.windows) if (value.expires <= now) this.windows.delete(id);
      if (this.windows.size >= this.maxKeys)
        throw new CoordError('RATE_LIMITED', 'Server is busy; retry after one minute.');
      window = { count: 0, expires: now + this.windowMs };
      this.windows.set(key, window);
    }
    if (++window.count > this.limit)
      throw new CoordError('RATE_LIMITED', 'Request rate exceeded; retry after one minute.');
  }
}
