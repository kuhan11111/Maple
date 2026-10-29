// Environment-driven configuration. Everything the operator may want to change lives here.

// Sites the bot may search. Edit with ARTALE_SOURCES (comma separated, no https://).
export const DEFAULT_SOURCES = ['artalemaplestory.com', 'forum.gamer.com.tw', 'dcard.tw', 'ptt.cc', 'uptogo.com.tw'];
// The subset that holds structured drop / monster / map data.
export const DEFAULT_DB_DOMAINS = ['artalemaplestory.com'];

export function normalizeDomain(s) {
  const d = String(s).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!d || /\s/.test(d) || !/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(d)) throw new Error(`網域格式不對:「${s}」(例如 example.com,不要加 https://)`);
  return d.toLowerCase();
}

const list = (v, fallback) => (v && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : fallback);
const num = (v, fallback, name) => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`環境變數 ${name} 必須是數字`);
  return n;
};

export function loadConfig(env = process.env, { needDiscord = true } = {}) {
  const need = (k) => {
    if (!env[k]) throw new Error(`缺少環境變數 ${k}(參考 .env.example)`);
    return env[k];
  };
  const sources = list(env.ARTALE_SOURCES, DEFAULT_SOURCES).map(normalizeDomain);
  const dbDomains = list(env.ARTALE_DB_DOMAINS, DEFAULT_DB_DOMAINS).map(normalizeDomain);
  return {
    discordToken: needDiscord ? need('DISCORD_TOKEN') : env.DISCORD_TOKEN,
    appId: needDiscord ? need('DISCORD_APP_ID') : env.DISCORD_APP_ID,
    guildId: env.DISCORD_GUILD_ID || null, // set while testing: slash commands appear instantly
    anthropicKey: need('ANTHROPIC_API_KEY'),
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    sources,
    dbDomains,
    maxSearches: num(env.MAX_SEARCHES, 3, 'MAX_SEARCHES'),
    maxFetches: num(env.MAX_FETCHES, 3, 'MAX_FETCHES'),
    maxTokens: num(env.MAX_OUTPUT_TOKENS, 1500, 'MAX_OUTPUT_TOKENS'),
    maxContentTokens: num(env.MAX_PAGE_TOKENS, 12000, 'MAX_PAGE_TOKENS'),
    timeoutMs: num(env.REQUEST_TIMEOUT_SECONDS, 90, 'REQUEST_TIMEOUT_SECONDS') * 1000,
    ratePerWindow: num(env.RATE_LIMIT_PER_10_MIN, 5, 'RATE_LIMIT_PER_10_MIN'),
    ratePerDay: num(env.RATE_LIMIT_PER_DAY, 40, 'RATE_LIMIT_PER_DAY'),
    maxConcurrent: Math.max(1, num(env.MAX_CONCURRENT, 3, 'MAX_CONCURRENT')),
    allowedChannels: list(env.ALLOWED_CHANNEL_IDS, []),
  };
}
