// Registers the slash commands. Run once, and again whenever commands.js changes:  npm run register

import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { COMMANDS } from './commands.js';

const config = loadConfig(process.env);
const rest = new REST().setToken(config.discordToken);
const route = config.guildId ? Routes.applicationGuildCommands(config.appId, config.guildId) : Routes.applicationCommands(config.appId);
const done = await rest.put(route, { body: COMMANDS });
console.log(`已註冊 ${done.length} 個指令(${config.guildId ? `伺服器 ${config.guildId},立即生效` : '全域,最多約 1 小時生效'})`);
