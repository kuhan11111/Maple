// Registers the slash commands. Run once, and again whenever the configuration or commands change:
//   npm run register

import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { buildCommands } from './commands.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`設定錯誤:${err.message}`);
  process.exit(1);
}
const commands = buildCommands(config);
const rest = new REST().setToken(config.discordToken);
const route = config.guildId ? Routes.applicationGuildCommands(config.appId, config.guildId) : Routes.applicationCommands(config.appId);
let done;
try {
  done = await rest.put(route, { body: commands });
} catch (err) {
  console.error(`註冊指令失敗:${err.message}\n請檢查 DISCORD_TOKEN、DISCORD_APP_ID(以及 DISCORD_GUILD_ID,若有填)是否正確。`);
  process.exit(1);
}
console.log(`已註冊 ${done.length} 個指令:${done.map((c) => `/${c.name}`).join(' ')}\n(${config.guildId ? `伺服器 ${config.guildId},立即生效` : '全域,最多約 1 小時生效'};AI 指令 ${config.ai ? '已啟用' : '未啟用(沒有 ANTHROPIC_API_KEY)'},音樂 ${config.musicEnabled ? '已啟用' : '未啟用'})`);
