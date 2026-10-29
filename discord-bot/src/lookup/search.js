// Forgiving name search: exact, alias, prefix, substring, and typo-tolerant (character bigrams,
// which suits Chinese names). Returns the best matches across monsters, items and maps.

export const norm = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·・.,，。!！?？'"「」『』()（）[\]【】:：;；/\\]/g, '');

const bigrams = (s) => {
  const out = new Map();
  const grams = s.length < 2 ? [s] : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2));
  for (const g of grams) out.set(g, (out.get(g) ?? 0) + 1);
  return out;
};

/** Sørensen-Dice on character bigrams, 0..1 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) ?? 0);
  return (2 * hit) / (Math.max(a.length - 1, 1) + Math.max(b.length - 1, 1));
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Typo tolerance: bigram overlap, or - for names of 3+ characters - a single (or, for long names, double) wrong character. */
function fuzzy(q, n) {
  const dice = similarity(q, n);
  const longest = Math.max(q.length, n.length);
  const d = distance(q, n);
  const edit = Math.min(q.length, n.length) >= 3 && d <= (longest >= 6 ? 2 : 1) ? 1 - d / longest : 0;
  return Math.max(dice, edit);
}

function score(q, names) {
  let best = { score: 0, match: null };
  for (const [i, raw] of names.entries()) {
    const n = norm(raw);
    if (!n) continue;
    let s = 0;
    let match;
    if (n === q) [s, match] = [i === 0 ? 1 : 0.97, i === 0 ? 'exact' : 'alias'];
    else if (n.startsWith(q)) [s, match] = [0.85 + 0.1 * (q.length / n.length), 'prefix'];
    else if (n.includes(q)) [s, match] = [0.7 + 0.15 * (q.length / n.length), 'contains'];
    else if (q.includes(n) && n.length >= 2) [s, match] = [0.6 + 0.1 * (n.length / q.length), 'contains'];
    else {
      const f = fuzzy(q, n);
      if (f >= 0.5) [s, match] = [f * 0.7, 'fuzzy'];
    }
    if (s > best.score) best = { score: s, match };
  }
  return best;
}

export class Index {
  constructor(db) {
    this.db = db;
    this.entries = [
      ...db.monsters.map((e) => ({ kind: 'monster', id: e.id, name: e.name, names: [e.name, ...(e.aliases ?? [])] })),
      ...db.items.map((e) => ({ kind: 'item', id: e.id, name: e.name, names: [e.name, ...(e.aliases ?? [])] })),
      ...db.maps.map((m) => ({ kind: 'map', id: m, name: m, names: [m] })),
    ];
  }

  search(query, { kinds = null, limit = 5, min = 0.35 } = {}) {
    const q = norm(query);
    if (!q) return [];
    return this.entries
      .filter((e) => !kinds || kinds.includes(e.kind))
      .map((e) => ({ ...e, ...score(q, e.names) }))
      .filter((r) => r.score >= min)
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
      .slice(0, limit);
  }

  /** Entries to offer when nothing has been typed yet (autocomplete), most-connected first. */
  browse({ kinds = null, limit = 25 } = {}) {
    return this.entries.filter((e) => !kinds || kinds.includes(e.kind)).slice(0, limit).map((e) => ({ ...e, score: 1, match: 'browse' }));
  }

  /** The single clear winner if there is one: strong match with a gap to the runner-up. */
  best(query, opts) {
    const r = this.search(query, { ...opts, limit: 6 });
    if (!r.length) return { hit: null, others: [] };
    const [top, second] = r;
    const clear = top.score >= 0.85 && (!second || top.score - second.score >= 0.1 || top.score >= 0.97);
    return clear ? { hit: top, others: r.slice(1) } : { hit: null, others: r };
  }
}
