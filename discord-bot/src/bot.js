// Entry point: builds everything and starts the bot.  npm start

import { Client, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.js';
import { createDbSource } from './dbsource.js';
import { Scores } from './scores.js';
import { GuessGames } from './games/logic.js';
import { Library } from './music/library.js';
import { MusicManager } from './music/player.js';
import { createVoiceAdapter } from './music/voice.js';
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

const source = createDbSource(config.dbPath);
const scores = new Scores(config.scoresPath);
process.on('exit', () => scores.flush());
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

let musicCtx = null;
if (config.musicEnabled) {
  const library = new Library({ dir: config.musicDir, radio: config.radio });
  musicCtx = { library, manager: new MusicManager({ createAdapter: createVoiceAdapter }) };
}

const routes = buildRoutes({ config, source, scores, guessGames: new GuessGames(), musicCtx, ai });
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (config.musicEnabled) intents.push(GatewayIntentBits.GuildVoiceStates);
// Nothing the bot says may ping anyone.
const discord = new Client({ intents, allowedMentions: { parse: [] } });
attach(discord, { routes, log });
process.on('unhandledRejection', (e) => log('unhandled_rejection', { message: String(e?.message ?? e) }));
log('starting', { ai: config.ai, music: config.musicEnabled, db: config.dbPath });
try {
  await discord.login(config.discordToken);
} catch (err) {
  console.error(`登入 Discord 失敗:${err.message}\n請檢查 DISCORD_TOKEN 是否正確(重新產生一次試試),以及這台電腦連得到 discord.com。`);
  process.exit(1);
}
