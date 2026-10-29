// Turning a model answer into Discord messages.

export const DISCORD_LIMIT = 2000;

/** Defang @everyone / @here and user / role mentions so an answer can never ping anyone. */
export function stripPings(text) {
  return text.replace(/@(everyone|here)/gi, '@​$1').replace(/<(@[!&]?|#)(\d+)>/g, '<$1​$2>');
}

const safeUrl = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

export function sourcesFooter(sources, max = 5) {
  const lines = [];
  for (const s of sources.slice(0, max)) {
    const url = safeUrl(s.url);
    if (!url) continue;
    const title = String(s.title || new URL(url).hostname).replace(/[[\]\s]+/g, ' ').trim().slice(0, 60);
    lines.push(`• [${title}](<${url}>)`); // <> keeps Discord from expanding a preview for each link
  }
  return lines.length ? `\n\n📚 **來源**\n${lines.join('\n')}` : '';
}

/** Split on paragraph, then line, then space boundaries so no message exceeds the limit. */
export function splitMessage(text, limit = DISCORD_LIMIT - 100) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = Math.max(rest.lastIndexOf('\n\n', limit), 0);
    if (cut < limit * 0.4) cut = Math.max(rest.lastIndexOf('\n', limit), 0);
    if (cut < limit * 0.4) cut = Math.max(rest.lastIndexOf(' ', limit), 0);
    if (cut < limit * 0.4) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function render({ text, sources }) {
  return splitMessage(stripPings(text) + sourcesFooter(sources));
}
