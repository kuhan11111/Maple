// Free guide search: no AI, just a site-restricted search link for each source.

export function guideLinks(topic, sources) {
  const t = topic.trim();
  const rows = sources.map((domain) => `• [${domain}](<https://www.google.com/search?q=${encodeURIComponent(`site:${domain} Artale ${t}`)}>)`);
  return `📚 **「${t.replace(/[*_`~|>]/g, ' ')}」的攻略搜尋**\n${rows.join('\n')}\n-# 這些是各網站的站內搜尋連結,點開看結果。文章可能因版本更新而過時,請看發文日期。`;
}
