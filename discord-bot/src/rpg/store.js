// Player profiles, per server, kept in data/players.json.

import { JsonFile, readJson } from '../jsonfile.js';
import { START_MESOS } from './logic.js';

const fresh = () => ({ level: 1, exp: 0, mesos: START_MESOS, items: {}, hunts: 0, wins: 0, losses: 0, lastHunt: 0, lastGamble: 0, lastDaily: '', streak: 0, gambleWon: 0, gambleLost: 0, minigames: {} });

export class Players extends JsonFile {
  constructor(path = null) {
    super(path);
    this.guilds = readJson(path, {});
  }

  data() {
    return this.guilds;
  }

  /** The profile for (server, user), created on first use. Mutate it, then call save(). */
  get(guildId, userId) {
    const g = (this.guilds[guildId ?? 'dm'] ??= {});
    const cur = (g[userId] ??= fresh());
    for (const [k, v] of Object.entries(fresh())) if (!(k in cur)) cur[k] = v; // older saves gain new fields; the object itself stays the same
    return cur;
  }

  save() {
    this.queue();
  }

  /** A mini game win pays out mesos. */
  reward(guildId, userId, game, mesos) {
    const p = this.get(guildId, userId);
    p.mesos += mesos;
    p.minigames[game] = (p.minigames[game] ?? 0) + 1;
    this.save();
    return p.mesos;
  }

  /** Highest level first, then exp. */
  top(guildId, n = 10) {
    return Object.entries(this.guilds[guildId ?? 'dm'] ?? {})
      .map(([userId, p]) => ({ userId, ...p }))
      .sort((a, b) => b.level - a.level || b.exp - a.exp || b.mesos - a.mesos)
      .slice(0, n);
  }
}
