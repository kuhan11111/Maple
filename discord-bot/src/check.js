// Quick end-to-end self test without Discord:  npm run check -- "肥肥頭掉什麼?"
// Verifies the API key, that web search is enabled, and what the bot finds on the configured sites.

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { ask, buildTools } from './agent.js';
import { buildSystem, KINDS } from './prompt.js';
import { friendly } from './handlers.js';

let config;
try {
  config = loadConfig(process.env, { needDiscord: false });
  if (!config.ai) throw new Error('沒有設定 ANTHROPIC_API_KEY。這個檢查只用來測試選用的 AI 功能;免費的查表 / 情報 / 遊戲功能不需要它。');
} catch (err) {
  console.error(`設定錯誤:${err.message}`);
  process.exit(1);
}
const question = process.argv.slice(2).join(' ').trim() || '肥肥頭會掉什麼?在哪裡可以打?';
console.log(`模型:${config.model}\n查詢網站:${config.sources.join('、')}\n問題:${question}\n`);

const started = Date.now();
try {
  const r = await ask({
    client: new Anthropic({ apiKey: config.anthropicKey }),
    model: config.model,
    system: buildSystem(config),
    tools: buildTools(config),
    messages: [{ role: 'user', content: KINDS.ask(question) }],
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  });
  console.log(r.text, '\n');
  console.log(r.sources.length ? `來源:\n${r.sources.map((s) => `  - ${s.title}  ${s.url}`).join('\n')}` : '來源:(沒有引用任何網頁)');
  const { input, output, searches, fetches } = r.usage;
  console.log(`\n用量:輸入 ${input} / 輸出 ${output} tokens,搜尋 ${searches} 次,讀取網頁 ${fetches} 次,${((Date.now() - started) / 1000).toFixed(1)} 秒`);
  if (!searches && !fetches) console.log('⚠ 這次沒有用到網頁搜尋 / 讀取,答案可能只是模型的記憶,請檢查 Anthropic Console 是否啟用了 web search。');
} catch (err) {
  console.error(`失敗:${friendly(err)}\n(原始錯誤:${err?.status ?? ''} ${err?.message})`);
  process.exitCode = 1;
}
