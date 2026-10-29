// The /更新情報 message.

const esc = (s) => String(s).replace(/[[\]]/g, ' ').replace(/([*_`~|\\])/g, '\\$1').replace(/\s+/g, ' ').trim();

/** "12 分鐘前" / "3 小時前" / "昨天" / "10/28" in a zone `offsetHours` ahead of UTC. */
export function ago(then, now, offsetHours = 8) {
  const d = now - then;
  if (d < 60_000) return '剛剛';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分鐘前`;
  if (d < 24 * 3600_000) return `${Math.floor(d / 3600_000)} 小時前`;
  const day = (t) => Math.floor((t + offsetHours * 3600_000) / 86400_000);
  if (day(now) - day(then) === 1) return '昨天';
  const l = new Date(then + offsetHours * 3600_000);
  return `${l.getUTCMonth() + 1}/${l.getUTCDate()}`;
}

const MAX = 1900;

export function renderNews(items, { now, lastRefresh = null, offsetHours = 8, source = null }) {
  const lines = items.map((i) => `• [${esc(i.title).slice(0, 90)}](<${i.url}>) — ${esc(i.source)} · ${ago(i.publishedAt ?? i.firstSeen, now, offsetHours)}${i.publishedAt ? '' : '(收錄時間)'}`);
  const when = lastRefresh ? `,更新於 ${ago(lastRefresh, now, offsetHours)}` : '';
  const head = `📰 **Artale 最新情報**${source ? `(${esc(source)})` : ''}${when}\n`;
  const tail = '\n-# 情報來自各網站與頻道的公開內容,點連結看原文;可能不完整,也可能有玩家的猜測。';
  const kept = [];
  let len = head.length + tail.length + 30;
  for (const l of lines) {
    if (len + l.length + 1 > MAX) break;
    kept.push(l);
    len += l.length + 1;
  }
  if (kept.length < lines.length) kept.push(`…還有 ${lines.length - kept.length} 則`);
  return head + kept.join('\n') + tail;
}

export const digestText = (items, opts) => renderNews(items, opts).replace('最新情報', '今日情報');

export const NO_SOURCES = '📭 還沒有設定情報來源。管理員可以用 `/情報來源 新增` 加入網站(RSS 或論壇看板網址)。';
export const NO_ITEMS = '📭 目前還沒有收集到情報。可能是來源剛加入、還沒抓到,或這些網站暫時抓不到(管理員可用 `/情報來源 測試` 檢查)。';
