// Lookup results as Discord messages (plain markdown, under the 2000 character limit).
// Anything we do not know is written "(未知)" and anything only players have reported is tagged
// 〔玩家回報〕, so a half-documented new map never looks more certain than it is.

const KIND = { monster: '👾 怪物', item: '🎒 道具', map: '🗺️ 地圖' };
export const kindLabel = (k) => KIND[k] ?? k;

export const UNKNOWN = '(未知)';
const esc = (s) => String(s ?? '').replace(/([*_`~|\\])/g, '\\$1');
const pct = (r) => (r === null || r === undefined ? '' : `${+(r * 100).toFixed(r < 0.001 ? 4 : r < 0.01 ? 3 : 2)}%`);
const rateOf = (d) => esc(d.rateText || pct(d.rate) || UNKNOWN);
const num = (n) => (n === null || n === undefined ? UNKNOWN : n.toLocaleString('en-US'));
const lv = (m) => `Lv.${m.level ?? UNKNOWN}`;
const tag = (d) => (d.status === 'reported' ? ` 〔玩家回報×${d.reports}〕` : d.rateFromReports ? ' 〔機率為玩家回報〕' : '');
const WARN = '⚠️ 〔玩家回報〕是玩家分享、尚未證實;(未知) 代表還沒有資料,可用 `/回報` 補充。';
const MAX = 1900;

const foot = (db, unconfirmed) => `${unconfirmed ? `\n${WARN}` : ''}\n-# 資料:${esc(db.meta.source || '自行匯入的資料庫')}(玩家整理,可能有錯漏)`;

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
  const drops = db.dropsOf(m.id);
  const maps = m.maps.length ? m.maps.map((x) => esc(x) + (m.reportedMaps?.includes(x) ? '〔回報〕' : '')).join('、') : UNKNOWN;
  const head = `**${esc(m.name)}** ${KIND.monster}${m.status === 'reported' ? ' 〔玩家回報〕' : ''}\n${lv(m)} · HP ${num(m.hp)} · EXP ${num(m.exp)}\n📍 出沒:${maps}${m.note ? `\n📝 ${esc(m.note)}` : ''}\n`;
  const lines = drops.length ? drops.map((d) => `• ${esc(d.item.name)} — ${rateOf(d)}${tag(d)}`) : [`• ${UNKNOWN}(還沒有人整理這隻怪物的掉落,新地圖 / 新怪物常常如此)`];
  const unconfirmed = m.status === 'reported' || drops.some((d) => d.status === 'reported' || d.rateFromReports) || !!m.reportedMaps?.length;
  return fit(`${head}🎁 **掉落**\n`, lines, foot(db, unconfirmed));
}

export function renderItem(db, it) {
  const droppers = db.droppersOf(it.id);
  const head = `**${esc(it.name)}** ${KIND.item}${it.status === 'reported' ? ' 〔玩家回報〕' : ''}${it.type ? ` · ${esc(it.type)}` : ''}${it.note ? `\n📝 ${esc(it.note)}` : ''}\n`;
  const lines = droppers.length
    ? droppers.map((d) => `• ${esc(d.monster.name)} (${lv(d.monster)}) — ${rateOf(d)}${tag(d)}${d.monster.maps.length ? ` · ${d.monster.maps.slice(0, 2).map(esc).join('、')}` : ''}`)
    : [`• ${UNKNOWN}(還沒有資料說明哪隻怪會掉這個道具)`];
  const unconfirmed = it.status === 'reported' || droppers.some((d) => d.status === 'reported' || d.rateFromReports);
  return fit(`${head}🐾 **哪些怪物會掉**\n`, lines, foot(db, unconfirmed));
}

export function renderMap(db, map) {
  const ms = db.monstersIn(map);
  const unconfirmed = ms.some((m) => m.status === 'reported' || m.reportedMaps?.includes(map));
  return fit(`**${esc(map)}** ${KIND.map}\n👾 **出沒怪物**\n`, ms.map((m) => `• ${esc(m.name)} (${lv(m)})${m.status === 'reported' || m.reportedMaps?.includes(map) ? ' 〔玩家回報〕' : ''}`), foot(db, unconfirmed));
}

export function renderEntity(db, hit) {
  if (hit.kind === 'monster') return renderMonster(db, db.monsterById.get(hit.id));
  if (hit.kind === 'item') return renderItem(db, db.itemById.get(hit.id));
  return renderMap(db, hit.id);
}

export function renderSuggestions(query, results) {
  if (!results.length) return `找不到「${esc(query)}」。換個說法、少打幾個字,或確認名稱是台版譯名。這可能是新內容,有消息的話歡迎用 \`/回報\` 告訴大家。`;
  return `找不到完全符合「${esc(query)}」的,你是不是要找:\n${results.map((r) => `• ${esc(r.name)} ${KIND[r.kind]}`).join('\n')}\n\n再用名稱查一次就好(輸入時會出現選項)。`;
}

export const EMPTY_DB = '📭 資料庫還是空的。管理員請先匯入資料(見 README 的「匯入資料」);大家也可以用 `/回報` 一筆一筆補充。';
