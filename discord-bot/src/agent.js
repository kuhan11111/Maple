// Asks Claude a question with the web search / fetch tools limited to the configured sites, and
// turns the response into {text, sources, usage}. `client` is an Anthropic SDK client (or a fake).
//
// Search and fetch run on Anthropic's servers inside the same request, so there is no tool loop
// to write - except `pause_turn`: a long server-side turn is handed back and must be resumed by
// sending the partial assistant message again.

export function buildTools({ sources, maxSearches, maxFetches, maxContentTokens }) {
  return [
    { type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches, allowed_domains: sources },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: maxFetches, allowed_domains: sources, max_content_tokens: maxContentTokens },
  ];
}

const isToolResult = (b) => b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result';

/** The answer is the text after the last tool result; text before it is "let me search..." chatter. */
export function answerBlocks(content) {
  let start = 0;
  content.forEach((b, i) => {
    if (isToolResult(b)) start = i + 1;
  });
  const after = content.slice(start).filter((b) => b.type === 'text');
  return after.length ? after : content.filter((b) => b.type === 'text');
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

/** Pages the answer cites, then pages that were read, falling back to top search hits. */
export function collectSources(responses, blocks, max = 5) {
  const out = new Map();
  const add = (url, title) => {
    if (typeof url === 'string' && url && !out.has(url)) out.set(url, title || hostOf(url));
  };
  for (const b of blocks) for (const c of b.citations ?? []) if (c.type === 'web_search_result_location') add(c.url, c.title);
  const searched = [];
  for (const r of responses) {
    for (const b of r.content) {
      if (b.type === 'web_fetch_tool_result' && b.content?.type === 'web_fetch_result') add(b.content.url, b.content.content?.title);
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) searched.push(...b.content.filter((x) => x.type === 'web_search_result'));
    }
  }
  if (!out.size) for (const s of searched.slice(0, 3)) add(s.url, s.title);
  return [...out].slice(0, max).map(([url, title]) => ({ url, title }));
}

export class EmptyAnswerError extends Error {}

export async function ask({ client, model, system, messages, tools, maxTokens = 1500, timeoutMs = 90000, maxContinuations = 4 }) {
  const responses = [];
  let msgs = messages;
  let last;
  for (let i = 0; i <= maxContinuations; i++) {
    last = await client.messages.create({ model, max_tokens: maxTokens, system, tools, messages: msgs }, { timeout: timeoutMs });
    responses.push(last);
    if (last.stop_reason !== 'pause_turn') break;
    msgs = [...msgs, { role: 'assistant', content: last.content }];
  }
  if (last.stop_reason === 'refusal') throw new EmptyAnswerError('refusal');
  const blocks = answerBlocks(last.content);
  let text = blocks.map((b) => b.text).join('').trim();
  if (!text) throw new EmptyAnswerError('empty');
  if (last.stop_reason === 'max_tokens') text += '…(回答太長被截斷了)';

  const usage = { input: 0, output: 0, searches: 0, fetches: 0 };
  for (const r of responses) {
    usage.input += r.usage?.input_tokens ?? 0;
    usage.output += r.usage?.output_tokens ?? 0;
    usage.searches += r.usage?.server_tool_use?.web_search_requests ?? 0;
    usage.fetches += r.usage?.server_tool_use?.web_fetch_requests ?? 0;
  }
  return { text, sources: collectSources(responses, blocks), usage, rounds: responses.length };
}
