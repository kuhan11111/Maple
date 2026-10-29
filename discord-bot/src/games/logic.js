// Game rules with no Discord in them. `rng` is any () => number in [0, 1) so tests can control luck.

export const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** "2d6+3" -> {count, sides, mod}; null if invalid or too big. */
export function parseDice(expr) {
  const m = /^\s*(\d{1,2})?\s*d\s*(\d{1,4})\s*([+-]\s*\d{1,4})?\s*$/i.exec(expr ?? '');
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const mod = m[3] ? Number(m[3].replace(/\s/g, '')) : 0;
  return count >= 1 && count <= 20 && sides >= 2 && sides <= 1000 ? { count, sides, mod } : null;
}

export function rollDice({ count, sides, mod }, rng) {
  const rolls = Array.from({ length: count }, () => int(rng, 1, sides));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) + mod };
}

export const SCROLL_RATES = [10, 30, 60, 70, 100];

/** Use `slots` scrolls with a success chance of `rate` percent each. */
export function scrollRun(rate, slots, rng) {
  const results = Array.from({ length: slots }, () => rng() * 100 < rate);
  return { results, success: results.filter(Boolean).length };
}

export const MOVES = { rock: { icon: '✊', label: '石頭', beats: 'scissors' }, paper: { icon: '✋', label: '布', beats: 'rock' }, scissors: { icon: '✌️', label: '剪刀', beats: 'paper' } };

/** 1 = a wins, -1 = b wins, 0 = draw */
export const judge = (a, b) => (a === b ? 0 : MOVES[a].beats === b ? 1 : -1);

export const GUESS_MAX = 100;
const GUESS_TTL = 30 * 60 * 1000;

/** One number-guessing game per channel. */
export class GuessGames {
  constructor({ rng = Math.random, now = () => Date.now() } = {}) {
    Object.assign(this, { rng, now });
    this.games = new Map();
  }

  status(channelId) {
    const g = this.games.get(channelId);
    if (g && this.now() - g.startedAt > GUESS_TTL) this.games.delete(channelId);
    return this.games.get(channelId) ?? null;
  }

  start(channelId) {
    this.games.set(channelId, { secret: int(this.rng, 1, GUESS_MAX), tries: 0, lo: 1, hi: GUESS_MAX, startedAt: this.now() });
  }

  /** -> {result: 'win'|'low'|'high'|'invalid', tries, lo, hi, points} */
  guess(channelId, n) {
    const g = this.status(channelId);
    if (!Number.isInteger(n) || n < 1 || n > GUESS_MAX) return { result: 'invalid' };
    if (n <= g.lo - 1 || n >= g.hi + 1) return { result: 'out', lo: g.lo, hi: g.hi }; // outside what is still possible
    g.tries++;
    if (n === g.secret) {
      this.games.delete(channelId);
      return { result: 'win', tries: g.tries, secret: n, points: g.tries <= 7 ? 3 : 1 };
    }
    if (n < g.secret) g.lo = Math.max(g.lo, n + 1);
    else g.hi = Math.min(g.hi, n - 1);
    return { result: n < g.secret ? 'low' : 'high', tries: g.tries, lo: g.lo, hi: g.hi };
  }
}

/** A "which monster drops these?" question from the database, or null if there is not enough data. */
export function makeQuiz(db, rng) {
  const pool = db.monsters.filter((m) => db.dropsOf(m.id).length >= 2);
  if (pool.length < 1 || db.monsters.length < 4) return null;
  const answer = pool[int(rng, 0, pool.length - 1)];
  const drops = shuffle(db.dropsOf(answer.id).map((d) => d.item.name), rng).slice(0, 3);
  const others = shuffle(db.monsters.filter((m) => m.id !== answer.id), rng).slice(0, 3);
  const options = shuffle([answer, ...others], rng).map((m) => m.name);
  return { drops, options, answerIndex: options.indexOf(answer.name), answer: answer.name };
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = int(rng, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
