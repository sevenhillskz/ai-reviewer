// Thin Messages API client with retries. No SDK dependency.

const API_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';

// USD per 1M tokens: [input, output]. Cache read = 0.1x input, cache write = 1.25x input.
export const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export function costOf(model, u) {
  const [inP, outP] = PRICES[model] ?? PRICES['claude-opus-5-5'];
  const input = (u.input_tokens ?? 0) * inP
    + (u.cache_creation_input_tokens ?? 0) * inP * 1.25
    + (u.cache_read_input_tokens ?? 0) * inP * 0.1;
  return (input + (u.output_tokens ?? 0) * outP) / 1e6;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createMessage(body, { apiKey = process.env.ANTHROPIC_API_KEY, retries = 5, timeoutMs = 600000 } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не задан');
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Network error or timeout: retry with backoff.
      if (attempt >= retries) throw new Error(`Anthropic API недоступен: ${e.message}`);
      await sleep(Math.min(60000, 2000 * 2 ** attempt));
      continue;
    }
    if (res.ok) {
      try {
        return await readStream(res);
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(Math.min(60000, 2000 * 2 ** attempt));
        continue;
      }
    }

    const text = await res.text();
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
    }
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(60000, 2000 * 2 ** attempt));
  }
}

// Assemble a Messages API SSE stream into the same shape as a non-streaming response.
// Streaming avoids idle-connection timeouts on long thinking-heavy requests.
export async function readStream(res) {
  const decoder = new TextDecoder();
  let buf = '';
  let msg = null;
  const json = new Map();

  const handle = (ev) => {
    switch (ev.type) {
      case 'message_start':
        msg = { ...ev.message, content: [] };
        break;
      case 'content_block_start':
        msg.content[ev.index] = { ...ev.content_block };
        if (ev.content_block.type === 'tool_use') json.set(ev.index, '');
        break;
      case 'content_block_delta': {
        const b = msg.content[ev.index];
        const d = ev.delta;
        if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
        else if (d.type === 'input_json_delta') json.set(ev.index, json.get(ev.index) + d.partial_json);
        break;
      }
      case 'content_block_stop':
        if (json.has(ev.index)) {
          const raw = json.get(ev.index);
          try { msg.content[ev.index].input = raw ? JSON.parse(raw) : {}; } catch { msg.content[ev.index].input = {}; }
        }
        break;
      case 'message_delta':
        Object.assign(msg, ev.delta);
        msg.usage = { ...msg.usage, ...ev.usage };
        break;
      case 'error':
        throw new Error(`Anthropic stream error: ${JSON.stringify(ev.error)}`);
      default:
    }
  };

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) handle(JSON.parse(data));
    }
  }
  if (!msg || !msg.stop_reason) throw new Error('Anthropic stream оборвался');
  msg.content = msg.content.filter(Boolean);
  return msg;
}
