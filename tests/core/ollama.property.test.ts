// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md O1–O2: Ollama streams always end exactly once; requests carry only the conversation. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest, HttpResponse } from '../../src/core/http';
import { OllamaProvider } from '../../src/core/providers/ollama';
import type { ChatEvent, ChatMessage } from '../../src/core/providers/types';

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Scripted fake server

type ServerLine =
  | { kind: 'delta'; content?: string | undefined; thinking?: string | undefined }
  | { kind: 'empty-object' }
  | { kind: 'toolcall'; name: string; args: unknown; id?: string | undefined }
  | { kind: 'error'; message: string }
  | { kind: 'bad-json'; text: string }
  | { kind: 'bad-shape' }
  | { kind: 'done'; reason?: string | undefined; prompt?: number | undefined; output?: number | undefined };

interface Script {
  status: number;
  errorBody: string;
  lines: ServerLine[];
  /** What happens if the lines run out without a done line. */
  ending: 'close' | 'throw';
  offsets: number[];
  requestThrows: boolean;
  thinking: boolean;
  showFails: boolean;
}

function serialise(l: ServerLine): string {
  switch (l.kind) {
    case 'delta':
      return JSON.stringify({ model: 'm', message: { role: 'assistant', content: l.content ?? '', ...(l.thinking !== undefined ? { thinking: l.thinking } : {}) }, done: false });
    case 'empty-object':
      return '{}';
    case 'toolcall':
      return JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ ...(l.id !== undefined ? { id: l.id } : {}), function: { name: l.name, arguments: l.args } }] }, done: false });
    case 'error':
      return JSON.stringify({ error: l.message });
    case 'bad-json':
      return l.text;
    case 'bad-shape':
      return JSON.stringify({ message: { role: 'assistant', content: 42 }, done: false });
    case 'done':
      return JSON.stringify({
        model: 'm', message: { role: 'assistant', content: '' }, done: true,
        ...(l.reason !== undefined ? { done_reason: l.reason } : {}),
        ...(l.prompt !== undefined ? { prompt_eval_count: l.prompt } : {}),
        ...(l.output !== undefined ? { eval_count: l.output } : {}),
      });
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  /** `slow`: yield to the event loop between chunks, like a real socket. */
  constructor(
    readonly script: Script,
    readonly slow = false,
  ) {}

  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const { script } = this;
    if (req.signal?.aborted) return Promise.reject(abortError());
    if (req.url.endsWith('/api/show')) {
      if (script.showFails) return Promise.reject(new Error('ECONNREFUSED'));
      const show = { capabilities: script.thinking ? ['completion', 'thinking'] : ['completion'], model_info: { 'qwen.context_length': 8192 } };
      return Promise.resolve({ status: 200, body: once(enc.encode(JSON.stringify(show))) });
    }
    if (script.requestThrows) return Promise.reject(new Error('ECONNREFUSED'));
    if (script.status !== 200) return Promise.resolve({ status: script.status, body: once(enc.encode(script.errorBody)) });

    const bytes = enc.encode(script.lines.map(serialise).join('\n') + (script.lines.length ? '\n' : ''));
    const points = [...new Set(script.offsets.map((o) => o % (bytes.length + 1)))].sort((a, b) => a - b);
    const signal = req.signal;
    const slow = this.slow;
    async function* body(): AsyncGenerator<Uint8Array> {
      let last = 0;
      for (const p of [...points, bytes.length]) {
        await (slow ? new Promise((r) => setImmediate(r)) : Promise.resolve());
        if (signal?.aborted) throw abortError();
        yield bytes.slice(last, p);
        last = p;
      }
      if (script.ending === 'throw') throw new Error('socket hang up');
    }
    return Promise.resolve({ status: 200, body: body() });
  }
}

async function* once(b: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield b;
}

// ---------------------------------------------------------------------------
// Reference model

type Shape =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'tool_call'; call: { id: string; name: string; arguments: unknown } } | { type: 'usage'; inputTokens?: number; outputTokens?: number } | { type: 'error' } | { type: 'done'; reason: string };

function expectedEvents(s: Script): Shape[] {
  if (s.showFails || s.requestThrows || s.status !== 200) return [{ type: 'error' }, { type: 'done', reason: 'error' }];
  const out: Shape[] = [];
  let calls = 0;
  for (const l of s.lines) {
    switch (l.kind) {
      case 'delta':
        if (l.thinking) out.push({ type: 'reasoning', text: l.thinking });
        if (l.content) out.push({ type: 'text', text: l.content });
        break;
      case 'empty-object':
        break;
      case 'toolcall': {
        if (l.id === undefined) calls += 1; // ids are generated only for calls that arrive without one
        // What crosses the wire is JSON: -0 arrives as 0 (fc.jsonValue makes -0 about once in 1,800 values).
        let args: unknown = typeof l.args === 'string' ? l.args : (JSON.parse(JSON.stringify(l.args)) as unknown);
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            /* passed on as a string */
          }
        }
        out.push({ type: 'tool_call', call: { id: l.id ?? `call_${calls}`, name: l.name, arguments: args } });
        break;
      }
      case 'error':
      case 'bad-json':
      case 'bad-shape':
        return [...out, { type: 'error' }, { type: 'done', reason: 'error' }];
      case 'done':
        if (l.prompt !== undefined || l.output !== undefined) {
          out.push({ type: 'usage', ...(l.prompt !== undefined ? { inputTokens: l.prompt } : {}), ...(l.output !== undefined ? { outputTokens: l.output } : {}) });
        }
        return [...out, { type: 'done', reason: l.reason === 'length' ? 'length' : 'stop' }];
    }
  }
  return [...out, { type: 'error' }, { type: 'done', reason: 'error' }];
}

function shape(e: ChatEvent): Shape {
  if (e.type === 'error') {
    expect(e.message.length).toBeGreaterThan(0);
    return { type: 'error' };
  }
  if (e.type === 'replay' || e.type === 'notice' || e.type === 'tool_activity') throw new Error(`Ollama never sends ${e.type} events.`);
  return e;
}

// ---------------------------------------------------------------------------
// Generators

const text = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('日本', '𝄞', '\n', ''));
const serverLine: fc.Arbitrary<ServerLine> = fc.oneof(
  { weight: 10, arbitrary: fc.record({ kind: fc.constant('delta' as const), content: fc.option(text, { nil: undefined }), thinking: fc.option(text, { nil: undefined }) }, { requiredKeys: ['kind'] }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'empty-object' as const }) },
  {
    weight: 2,
    arbitrary: fc.record(
      {
        kind: fc.constant('toolcall' as const),
        name: fc.constantFrom('web_search', 'fetch_page', 'x'),
        args: fc.oneof(fc.jsonValue(), fc.constant('{"query":"a"}'), fc.constant('not json')),
        id: fc.option(fc.constantFrom('call_a', 'call_b'), { nil: undefined }),
      },
      { requiredKeys: ['kind', 'name', 'args'] },
    ),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('error' as const), message: fc.string({ minLength: 1 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('bad-json' as const), text: fc.constantFrom('{', 'nope', '{"a":') }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'bad-shape' as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('done' as const), reason: fc.option(fc.constantFrom('stop', 'length', 'load', 'unload'), { nil: undefined }), prompt: fc.option(fc.nat(), { nil: undefined }), output: fc.option(fc.nat(), { nil: undefined }) }, { requiredKeys: ['kind'] }) },
);

const script: fc.Arbitrary<Script> = fc.record({
  status: fc.oneof({ weight: 8, arbitrary: fc.constant(200) }, { weight: 1, arbitrary: fc.constantFrom(400, 404, 500, 503) }),
  errorBody: fc.constantFrom('{"error":"model \'x\' not found"}', 'Internal Server Error', '', '{"error":42}'),
  lines: fc.array(serverLine, { maxLength: 15 }),
  ending: fc.constantFrom('close' as const, 'throw' as const),
  offsets: fc.array(fc.nat(), { maxLength: 20 }),
  requestThrows: fc.oneof({ weight: 8, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
  thinking: fc.boolean(),
  showFails: fc.oneof({ weight: 12, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
});

const call = fc.record({ id: fc.string({ minLength: 1 }), name: fc.constantFrom('web_search', 'fetch_page'), arguments: fc.jsonValue() });
const message: fc.Arbitrary<ChatMessage> = fc.oneof(
  fc.record({ role: fc.constantFrom('user' as const, 'assistant' as const, 'system' as const), content: fc.string() }),
  fc.record({ role: fc.constant('assistant' as const), content: fc.string(), toolCalls: fc.array(call, { minLength: 1, maxLength: 3 }) }),
  fc.record({ role: fc.constant('tool' as const), content: fc.string(), toolName: fc.constantFrom('web_search', 'fetch_page'), toolCallId: fc.string() }),
  // Milestone 7: images on user messages (base64), sometimes an empty list.
  fc.record({
    role: fc.constant('user' as const),
    content: fc.string(),
    images: fc.array(fc.record({ mime: fc.constantFrom('image/png', 'image/jpeg'), data: fc.base64String({ minLength: 4, maxLength: 24 }), tokens: fc.nat() }), { maxLength: 3 }),
  }),
);
const tool = fc.record({ name: fc.constantFrom('web_search', 'fetch_page'), description: fc.string(), parameters: fc.constant({ type: 'object', properties: {} }) });

/** O2's reference mapping to Ollama's message format. */
function ollamaMessage(m: ChatMessage): unknown {
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return { role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) };
  }
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.toolName };
  // Images only when there are some: base64, in order, and nothing else about them.
  if (m.role === 'user' && m.images && m.images.length > 0) return { role: 'user', content: m.content, images: m.images.map((i) => i.data) };
  return { role: m.role, content: m.content };
}
const baseUrl = fc.webUrl({ withQueryParameters: false, withFragments: false }).map((u) => u.replace(/\/+$/, ''));

async function run(provider: OllamaProvider, messages: ChatMessage[], abortAfter: number | null) {
  const controller = new AbortController();
  const events: ChatEvent[] = [];
  let abortedAt: number | null = null;
  for await (const e of provider.stream({ model: 'm', messages }, controller.signal)) {
    events.push(e);
    if (abortAfter !== null && events.length === abortAfter && abortedAt === null) {
      controller.abort();
      abortedAt = events.length;
    }
  }
  return { events, abortedAt };
}

// ---------------------------------------------------------------------------

describe('OllamaProvider.stream (INVARIANTS.md O1)', () => {
  it('O1: exactly one done, last; events match the server; never throws', async () => {
    await fc.assert(
      fc.asyncProperty(script, async (s) => {
        const provider = new OllamaProvider(new FakeHttp(s), () => 'http://127.0.0.1:11434', () => 32768);
        const { events } = await run(provider, [{ role: 'user', content: 'hi' }], null);
        expect(events.map(shape)).toEqual(expectedEvents(s));
      }),
    );
  });

  // Regression (O1, a CI run during milestone 10; a mistake in the test model since milestone 4): tool-call arguments
  // containing -0 arrive as 0, because the server sends JSON. The model now expects what crosses the wire.
  it('O1: tool-call arguments are what the server sent as JSON (-0 arrives as 0)', async () => {
    const s = { status: 200, errorBody: '', lines: [{ kind: 'toolcall' as const, name: 'x', args: { n: -0, list: [-0] }, id: 'call_a' }, { kind: 'done' as const }], ending: 'close' as const, offsets: [], requestThrows: false, thinking: false, showFails: false };
    const { events } = await run(new OllamaProvider(new FakeHttp(s), () => 'http://127.0.0.1:11434', () => 32768), [{ role: 'user', content: 'hi' }], null);
    expect(events.map(shape)).toEqual(expectedEvents(s));
    expect(events[0]).toEqual({ type: 'tool_call', call: { id: 'call_a', name: 'x', arguments: { n: 0, list: [0] } } });
  });

  it('O1: after an abort, the only further event is done: aborted', async () => {
    await fc.assert(
      fc.asyncProperty(script, fc.nat({ max: 20 }), async (s, k) => {
        const provider = new OllamaProvider(new FakeHttp(s), () => 'http://127.0.0.1:11434', () => 32768);
        const { events, abortedAt } = await run(provider, [{ role: 'user', content: 'hi' }], k);
        const dones = events.filter((e) => e.type === 'done');
        expect(dones).toHaveLength(1);
        expect(events.at(-1)?.type).toBe('done');
        if (abortedAt !== null && abortedAt < events.length) {
          // The stream had not finished when we aborted.
          expect(events.slice(abortedAt)).toEqual([{ type: 'done', reason: 'aborted' }]);
          expect(events.slice(0, abortedAt).map(shape)).toEqual(expectedEvents(s).slice(0, abortedAt));
        }
      }),
    );
  });

  it('O1: an abort that lands while a read is pending (the Stop button) ends with only done: aborted', async () => {
    await fc.assert(
      fc.asyncProperty(script, fc.nat({ max: 20 }), async (s, k) => {
        const provider = new OllamaProvider(new FakeHttp(s, true), () => 'http://127.0.0.1:11434', () => 32768);
        const controller = new AbortController();
        const events: ChatEvent[] = [];
        let abortedAt: number | null = null;
        for await (const e of provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, controller.signal)) {
          events.push(e);
          if (events.length === k) {
            // Fires after the consumer has asked for the next event, while the stream is awaiting I/O.
            setImmediate(() => {
              abortedAt = events.length;
              controller.abort();
            });
          }
        }
        expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
        expect(events.at(-1)?.type).toBe('done');
        if (abortedAt !== null && abortedAt < events.length) {
          expect(events.slice(abortedAt)).toEqual([{ type: 'done', reason: 'aborted' }]);
        }
      }),
    );
  });

  it('O1: aborting before the request starts yields only done: aborted', async () => {
    const s: Script = { status: 200, errorBody: '', lines: [{ kind: 'delta', content: 'x' }], ending: 'close', offsets: [], requestThrows: false, thinking: false, showFails: false };
    const controller = new AbortController();
    controller.abort();
    const events: ChatEvent[] = [];
    for await (const e of new OllamaProvider(new FakeHttp(s), () => 'http://h', () => 32768).stream({ model: 'm', messages: [] }, controller.signal)) events.push(e);
    expect(events).toEqual([{ type: 'done', reason: 'aborted' }]);
  });
});

describe('OllamaProvider requests (INVARIANTS.md O2)', () => {
  it('O2: requests go only to the configured server and carry exactly the conversation', async () => {
    await fc.assert(
      fc.asyncProperty(baseUrl, fc.string({ minLength: 1 }), fc.array(message, { maxLength: 6 }), fc.boolean(), fc.integer({ min: 2048, max: 1048576 }), fc.array(tool, { maxLength: 2 }), async (base, model, messages, thinking, ctx, tools) => {
        const http = new FakeHttp({ status: 200, errorBody: '', lines: [{ kind: 'done' }], ending: 'close', offsets: [], requestThrows: false, thinking, showFails: false });
        const provider = new OllamaProvider(http, () => base, () => ctx);
        const input = structuredClone(messages);
        for await (const _ of provider.stream({ model, messages, tools }, new AbortController().signal)) { /* drain */ }

        expect(messages).toEqual(input); // not mutated
        for (const r of http.requests) {
          expect([`${base}/api/show`, `${base}/api/chat`]).toContain(r.url);
          expect(r.method).toBe('POST');
        }
        const chat = http.requests.find((r) => r.url === `${base}/api/chat`)!;
        const body = JSON.parse(chat.body!) as Record<string, unknown>;
        // The fake server reports a context length of 8192 for every model.
        expect(body).toEqual({
          model,
          // What is on the wire: JSON writes -0 in tool arguments as 0 (see the regression test below).
          messages: JSON.parse(JSON.stringify(input.map(ollamaMessage))) as unknown,
          ...(tools.length > 0 ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
          stream: true,
          options: { num_ctx: Math.min(ctx, 8192) },
          ...(thinking ? { think: true } : {}),
        });
        expect((await provider.capabilities(model)).contextWindow).toBe(Math.min(ctx, 8192));
        const show = http.requests.find((r) => r.url === `${base}/api/show`)!;
        expect(JSON.parse(show.body!)).toEqual({ model });
      }),
    );
  });
});

describe('OllamaProvider request encoding', () => {
  // Regression (O2, full-suite run, seed not captured): fc.jsonValue() produced -0 inside tool-call
  // arguments; JSON sends it as 0. The model compared against the in-memory -0; the request was right.
  it('sends tool-call arguments as JSON (so -0 becomes 0)', async () => {
    const http = new FakeHttp({ status: 200, errorBody: '', lines: [{ kind: 'done' }], ending: 'close', offsets: [], requestThrows: false, thinking: false, showFails: false });
    const provider = new OllamaProvider(http, () => 'http://h', () => 32768);
    const messages: ChatMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'web_search', arguments: { n: -0 } }] }];
    for await (const _ of provider.stream({ model: 'm', messages }, new AbortController().signal)) { /* drain */ }
    const body = JSON.parse(http.requests.find((r) => r.url.endsWith('/api/chat'))!.body!) as { messages: Array<{ tool_calls: Array<{ function: { arguments: { n: number } } }> }> };
    expect(Object.is(body.messages[0]!.tool_calls[0]!.function.arguments.n, 0)).toBe(true);
  });
});

describe('OllamaProvider errors', () => {
  it('names the server it could not reach', async () => {
    const down: HttpClient = { request: () => Promise.reject(new TypeError('fetch failed')) };
    const provider = new OllamaProvider(down, () => 'http://127.0.0.1:9', () => 32768);
    await expect(provider.listModels()).rejects.toThrow('Could not reach Ollama at http://127.0.0.1:9. Is it running?');
    const events: ChatEvent[] = [];
    for await (const e of provider.stream({ model: 'm', messages: [] }, new AbortController().signal)) events.push(e);
    expect(events).toEqual([
      { type: 'error', message: 'Could not reach Ollama at http://127.0.0.1:9. Is it running?' },
      { type: 'done', reason: 'error' },
    ]);
  });
});
