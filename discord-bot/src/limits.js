// Cost protection: a per-user rate limit (short window + per day) and a cap on parallel lookups.

export class RateLimiter {
  constructor({ perWindow, windowMs = 10 * 60 * 1000, perDay, now = () => Date.now() }) {
    Object.assign(this, { perWindow, windowMs, perDay, now });
    this.hits = new Map(); // userId -> timestamps (ms)
  }

  /** Counts the request when allowed. Returns {ok:true} or {ok:false, reason, retryAfterMs}. */
  take(userId) {
    const t = this.now();
    const mine = (this.hits.get(userId) ?? []).filter((x) => t - x < 24 * 60 * 60 * 1000);
    const recent = mine.filter((x) => t - x < this.windowMs);
    if (this.perWindow && recent.length >= this.perWindow) {
      this.hits.set(userId, mine);
      return { ok: false, reason: 'window', retryAfterMs: recent[0] + this.windowMs - t };
    }
    if (this.perDay && mine.length >= this.perDay) {
      this.hits.set(userId, mine);
      return { ok: false, reason: 'day', retryAfterMs: mine[0] + 24 * 60 * 60 * 1000 - t };
    }
    mine.push(t);
    this.hits.set(userId, mine);
    return { ok: true };
  }
}

export class Semaphore {
  constructor(n) {
    this.free = n;
    this.queue = [];
  }

  async run(fn) {
    if (this.free > 0) this.free--;
    else await new Promise((resolve) => this.queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}
