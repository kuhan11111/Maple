// Scripted stand-in for the Anthropic client: returns queued responses and records requests.
export function fakeClient(...responses) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params, opts) {
        calls.push({ params, opts });
        const next = responses.shift();
        if (!next) throw new Error('no scripted response left');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

export const text = (t, citations) => ({ type: 'text', text: t, ...(citations ? { citations } : {}) });
export const search = (...results) => ({
  type: 'web_search_tool_result',
  tool_use_id: 'x',
  content: results.map(([url, title]) => ({ type: 'web_search_result', url, title, page_age: null, encrypted_content: '' })),
});
export const fetched = (url, title) => ({ type: 'web_fetch_tool_result', tool_use_id: 'y', content: { type: 'web_fetch_result', url, retrieved_at: null, content: { type: 'document', title } } });
export const toolUse = (name) => ({ type: 'server_tool_use', id: 'z', name, input: {} });
export const cite = (url, title) => ({ type: 'web_search_result_location', url, title, cited_text: '...', encrypted_index: '' });
export const reply = (content, extra = {}) => ({ content, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }, ...extra });

export const baseConfig = {
  model: 'test-model',
  sources: ['artalemaplestory.com', 'dcard.tw'],
  dbDomains: ['artalemaplestory.com'],
  maxSearches: 3,
  maxFetches: 3,
  maxTokens: 1500,
  maxContentTokens: 12000,
  timeoutMs: 5000,
  allowedChannels: [],
};
