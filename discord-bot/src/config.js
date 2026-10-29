// Environment-driven configuration. Everything the operator may want to change lives here.

import { join } from 'node:path';
import { delayUntil } from './news/schedule.js';

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
  const newsDailyAt = env.NEWS_DAILY_AT || '06:00';
  delayUntil(newsDailyAt, 0, 0); // throws a readable error for a bad time like 25:00
  return {
    discordToken: needDiscord ? need('DISCORD_TOKEN') : env.DISCORD_TOKEN,
    appId: needDiscord ? need('DISCORD_APP_ID') : env.DISCORD_APP_ID,
    guildId: env.DISCORD_GUILD_ID || null, // set while testing: slash commands appear instantly
    anthropicKey: env.ANTHROPIC_API_KEY || null,
    ai: Boolean(env.ANTHROPIC_API_KEY), // /問答 and AI-written /攻略 need a paid API key; everything else is free
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
    dataDir: env.DATA_DIR || 'data',
    dbPath: join(env.DATA_DIR || 'data', 'db.json'),
    reportsPath: join(env.DATA_DIR || 'data', 'reports.json'),
    playersPath: join(env.DATA_DIR || 'data', 'players.json'),
    newsPath: join(env.DATA_DIR || 'data', 'news.json'),
    sourcesPath: join(env.DATA_DIR || 'data', 'news-sources.json'),
    tzOffsetHours: num(env.TZ_OFFSET_HOURS, 8, 'TZ_OFFSET_HOURS'), // Taiwan time; used for "today" and the daily schedule
    newsDailyAt,
    newsChannelId: env.NEWS_CHANNEL_ID || null, // post the daily digest here
    newsMinRefreshMs: num(env.NEWS_MIN_REFRESH_MINUTES, 30, 'NEWS_MIN_REFRESH_MINUTES') * 60_000,
    channelIntel: env.ENABLE_CHANNEL_INTEL === '1', // read registered channels as news; needs the Message Content intent
  };
}
