// The rules of the little Maple-style game: hunt monsters, level up, sell loot, gamble with mesos.
// All values are game balance, not Artale data. `rng` is any () => number in [0, 1).

export const MAX_LEVEL = 200;
export const HUNT_COOLDOWN_MS = 15_000;
export const GAMBLE_COOLDOWN_MS = 4_000;
export const MIN_BET = 10;
export const MAX_BET = 50_000;
export const START_MESOS = 300;

const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const expNeeded = (level) => 50 + 25 * level * level;

// Used when no database is imported yet, so the game works out of the box.
export const BUILTIN_MONSTERS = [
  { name: '綠水靈', level: 1, drops: [{ name: '黏液', rate: 0.5 }, { name: '楓葉', rate: 0.05 }] },
  { name: '藍蝸牛', level: 2, drops: [{ name: '藍殼', rate: 0.45 }, { name: '楓葉', rate: 0.05 }] },
  { name: '紅蝸牛', level: 4, drops: [{ name: '紅殼', rate: 0.4 }, { name: '楓葉', rate: 0.06 }] },
  { name: '菇菇仔', level: 8, drops: [{ name: '菇菇傘', rate: 0.4 }, { name: '小補血藥', rate: 0.1 }] },
  { name: '木妖', level: 15, drops: [{ name: '樹枝', rate: 0.4 }, { name: '木妖核心', rate: 0.03 }] },
  { name: '石頭人', level: 25, drops: [{ name: '石塊', rate: 0.4 }, { name: '堅硬石頭', rate: 0.02 }] },
  { name: '殭屍菇菇', level: 35, drops: [{ name: '腐爛的傘', rate: 0.35 }, { name: '黑暗水晶', rate: 0.01 }] },
  { name: '火獨眼獸', level: 48, drops: [{ name: '火焰碎片', rate: 0.3 }, { name: '獨眼獸之眼', rate: 0.02 }] },
  { name: '黑暗石頭人', level: 62, drops: [{ name: '暗黑石塊', rate: 0.3 }, { name: '黑暗核心', rate: 0.008 }] },
];
export const BUILTIN_PRICES = { 黏液: 8, 楓葉: 90, 藍殼: 12, 紅殼: 18, 菇菇傘: 30, 小補血藥: 60, 樹枝: 45, 木妖核心: 600, 石塊: 70, 堅硬石頭: 1200, 腐爛的傘: 110, 黑暗水晶: 4000, 火焰碎片: 220, 獨眼獸之眼: 3200, 暗黑石塊: 400, 黑暗核心: 9000 };

/** The monster list the game draws from: the imported database when it has levels, else the built-in one. */
export function monsterSource(db) {
  const real = db.monsters.filter((m) => Number.isFinite(m.level));
  if (!real.length) return BUILTIN_MONSTERS.map((m) => ({ ...m, id: m.name, exp: null }));
  return real.map((m) => ({
    id: m.id,
    name: m.name,
    level: m.level,
    exp: m.exp ?? null,
    drops: db.dropsOf(m.id).map((d) => ({ name: d.item.name, rate: d.rate })),
  }));
}

/** Who you can meet at this level: a window around your level, or the closest few if the window is empty. */
export function monsterPool(monsters, level) {
  const near = monsters.filter((m) => m.level >= level - 6 && m.level <= level + 4);
  if (near.length) return near;
  return monsters.slice().sort((a, b) => Math.abs(a.level - level) - Math.abs(b.level - level)).slice(0, 3);
}

export const winChance = (playerLevel, monsterLevel) => clamp(0.55 + 0.07 * (playerLevel - monsterLevel), 0.08, 0.97);

/** Fight one monster. Pure: returns what happened, the caller applies it. */
export function resolveHunt(player, monster, rng) {
  if (rng() >= winChance(player.level, monster.level)) {
    return { won: false, exp: -Math.min(player.exp, Math.round(expNeeded(player.level) * 0.05)) || 0, mesos: 0, drops: [] };
  }
  const exp = monster.exp ?? Math.round(6 + monster.level ** 1.7);
  const mesos = int(rng, monster.level * 4, monster.level * 10) + 5;
  const drops = [];
  for (const d of monster.drops) if (drops.length < 5 && rng() < (d.rate ?? 0.03)) drops.push(d.name);
  return { won: true, exp, mesos, drops };
}

/** Adds exp and applies level ups. Returns the number of levels gained. */
export function gainExp(player, exp) {
  player.exp = Math.max(0, player.exp + exp);
  let ups = 0;
  while (player.level < MAX_LEVEL && player.exp >= expNeeded(player.level)) {
    player.exp -= expNeeded(player.level);
    player.level++;
    ups++;
  }
  if (player.level >= MAX_LEVEL) player.exp = 0;
  return ups;
}

/** What a shop pays for one: rarer drops are worth more; unknown rates get a default. */
export function priceOf(name, db) {
  if (BUILTIN_PRICES[name] !== undefined && !db.monsters.some((m) => Number.isFinite(m.level))) return BUILTIN_PRICES[name];
  const item = db.items.find((i) => i.name === name);
  const rates = item ? db.droppersOf(item.id).map((d) => d.rate).filter((r) => r > 0) : [];
  if (!rates.length) return BUILTIN_PRICES[name] ?? 40;
  return clamp(Math.round(6 / Math.max(...rates)), 5, 80_000);
}

export const dayKey = (now, offsetHours = 8) => new Date(now + offsetHours * 3600_000).toISOString().slice(0, 10);

/** Daily check-in: -> {ok:false} if already done today, else {ok:true, streak, mesos}. */
export function checkIn(player, now, offsetHours = 8) {
  const today = dayKey(now, offsetHours);
  if (player.lastDaily === today) return { ok: false };
  const streak = player.lastDaily === dayKey(now - 86400_000, offsetHours) ? player.streak + 1 : 1;
  const mesos = 500 + 100 * Math.min(streak, 7) + player.level * 20;
  Object.assign(player, { lastDaily: today, streak });
  player.mesos += mesos;
  return { ok: true, streak, mesos };
}

// ---- gambling (virtual mesos only) -------------------------------------------------------

/** Two dice, bet big (8-12) or small (2-6). A 7 loses for both. Pays 1:1. */
export function diceGamble(bet, side, rng) {
  const a = int(rng, 1, 6);
  const b = int(rng, 1, 6);
  const total = a + b;
  const won = (side === 'big' && total >= 8) || (side === 'small' && total <= 6);
  return { dice: [a, b], total, won, delta: won ? bet : -bet };
}

export const SLOT_SYMBOLS = [
  { icon: '🍒', weight: 30 },
  { icon: '🍋', weight: 30 },
  { icon: '🔔', weight: 20 },
  { icon: '💎', weight: 12 },
  { icon: '7️⃣', weight: 8 },
];
export const SLOT_TRIPLE = { '🍒': 4, '🍋': 6, '🔔': 12, '💎': 40, '7️⃣': 150 };
export const SLOT_TWO_CHERRIES = 2;

export function slotPayout(reels) {
  if (reels[0] === reels[1] && reels[1] === reels[2]) return SLOT_TRIPLE[reels[0]];
  return reels.filter((r) => r === '🍒').length === 2 ? SLOT_TWO_CHERRIES : 0;
}

export function slotGamble(bet, rng) {
  const total = SLOT_SYMBOLS.reduce((a, s) => a + s.weight, 0);
  const spin = () => {
    let r = rng() * total;
    for (const s of SLOT_SYMBOLS) if ((r -= s.weight) < 0) return s.icon;
    return SLOT_SYMBOLS.at(-1).icon;
  };
  const reels = [spin(), spin(), spin()];
  const mult = slotPayout(reels);
  return { reels, mult, delta: bet * mult - bet };
}

export const bar = (frac, width = 10) => '█'.repeat(Math.round(clamp(frac, 0, 1) * width)).padEnd(width, '░');
