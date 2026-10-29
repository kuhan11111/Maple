// Entry point: builds the clients and starts the bot.  npm start

import { Client, GatewayIntentBits } from 'discord.js';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { createHandlers } from './handlers.js';
import { RateLimiter, Semaphore } from './limits.js';
import { Memory } from './memory.js';
import { attach } from './wiring.js';

const config = loadConfig();
const log = (event, data) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
const memory = new Memory();
setInterval(() => memory.sweep(), 5 * 60 * 1000).unref();

const handlers = createHandlers({
  config,
  client: new Anthropic({ apiKey: config.anthropicKey }),
  limiter: new RateLimiter({ perWindow: config.ratePerWindow, perDay: config.ratePerDay }),
  semaphore: new Semaphore(config.maxConcurrent),
  memory,
  log,
});

// Nothing the bot says may ping anyone.
const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], allowedMentions: { parse: [] } });
attach(discord, { handlers, config, log });
process.on('unhandledRejection', (e) => log('unhandled_rejection', { message: String(e?.message ?? e) }));
await discord.login(config.discordToken);
