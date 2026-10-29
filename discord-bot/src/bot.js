// Entry point: builds everything and starts the bot.  npm start

import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { createDbSource } from './dbsource.js';
import { Reports } from './lookup/reports.js';
import { Players } from './rpg/store.js';
import { GuessGames } from './games/logic.js';
import { SourceStore, NewsStore } from './news/store.js';
import { Refresher } from './news/refresh.js';
import { fetchText } from './news/fetch.js';
import { scheduleDaily } from './news/schedule.js';
import { digestText } from './news/render.js';
import { stripPings } from './format.js';
import { Memory } from './memory.js';
import { RateLimiter, Semaphore } from './limits.js';
import { createHandlers } from './handlers.js';
import { buildRoutes } from './routes.js';
import { attach } from './wiring.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`設定錯誤:${err.message}`);
  process.exit(1);
}
const log = (event, data) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

const reports = new Reports(config.reportsPath);
const source = createDbSource(config.dbPath, { reports });
const players = new Players(config.playersPath);
const sources = new SourceStore(config.sourcesPath);
const news = new NewsStore(config.newsPath);
const refresher = new Refresher({ sources, store: news, fetchText, minIntervalMs: config.newsMinRefreshMs, log });
const stores = [reports, players, sources, news];
process.on('exit', () => stores.forEach((s) => s.flush()));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

let ai = null;
if (config.ai) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const memory = new Memory();
  setInterval(() => memory.sweep(), 5 * 60 * 1000).unref();
  ai = createHandlers({
    config,
    client: new Anthropic({ apiKey: config.anthropicKey }),
    limiter: new RateLimiter({ perWindow: config.ratePerWindow, perDay: config.ratePerDay }),
    semaphore: new Semaphore(config.maxConcurrent),
    memory,
    log,
  });
}

const routes = buildRoutes({ config, source, reports, players, guessGames: new GuessGames(), sources, news, refresher, fetchText, ai });
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (config.channelIntel) intents.push(GatewayIntentBits.MessageContent);
// Nothing the bot says may ping anyone.
const discord = new Client({ intents, allowedMentions: { parse: [] } });
attach(discord, { routes, log });

// Every day: collect from all sources, then post what is new to the digest channel (if one is set).
async function dailyJob() {
  if (sources.sources.length) await refresher.refresh();
  const fresh = news.takeDigest();
  if (!config.newsChannelId || !fresh.length) return;
  const channel = await discord.channels.fetch(config.newsChannelId);
  await channel.send({ content: stripPings(digestText(fresh, { now: Date.now(), lastRefresh: news.lastRefresh, offsetHours: config.tzOffsetHours })), allowedMentions: { parse: [] } });
  log('news_digest', { items: fresh.length, channel: config.newsChannelId });
}

discord.once(Events.ClientReady, () => {
  scheduleDaily({ at: config.newsDailyAt, offsetHours: config.tzOffsetHours }, dailyJob, (err) => log('news_job_error', { message: err?.message }));
  // after downtime, do not wait for tomorrow
  if (sources.sources.length && (news.lastRefresh === null || Date.now() - news.lastRefresh > 20 * 3600_000)) refresher.refresh().catch((err) => log('news_job_error', { message: err?.message }));
});

process.on('unhandledRejection', (e) => log('unhandled_rejection', { message: String(e?.message ?? e) }));
log('starting', { ai: config.ai, db: config.dbPath, dailyAt: config.newsDailyAt, digestChannel: !!config.newsChannelId, channelIntel: config.channelIntel });
try {
  await discord.login(config.discordToken);
} catch (err) {
  console.error(`登入 Discord 失敗:${err.message}\n請檢查 DISCORD_TOKEN 是否正確(重新產生一次試試),以及這台電腦連得到 discord.com。`);
  process.exit(1);
}
