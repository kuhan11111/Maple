// A few recent exchanges per user and channel, so "那它在哪裡掉?" works as a follow-up.

export class Memory {
  constructor({ ttlMs = 10 * 60 * 1000, maxTurns = 3, now = () => Date.now() } = {}) {
    Object.assign(this, { ttlMs, maxTurns, now });
    this.map = new Map();
  }

  /** Messages in API format (alternating user / assistant), oldest first. */
  get(key) {
    const e = this.map.get(key);
    if (!e || this.now() - e.t > this.ttlMs) {
      this.map.delete(key);
      return [];
    }
    return e.turns.flatMap((x) => [
      { role: 'user', content: x.q },
      { role: 'assistant', content: x.a },
    ]);
  }

  add(key, q, a) {
    const turns = [...(this.get(key).length ? this.map.get(key).turns : []), { q, a }].slice(-this.maxTurns);
    this.map.set(key, { t: this.now(), turns });
  }

  sweep() {
    for (const k of [...this.map.keys()]) this.get(k);
  }
}
