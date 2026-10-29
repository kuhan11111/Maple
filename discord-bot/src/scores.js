// Per-server points for the mini games, kept in a small JSON file (or memory only when path is null).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class Scores {
  constructor(path = null, { delayMs = 1000 } = {}) {
    this.path = path;
    this.delayMs = delayMs;
    this.data = {};
    this.timer = null;
    if (path && existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        this.data = {}; // unreadable file: start over rather than crash
      }
    }
  }

  add(guildId, userId, game, points = 1) {
    const g = (this.data[guildId ??= 'dm'] ??= {});
    const u = (g[userId] ??= { points: 0, wins: {} });
    u.points += points;
    u.wins[game] = (u.wins[game] ?? 0) + 1;
    this.#queue();
    return u.points;
  }

  top(guildId, n = 10) {
    return Object.entries(this.data[guildId ?? 'dm'] ?? {})
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => b.points - a.points)
      .slice(0, n);
  }

  #queue() {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.path}.tmp`, this.path); // atomic: a crash never leaves half a file
  }
}
