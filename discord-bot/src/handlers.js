// The bot's behaviour with Discord stripped away: admit a request, ask the model, render the
// reply. bot.js only moves messages in and out, which keeps this part testable.

import { ask, buildTools, EmptyAnswerError } from './agent.js';
import { buildSystem, KINDS, MAX_QUESTION_CHARS } from './prompt.js';
import { render } from './format.js';

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));

export function createHandlers({ config, client, limiter, semaphore, memory, log = () => {} }) {
  const tools = buildTools(config);
  const system = () => buildSystem(config);

  /** Cheap checks before spending anything. Returns {ok:true} or {ok:false, message}. */
  function admit({ userId, channelId, text }) {
    if (config.allowedChannels.length && channelId && !config.allowedChannels.includes(channelId)) {
      return { ok: false, message: '這個頻道沒有開放機器人查詢。' };
    }
    const q = (text ?? '').trim();
    if (!q) return { ok: false, message: '請告訴我想查什麼,例如:`/ask 肥肥頭哪裡打?`' };
    if (q.length > MAX_QUESTION_CHARS) return { ok: false, message: `問題太長了(最多 ${MAX_QUESTION_CHARS} 字),請精簡一點。` };
    const r = limiter.take(userId);
    if (!r.ok) {
      return {
        ok: false,
        message: r.reason === 'window' ? `查太快了,請約 ${minutes(r.retryAfterMs)} 分鐘後再問。` : `你今天的查詢次數用完了,請約 ${Math.ceil(r.retryAfterMs / 3600000)} 小時後再問。`,
      };
    }
    return { ok: true };
  }

  /** Runs an admitted request. Returns {ok:true, parts, meta} or {ok:false, message}. */
  async function answer({ userId, channelId, kind = 'ask', text }) {
    const q = text.trim();
    const key = `${channelId}:${userId}`;
    const started = Date.now();
    try {
      const result = await semaphore.run(() =>
        ask({
          client,
          model: config.model,
          system: system(),
          tools,
          messages: [...memory.get(key), { role: 'user', content: (KINDS[kind] ?? KINDS.ask)(q) }],
          maxTokens: config.maxTokens,
          timeoutMs: config.timeoutMs,
        }),
      );
      memory.add(key, q, result.text);
      log('ask', { kind, user: userId, ms: Date.now() - started, rounds: result.rounds, ...result.usage, sources: result.sources.length });
      return { ok: true, parts: render(result), meta: result };
    } catch (err) {
      log('error', { kind, user: userId, ms: Date.now() - started, name: err?.name, status: err?.status, message: err?.message });
      return { ok: false, message: friendly(err) };
    }
  }

  return { admit, answer };
}

export function friendly(err) {
  if (err instanceof EmptyAnswerError) return err.message === 'refusal' ? '這個問題我沒辦法回答。' : '沒有查到可以回答的內容,換個關鍵字試試?';
  const s = err?.status;
  if (s === 401 || s === 403) return '機器人的 API 金鑰有問題,請通知管理員。';
  if (s === 429) return '現在查詢的人太多了,請稍等一下再問。';
  if (s === 400 && /web.?(search|fetch)/i.test(err.message ?? '')) return '網頁查詢功能沒有開啟,請管理員到 Anthropic Console 啟用 web search。';
  if (err?.name === 'APIConnectionTimeoutError' || err?.name === 'APIUserAbortError') return '查詢逾時了,請再試一次。';
  return '查詢時出了點問題,請稍後再試。';
}
