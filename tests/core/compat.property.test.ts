// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md E1–E4: the OpenAI- and Anthropic-compatible adapters, and the requestUrl fallback. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FallbackHttpClient, type HttpClient, type HttpRequest, type HttpResponse } from '../../src/core/http';
import { AnthropicCompatProvider, anthropicBody } from '../../src/core/providers/anthropic';
import { NO_STREAMING } from '../../src/core/providers/compat';
import { OpenAICompatProvider, openAIBody } from '../../src/core/providers/openai';
import { decodeSse } from '../../src/core/providers/sse';
import type { ChatEvent, ChatMessage, ChatRequest, ToolCall } from '../../src/core/providers/types';
import type { Endpoint } from '../../src/core/settings';

const KEY = 'sk-test-SECRETKEY-1234567890';

// ---------------------------------------------------------------------------
// Fakes

interface Scripted {
  status?: number;
  /** The body, cut into chunks; or a throw before any response. */
  body?: string;
  cuts?: number[];
  throws?: boolean;
}

class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly answer: (req: HttpRequest) => Scripted) {}
  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const a = this.answer(req);
    if (a.throws) return Promise.reject(new TypeError('Failed to fetch'));
    const bytes = new TextEncoder().encode(a.body ?? '');
    const cuts = [...new Set((a.cuts ?? []).map((c) => c % (bytes.length + 1)))].sort((x, y) => x - y);
    return Promise.resolve({
      status: a.status ?? 200,
      body: (async function* () {
        let prev = 0;
        for (const c of [...cuts, bytes.length]) {
          await Promise.resolve();
          if (c > prev) yield bytes.subarray(prev, c);
          prev = c;
        }
      })(),
    });
  }
}

const endpointFor = (kind: 'openai' | 'anthropic', patch: Partial<Endpoint> = {}): Endpoint => ({
  id: 'e1',
  name: 'Test server',
  kind,
  baseUrl: kind === 'openai' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:11434',
  secret: 'my-secret',
  contextLength: 32768,
  tools: true,
  images: false,
  maxOutput: 16384,
  thinking: false,
  models: [],
  ...patch,
});

const access = (e: Endpoint, http: HttpClient, fallback: HttpClient = http, key = KEY) => ({ settings: () => e, key: () => key, http, fallback });

async function collect(stream: AsyncIterable<ChatEvent>, abortAfter?: number, ctl?: AbortController): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of stream) {
    out.push(e);
    if (abortAfter !== undefined && out.length === abortAfter) ctl?.abort();
  }
  return out;
}

/** O1, for any provider: events, then exactly one done, last. */
function checkContract(events: ChatEvent[]): void {
  expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('done');
}

/** Tool arguments as the adapters should hand them on: parsed JSON, {} for nothing, else the raw text. */
function expectedArgs(args: string): unknown {
  if (args.trim() === '') return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

const join = (events: ChatEvent[], type: 'text' | 'reasoning') => events.flatMap((e) => (e.type === type ? [e.text] : [])).join('');
const callsOf = (events: ChatEvent[]): ToolCall[] => events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));

const piece = fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('日本', '🙂', '\n', ' ', 'é'), fc.string({ maxLength: 4, unit: 'grapheme' }));
const sseText = (events: Array<{ event?: string | undefined; data: string }>, crlf: boolean, extras: boolean) => {
  const nl = crlf ? '\r\n' : '\n';
  return events.map((e) => `${extras ? `: keep-alive${nl}` : ''}${e.event ? `event: ${e.event}${nl}` : ''}data: ${e.data}${nl}${nl}`).join('');
};

// ---------------------------------------------------------------------------
// SSE

describe('server-sent events', () => {
  it('decode the same whatever the chunking and line ends', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ event: fc.constantFrom(undefined, 'message_start', 'ping'), data: fc.string().filter((s) => !/[\r\n]/.test(s)) }), { maxLength: 8 }), fc.boolean(), fc.boolean(), fc.array(fc.nat(), { maxLength: 12 }), async (evs, crlf, extras, cuts) => {
        const http = new FakeHttp(() => ({ body: sseText(evs, crlf, extras), cuts }));
        const res = await http.request({ url: 'x', method: 'GET' });
        const out = [];
        for await (const e of decodeSse(res.body)) out.push(e);
        expect(out).toEqual(evs.map((e) => ({ event: e.event ?? 'message', data: e.data })));
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible: E1

interface OaiScript {
  steps: Array<
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string; field: 'reasoning' | 'reasoning_content' }
    | { kind: 'call'; index: number; frags: readonly string[]; repeatName: boolean }
  >;
  finish: 'stop' | 'length' | 'tool_calls' | null;
  usage: boolean;
  end: 'done' | 'eof' | 'error' | 'garbage';
}

const oaiScript: fc.Arbitrary<OaiScript> = fc.record({
  steps: fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant('text' as const), text: piece }),
      fc.record({ kind: fc.constant('reasoning' as const), text: piece, field: fc.constantFrom('reasoning' as const, 'reasoning_content' as const) }),
      fc.record({
        kind: fc.constant('call' as const),
        index: fc.nat({ max: 2 }),
        frags: fc.constantFrom(['{"q":', '"a"}'], ['{"q":"日本"}'], ['{', '}'], ['not json'], ['']),
        repeatName: fc.boolean(),
      }),
    ),
    { maxLength: 10 },
  ),
  finish: fc.constantFrom('stop' as const, 'length' as const, 'tool_calls' as const, null),
  usage: fc.boolean(),
  end: fc.constantFrom('done' as const, 'done' as const, 'eof' as const, 'error' as const, 'garbage' as const),
});

function oaiStream(s: OaiScript): Array<{ data: string }> {
  const out: Array<{ data: string }> = [];
  const seen = new Set<number>();
  for (const st of s.steps) {
    if (st.kind === 'text') out.push({ data: JSON.stringify({ choices: [{ delta: { content: st.text }, finish_reason: null }] }) });
    else if (st.kind === 'reasoning') out.push({ data: JSON.stringify({ choices: [{ delta: { [st.field]: st.text, content: '' } }] }) });
    else {
      st.frags.forEach((f, i) => {
        const first = !seen.has(st.index);
        seen.add(st.index);
        const fn = { ...(first || st.repeatName ? { name: `tool${st.index}` } : {}), arguments: f };
        out.push({ data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: st.index, ...(first && i === 0 ? { id: `call${st.index}` } : {}), function: fn }] } }] }) });
      });
    }
  }
  if (s.finish) out.push({ data: JSON.stringify({ choices: [{ delta: {}, finish_reason: s.finish }] }) });
  if (s.usage) out.push({ data: JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
  if (s.end === 'done') out.push({ data: '[DONE]' });
  if (s.end === 'error') out.push({ data: JSON.stringify({ error: { message: `bad thing ${KEY}` } }) });
  if (s.end === 'garbage') out.push({ data: '{not json' });
  return out;
}

const request: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

describe('OpenAI-compatible streams (INVARIANTS.md E1)', () => {
  it('E1: exactly one done; text, reasoning and tool calls are what the server sent; errors never pass as success', async () => {
    await fc.assert(
      fc.asyncProperty(oaiScript, fc.boolean(), fc.array(fc.nat(), { maxLength: 10 }), fc.option(fc.nat({ max: 12 }), { nil: undefined }), async (s, crlf, cuts, abortAfter) => {
        const http = new FakeHttp(() => ({ body: sseText(oaiStream(s), crlf, false), cuts }));
        const p = new OpenAICompatProvider(access(endpointFor('openai'), http));
        const ctl = new AbortController();
        const events = await collect(p.stream(request, ctl.signal), abortAfter, ctl);
        checkContract(events);
        const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
        if (done.reason === 'aborted') return;
        const texts = s.steps.flatMap((st) => (st.kind === 'text' ? [st.text] : [])).join('');
        const reasoning = s.steps.flatMap((st) => (st.kind === 'reasoning' ? [st.text] : [])).join('');
        expect(join(events, 'text')).toBe(texts);
        expect(join(events, 'reasoning')).toBe(reasoning);
        const ok = s.end === 'done' || (s.end === 'eof' && s.finish !== null);
        if (!ok) {
          expect(done.reason).toBe('error');
          expect(callsOf(events)).toEqual([]); // a call the model never finished never runs
          for (const e of events) if (e.type === 'error') expect(e.message).not.toContain(KEY);
          return;
        }
        expect(done.reason).toBe(s.finish === 'length' ? 'length' : 'stop');
        // Tool calls: by index; name once; arguments are the fragments, joined and parsed.
        const byIndex = new Map<number, string>();
        for (const st of s.steps) if (st.kind === 'call') byIndex.set(st.index, (byIndex.get(st.index) ?? '') + st.frags.join(''));
        const expected = [...byIndex].sort(([a], [b]) => a - b).map(([i, args]) => {
          return { name: `tool${i}`, arguments: expectedArgs(args) };
        });
        expect(callsOf(events).map(({ name, arguments: a }) => ({ name, arguments: a }))).toEqual(expected);
        if (s.usage) expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
      }),
    );
  });

  it('E1: a non-200 answer is an error naming the server’s message, never the key', async () => {
    const http = new FakeHttp(() => ({ status: 401, body: JSON.stringify({ error: { message: `Invalid key ${KEY}` } }) }));
    const p = new OpenAICompatProvider(access(endpointFor('openai'), http));
    const events = await collect(p.stream(request, new AbortController().signal));
    expect(events).toEqual([{ type: 'error', message: 'Test server: Invalid key [key]' }, { type: 'done', reason: 'error' }]);
  });
});

// ---------------------------------------------------------------------------
// Anthropic-compatible: E1

interface AntScript {
  blocks: Array<
    | { kind: 'text'; parts: readonly string[] }
    | { kind: 'thinking'; parts: readonly string[]; signature: string }
    | { kind: 'redacted' }
    | { kind: 'tool'; frags: readonly string[] }
  >;
  stop: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal' | 'pause_turn';
  end: 'stop' | 'eof' | 'error' | 'garbage';
  pings: boolean;
}

const antScript: fc.Arbitrary<AntScript> = fc.record({
  blocks: fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant('text' as const), parts: fc.array(piece, { maxLength: 4 }) }),
      fc.record({ kind: fc.constant('thinking' as const), parts: fc.array(piece, { maxLength: 3 }), signature: fc.constantFrom('', 'sigA', 'sig-B==') }),
      fc.record({ kind: fc.constant('redacted' as const) }),
      fc.record({ kind: fc.constant('tool' as const), frags: fc.constantFrom(['{"q":', '"a"}'], ['{"q":"日本"}'], [], ['{"bad']) }),
    ),
    { maxLength: 6 },
  ),
  stop: fc.constantFrom('end_turn' as const, 'max_tokens' as const, 'tool_use' as const, 'stop_sequence' as const, 'refusal' as const, 'pause_turn' as const),
  end: fc.constantFrom('stop' as const, 'stop' as const, 'eof' as const, 'error' as const, 'garbage' as const),
  pings: fc.boolean(),
});

function antStream(s: AntScript): Array<{ event: string; data: string }> {
  const ev = (type: string, body: Record<string, unknown>) => ({ event: type, data: JSON.stringify({ type, ...body }) });
  const out = [ev('message_start', { message: { id: 'm', usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 1 } } })];
  s.blocks.forEach((b, index) => {
    if (s.pings) out.push(ev('ping', {}));
    if (b.kind === 'text') {
      out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }));
      for (const p of b.parts) out.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: p } }));
    } else if (b.kind === 'thinking') {
      out.push(ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } }));
      for (const p of b.parts) out.push(ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: p } }));
      if (b.signature) out.push(ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } }));
    } else if (b.kind === 'redacted') {
      out.push(ev('content_block_start', { index, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED' } }));
    } else {
      out.push(ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${index}`, name: 'search', input: {} } }));
      for (const f of b.frags) out.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: f } }));
    }
    out.push(ev('content_block_stop', { index }));
  });
  out.push(ev('message_delta', { delta: { stop_reason: s.stop }, usage: { output_tokens: 42 } }));
  if (s.end === 'stop') out.push(ev('message_stop', {}));
  if (s.end === 'error') out.push(ev('error', { error: { type: 'overloaded_error', message: `Overloaded ${KEY}` } }));
  if (s.end === 'garbage') out.push({ event: 'message_stop', data: '{nope' });
  return out;
}

describe('Anthropic-compatible streams (INVARIANTS.md E1)', () => {
  it('E1: exactly one done; text, thinking, tool calls and replay are what the server sent; refusals are errors', async () => {
    await fc.assert(
      fc.asyncProperty(antScript, fc.boolean(), fc.array(fc.nat(), { maxLength: 10 }), fc.option(fc.nat({ max: 12 }), { nil: undefined }), async (s, crlf, cuts, abortAfter) => {
        const http = new FakeHttp((req) => (req.url.includes('/v1/models') ? { status: 404, body: '' } : { body: sseText(antStream(s), crlf, false), cuts }));
        const p = new AnthropicCompatProvider(access(endpointFor('anthropic'), http));
        const ctl = new AbortController();
        const events = await collect(p.stream(request, ctl.signal), abortAfter, ctl);
        checkContract(events);
        const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
        if (done.reason === 'aborted') return;
        expect(join(events, 'text')).toBe(s.blocks.flatMap((b) => (b.kind === 'text' ? b.parts : [])).join(''));
        expect(join(events, 'reasoning')).toBe(s.blocks.flatMap((b) => (b.kind === 'thinking' ? b.parts : [])).join(''));
        if (s.end !== 'stop' || s.stop === 'refusal') {
          expect(done.reason).toBe('error');
          expect(callsOf(events)).toEqual([]);
          for (const e of events) if (e.type === 'error') expect(e.message).not.toContain(KEY);
          return;
        }
        expect(done.reason).toBe(s.stop === 'max_tokens' ? 'length' : 'stop');
        const tools = s.blocks.flatMap((b, i) => (b.kind === 'tool' ? [{ i, args: b.frags.join('') }] : []));
        expect(callsOf(events)).toEqual(
          tools.map(({ i, args }) => {
            return { id: `toolu_${i}`, name: 'search', arguments: expectedArgs(args) };
          }),
        );
        // Signed thinking and redacted thinking come back as replay data, in order, only with tool calls.
        const signed = s.blocks.flatMap((b): Array<Record<string, string>> =>
          b.kind === 'thinking' && b.signature ? [{ type: 'thinking', thinking: b.parts.join(''), signature: b.signature }] : b.kind === 'redacted' ? [{ type: 'redacted_thinking', data: 'ENCRYPTED' }] : [],
        );
        const replay = events.find((e) => e.type === 'replay');
        expect(replay ? (replay as { data: unknown }).data : null).toEqual(tools.length > 0 && signed.length > 0 ? signed : null);
        // Usage counts cached input too.
        expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 42 });
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// E2: requests

const image = fc.record({ mime: fc.constantFrom('image/png', 'image/jpeg'), data: fc.base64String({ minLength: 4, maxLength: 16 }), tokens: fc.nat() });
const message: fc.Arbitrary<ChatMessage> = fc.oneof(
  fc.record({ role: fc.constant('system' as const), content: piece }),
  fc.record({ role: fc.constant('user' as const), content: piece, images: fc.array(image, { maxLength: 2 }) }, { requiredKeys: ['role', 'content'] }),
  fc.record({ role: fc.constant('assistant' as const), content: piece }),
);
/** A conversation as the session builds it: tool rounds are an assistant turn with calls, then one tool message per call. */
const conversation = fc
  .tuple(
    fc.array(message, { maxLength: 6 }),
    fc.array(fc.tuple(piece, fc.array(fc.jsonValue({ maxDepth: 2 }), { minLength: 1, maxLength: 3 }), fc.boolean(), fc.array(image, { maxLength: 1 })), { maxLength: 2 }),
  )
  .map(([head, rounds]) => {
    let n = 0;
    const out: ChatMessage[] = [...head];
    for (const [text, argsList, withReplay, imgs] of rounds) {
      const calls = argsList.map((a) => ({ id: `c${++n}`, name: 'tool', arguments: a }));
      out.push({ role: 'assistant', content: text, toolCalls: calls, ...(withReplay ? { replay: [{ type: 'thinking', thinking: 'mm', signature: `REPLAY-SIGNATURE-${n}` }] } : {}) });
      for (const c of calls) out.push({ role: 'tool', content: `result ${c.id}`, toolName: 'tool', toolCallId: c.id });
      if (imgs.length > 0) out.push({ role: 'user', content: 'The images', images: imgs });
    }
    return out;
  });

describe('requests (INVARIANTS.md E2, E3)', () => {
  it('E2: OpenAI shape: every message in order, tool calls with ids, images as data URLs, nothing else', () => {
    fc.assert(
      fc.property(conversation, (messages) => {
        const body = openAIBody({ model: 'm', messages }) as { messages: Array<Record<string, unknown>> };
        expect(body.messages).toHaveLength(messages.length);
        messages.forEach((m, i) => {
          const o = body.messages[i]!;
          expect(o['role']).toBe(m.role);
          if (m.role === 'tool') expect(o).toEqual({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
          else if (m.role === 'user' && m.images && m.images.length > 0) {
            expect(o['content']).toEqual([{ type: 'text', text: m.content }, ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))]);
          } else expect(o['content']).toBe(m.content);
          if (m.role === 'assistant' && m.toolCalls) {
            expect(o['tool_calls']).toEqual(m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) } })));
          }
          // Replay data is for Anthropic only. (Regression, seed 892126910: a test mistake; tool arguments may contain "sig".)
          expect(JSON.stringify(o)).not.toContain('REPLAY-SIGNATURE');
        });
      }),
    );
  });

  it('E2: Anthropic shape: system on top, roles alternate, tool results answer their calls, replay before tool_use', () => {
    fc.assert(
      fc.property(conversation, (messages) => {
        const body = anthropicBody({ model: 'm', messages }, 1000, false) as { system?: Array<{ text: string }>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
        expect((body.system ?? []).map((b) => b.text)).toEqual(messages.flatMap((m) => (m.role === 'system' ? [m.content] : [])));
        body.messages.forEach((m, i) => {
          if (i > 0) expect(m.role).not.toBe(body.messages[i - 1]!.role);
          expect(m.content.length).toBeGreaterThan(0);
        });
        // Flatten both sides and compare block by block.
        const expected: Array<Record<string, unknown>> = [];
        for (const m of messages) {
          if (m.role === 'system') continue;
          if (m.role === 'tool') expected.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
          else if (m.role === 'user') {
            for (const im of m.images ?? []) expected.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
            if (m.content !== '' || (m.images ?? []).length === 0) expected.push({ type: 'text', text: m.content });
          } else {
            if (m.toolCalls && m.toolCalls.length > 0 && Array.isArray(m.replay)) expected.push(...(m.replay as Array<Record<string, unknown>>));
            if (m.content !== '') expected.push({ type: 'text', text: m.content });
            for (const c of m.toolCalls ?? []) {
              const a = c.arguments;
              expected.push({ type: 'tool_use', id: c.id, name: c.name, input: a !== null && typeof a === 'object' && !Array.isArray(a) ? a : {} });
            }
          }
        }
        expect(body.messages.flatMap((m) => m.content)).toEqual(expected);
      }),
    );
  });

  it('E2, E3: requests go only to the endpoint; the key only in its auth header; none without a key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('openai' as const, 'anthropic' as const), fc.boolean(), conversation, async (kind, withKey, messages) => {
        const e = endpointFor(kind, { baseUrl: kind === 'openai' ? 'https://gw.example/v1' : 'https://gw.example' });
        const http = new FakeHttp((req) => (req.method === 'GET' ? { status: 404, body: `{"error":"nope ${KEY}"}` } : { body: '' }));
        const key = withKey ? KEY : '';
        const p = kind === 'openai' ? new OpenAICompatProvider(access(e, http, http, key)) : new AnthropicCompatProvider(access(e, http, http, key));
        await p.capabilities('m');
        await p.listModels().catch(() => null);
        await collect(p.stream({ model: 'm', messages, tools: [{ name: 'tool', description: 'd', parameters: { type: 'object' } }] }, new AbortController().signal));
        for (const r of http.requests) {
          expect(r.url.startsWith('https://gw.example/')).toBe(true);
          expect(r.url).not.toContain(KEY);
          expect(r.body ?? '').not.toContain(KEY);
          const auth = Object.entries(r.headers ?? {}).filter(([, v]) => v.includes(KEY));
          if (withKey) expect(auth.map(([k]) => k)).toEqual([kind === 'openai' ? 'Authorization' : 'x-api-key']);
          else expect(auth).toEqual([]);
          expect(Object.keys(r.headers ?? {}).some((k) => k === 'Authorization' || k === 'x-api-key')).toBe(withKey);
        }
        const allowed = kind === 'openai' ? ['/v1/chat/completions', '/v1/models', '/api/v0/models', '/props'] : ['/v1/messages', '/v1/models'];
        for (const r of http.requests) expect(allowed.some((a) => new URL(r.url).pathname === a)).toBe(true);
      }),
    );
  });

  it('Anthropic: thinking is asked for only when the endpoint says so; max_tokens is the lower of setting and model cap', async () => {
    const models = JSON.stringify({ data: [{ id: 'claude-x', max_input_tokens: 200000, max_tokens: 8000, capabilities: { image_input: { supported: true } } }], has_more: false });
    const http = new FakeHttp((req) => (req.method === 'GET' ? { body: models } : { body: '' }));
    const p = new AnthropicCompatProvider(access(endpointFor('anthropic', { thinking: true, maxOutput: 16000 }), http));
    expect(await p.capabilities('claude-x')).toEqual({ toolCalling: 'native', nativeWebSearch: false, images: true, contextWindow: 200000 });
    await collect(p.stream({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal));
    const body = JSON.parse(http.requests.find((r) => r.method === 'POST')!.body!) as Record<string, unknown>;
    expect(body['max_tokens']).toBe(8000);
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(http.requests.find((r) => r.method === 'POST')!.headers!['anthropic-dangerous-direct-browser-access']).toBeUndefined();
  });

  it('OpenAI: capabilities come from settings unless the server reports them (vLLM, LM Studio, llama.cpp)', async () => {
    const answer = (paths: Record<string, string>) => (req: HttpRequest) => {
      const body = paths[new URL(req.url).pathname];
      return body === undefined ? { status: 404, body: '' } : { body };
    };
    const caps = (paths: Record<string, string>) => new OpenAICompatProvider(access(endpointFor('openai', { contextLength: 4096 }), new FakeHttp(answer(paths)))).capabilities('m');
    expect(await caps({})).toEqual({ toolCalling: 'native', nativeWebSearch: false, images: false, contextWindow: 4096 });
    expect((await caps({ '/v1/models': JSON.stringify({ data: [{ id: 'm', max_model_len: 131072 }] }) })).contextWindow).toBe(131072);
    expect(await caps({ '/api/v0/models': JSON.stringify({ data: [{ id: 'm', type: 'vlm', loaded_context_length: 8192, capabilities: [] }] }) })).toEqual({ toolCalling: 'none', nativeWebSearch: false, images: true, contextWindow: 8192 });
    expect((await caps({ '/props': JSON.stringify({ default_generation_settings: { n_ctx: 16384 }, modalities: { vision: true } }) })).contextWindow).toBe(16384);
  });
});

// ---------------------------------------------------------------------------
// E4: the requestUrl fallback

describe('the requestUrl fallback (INVARIANTS.md E4)', () => {
  type Mode = 'ok' | 'throws' | 'abort';
  it('E4: falls back only before any response and never on abort; then stays on the fallback; tells once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom<Mode>('ok', 'throws', 'abort'), fc.constantFrom<Mode>('ok', 'throws')), { minLength: 1, maxLength: 5 }), async (plan) => {
        let i = 0;
        const sent = { primary: 0, fallback: 0 };
        let told = 0;
        const primary: HttpClient = {
          request(req) {
            sent.primary++;
            const mode = plan[i]![0];
            if (mode === 'abort') {
              (req as { ctl?: AbortController }).ctl?.abort();
              return Promise.reject(new DOMException('Aborted', 'AbortError'));
            }
            return mode === 'throws' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ status: 200, body: (async function* () {})() });
          },
        };
        const fallback: HttpClient = {
          request() {
            sent.fallback++;
            return plan[i]![1] === 'throws' ? Promise.reject(new TypeError('down')) : Promise.resolve({ status: 200, body: (async function* () {})() });
          },
        };
        const client = new FallbackHttpClient(primary, fallback, () => told++);
        let fallen = false;
        for (; i < plan.length; i++) {
          const [p, f] = plan[i]!;
          const before = { ...sent };
          const ctl = new AbortController();
          const ok = await client.request({ url: 'u', method: 'POST', signal: ctl.signal }).then(() => true, () => false);
          if (fallen) {
            expect(sent.primary).toBe(before.primary); // straight to the fallback
            expect(sent.fallback).toBe(before.fallback + 1);
            expect(ok).toBe(f === 'ok');
            continue;
          }
          expect(sent.primary).toBe(before.primary + 1);
          // Only a failure before any response, and not an abort, is tried again, once.
          expect(sent.fallback).toBe(before.fallback + (p === 'throws' ? 1 : 0));
          expect(ok).toBe(p === 'ok' || (p === 'throws' && f === 'ok'));
          if (p === 'throws' && f === 'ok') fallen = true;
        }
        expect(told).toBe(fallen ? 1 : 0);
        expect(client.fallen).toBe(fallen);
      }),
    );
  });

  it('E4: the reply that first falls back says why, once', async () => {
    const sse = sseText([{ data: JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) }, { data: '[DONE]' }], false, false);
    const primary = new FakeHttp(() => ({ throws: true }));
    const fallback = new FakeHttp(() => ({ body: sse }));
    const p = new OpenAICompatProvider(access(endpointFor('openai'), primary, fallback));
    const first = await collect(p.stream(request, new AbortController().signal));
    const second = await collect(p.stream(request, new AbortController().signal));
    expect(first).toContainEqual({ type: 'notice', message: NO_STREAMING });
    expect(second.some((e) => e.type === 'notice')).toBe(false);
    expect(join(second, 'text')).toBe('hi');
    expect(primary.requests).toHaveLength(1);
  });
});

describe('replay through a session (INVARIANTS.md E2)', () => {
  it('a round’s replay data goes back with its turn for the rest of the reply, and never into later messages or history', async () => {
    const { ChatSession } = await import('../../src/core/chat/session');
    const { EMPTY_CONTEXT } = await import('../../src/core/context/state');
    const sent: ChatMessage[][] = [];
    let call = 0;
    const provider = {
      id: 'fake',
      label: 'Fake',
      capabilities: () => Promise.resolve({ toolCalling: 'native' as const, nativeWebSearch: false, images: false, contextWindow: 100_000 }),
      listModels: () => Promise.resolve([]),
      async *stream(req: ChatRequest) {
        sent.push(structuredClone(req.messages));
        await Promise.resolve();
        if (call++ === 0) {
          yield { type: 'replay' as const, data: [{ type: 'thinking', thinking: 'plan', signature: 'SIG1' }] };
          yield { type: 'tool_call' as const, call: { id: 't1', name: 'ok', arguments: {} } };
        } else yield { type: 'text' as const, text: 'answer' };
        yield { type: 'done' as const, reason: 'stop' as const };
      },
    };
    const session = new ChatSession(
      { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'fake', model: 'm' }, messages: [], context: EMPTY_CONTEXT },
      {
        providers: { get: () => provider },
        clock: { now: () => 0 },
        newId: (() => {
          let n = 0;
          return () => `id${++n}`;
        })(),
        save: () => Promise.resolve(),
        tools: {
          forReply: () => ({
            definitions: [{ name: 'ok', description: 'ok', parameters: { type: 'object' } }],
            execute: () => Promise.resolve({ ok: true, content: 'R', summary: 'ok' }),
          }),
        },
      },
    );
    const settle = async () => {
      for (let i = 0; i < 50 && session.busy; i++) await new Promise<void>((r) => setImmediate(r));
    };
    session.send('first');
    await settle();
    session.send('second');
    await settle();
    expect(sent).toHaveLength(3);
    const withReplay = (ms: ChatMessage[]) => ms.filter((m) => m.role === 'assistant' && m.replay !== undefined);
    expect(withReplay(sent[0]!)).toEqual([]);
    expect(withReplay(sent[1]!)).toEqual([{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'ok', arguments: {} }], replay: [{ type: 'thinking', thinking: 'plan', signature: 'SIG1' }] }]);
    expect(withReplay(sent[2]!)).toEqual([]); // the next message starts without it
    expect(JSON.stringify(session.chat)).not.toContain('SIG1'); // never saved
  });
});
