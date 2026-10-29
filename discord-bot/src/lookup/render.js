// Lookup results as Discord messages (plain markdown, under the 2000 character limit).

const KIND = { monster: '👾 怪物', item: '🎒 道具', map: '🗺️ 地圖' };
export const kindLabel = (k) => KIND[k] ?? k;

const pct = (r) => (r === null || r === undefined ? '' : `${+(r * 100).toFixed(r < 0.001 ? 4 : r < 0.01 ? 3 : 2)}%`);
const rateOf = (d) => d.rateText || pct(d.rate) || '機率不詳';
const foot = (db) => `\n-# 資料:${db.meta.source || '自行匯入的資料庫'}(玩家整理,可能有錯漏)`;
const MAX = 1900;

function fit(head, lines, tail, more = (n) => `…還有 ${n} 筆`) {
  let body = lines.join('\n');
  if ((head + body + tail).length > MAX) {
    const kept = [];
    let len = head.length + tail.length + 40;
    for (const l of lines) {
      if (len + l.length + 1 > MAX) break;
      kept.push(l);
      len += l.length + 1;
    }
    body = kept.join('\n') + (kept.length < lines.length ? `\n${more(lines.length - kept.length)}` : '');
  }
  return head + body + tail;
}

export function renderMonster(db, m) {
  const stats = [m.level !== null && `Lv.${m.level}`, m.hp !== null && `HP ${m.hp.toLocaleString('en-US')}`, m.exp !== null && `EXP ${m.exp.toLocaleString('en-US')}`].filter(Boolean).join(' · ');
  const drops = db.dropsOf(m.id);
  const head = `**${m.name}** ${KIND.monster}${stats ? `\n${stats}` : ''}${m.maps.length ? `\n📍 出沒:${m.maps.join('、')}` : ''}${m.note ? `\n📝 ${m.note}` : ''}\n`;
  const lines = drops.length ? drops.map((d) => `• ${d.item.name} — ${rateOf(d)}`) : ['(資料庫裡沒有這隻怪物的掉落資料)'];
  return fit(`${head}🎁 **掉落**\n`, lines, foot(db));
}

export function renderItem(db, it) {
  const droppers = db.droppersOf(it.id);
  const head = `**${it.name}** ${KIND.item}${it.type ? ` · ${it.type}` : ''}${it.note ? `\n📝 ${it.note}` : ''}\n`;
  const lines = droppers.length
    ? droppers.map((d) => `• ${d.monster.name}${d.monster.level !== null ? ` (Lv.${d.monster.level})` : ''} — ${rateOf(d)}${d.monster.maps.length ? ` · ${d.monster.maps.slice(0, 2).join('、')}` : ''}`)
    : ['(資料庫裡沒有哪隻怪物掉這個道具)'];
  return fit(`${head}🐾 **哪些怪物會掉**\n`, lines, foot(db));
}

export function renderMap(db, map) {
  const ms = db.monstersIn(map);
  return fit(`**${map}** ${KIND.map}\n👾 **出沒怪物**\n`, ms.map((m) => `• ${m.name}${m.level !== null ? ` (Lv.${m.level})` : ''}`), foot(db));
}

export function renderEntity(db, hit) {
  if (hit.kind === 'monster') return renderMonster(db, db.monsterById.get(hit.id));
  if (hit.kind === 'item') return renderItem(db, db.itemById.get(hit.id));
  return renderMap(db, hit.id);
}

export function renderSuggestions(query, results) {
  if (!results.length) return `找不到「${query}」。換個說法、少打幾個字,或確認名稱是台版譯名。`;
  return `找不到完全符合「${query}」的,你是不是要找:\n${results.map((r) => `• ${r.name} ${KIND[r.kind]}`).join('\n')}\n\n再用名稱查一次就好(輸入時會出現選項)。`;
}

export const EMPTY_DB = '📭 資料庫還是空的。管理員請先匯入資料(見 README 的「匯入資料」),再用 `/drop` 查詢。';
