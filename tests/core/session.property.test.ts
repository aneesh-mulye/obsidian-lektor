// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md C1–C5: the chat session, as a stateful model. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ChatSession } from '../../src/core/chat/session';
import type { Chat } from '../../src/core/chat/types';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import type { Capabilities, ChatEvent, ChatMessage, ChatProvider, ChatRequest, ModelRef } from '../../src/core/providers/types';

// ---------------------------------------------------------------------------
// A provider the test drives by hand. It ignores abort signals on purpose.

class Channel {
  readonly queue: Array<{ event: ChatEvent } | { end: true } | { fail: Error }> = [];
  wake: (() => void) | null = null;
  closed = false;
  push(item: Channel['queue'][number]): void {
    if (this.closed) return;
    this.queue.push(item);
    if ('end' in item || 'fail' in item) this.closed = true;
    this.wake?.();
  }
  async *iterate(): AsyncGenerator<ChatEvent> {
    for (;;) {
      while (this.queue.length === 0) await new Promise<void>((r) => (this.wake = r));
      const item = this.queue.shift()!;
      if ('end' in item) return;
      if ('fail' in item) throw item.fail;
      yield item.event;
    }
  }
}

class FakeProvider implements ChatProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  readonly requests: ChatMessage[][] = [];
  readonly channels: Channel[] = [];
  failNextCapabilities = false;
  window = 4096;

  capabilities(_model: string): Promise<Capabilities> {
    if (this.failNextCapabilities) {
      this.failNextCapabilities = false;
      return Promise.reject(new Error('unknown model'));
    }
    return Promise.resolve({ toolCalling: 'none', nativeWebSearch: false, images: false, contextWindow: this.window });
  }
  listModels() {
    return Promise.resolve([{ id: 'm', name: 'm' }]);
  }
  stream(req: ChatRequest, _signal: AbortSignal): AsyncIterable<ChatEvent> {
    this.requests.push(structuredClone(req.messages));
    const ch = new Channel();
    this.channels.push(ch);
    return ch.iterate();
  }
}

const settle = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Model

type Status = 'streaming' | 'complete' | 'stopped' | 'truncated' | 'error';
interface MMsg {
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: Status | null;
}
interface Model {
  messages: MMsg[];
  busy: boolean;
  model: ModelRef;
  /** Index of the fake channel feeding the streaming reply, if any. */
  channel: number | null;
  channelsOpened: number;
  expectedRequests: ChatMessage[][];
  failNextCapabilities: boolean;
  pendingError: boolean;
  window: number;
  /** Tokens the (fake) context message is estimated at; 0 means no context. */
  contextTokens: number;
  failNextPrepare: boolean;
  calibration: number;
  /** The live reply's estimate and reported prompt size, for calibration. */
  replyEstimate: number;
  replyInput: number | null;
}
interface Real {
  session: ChatSession;
  provider: FakeProvider;
  saved: Chat | null;
  contextTokens: number;
  failNextPrepare: boolean;
}

/** C6's budget rule, written independently: ~1 token per 3 bytes, 4 per message, a fifth of the window for the reply. */
const bytes = (t: string) => new TextEncoder().encode(t).length;
const estimateOf = (m: Model, history: MMsg[]) => m.contextTokens + project(history).reduce((t, x) => t + Math.ceil(bytes(x.content) / 3) + 4, 0);
const reserve = (w: number) => Math.min(8192, Math.max(1024, Math.round(w * 0.2)));
const fitsModel = (m: Model, estimate: number) => Math.ceil(estimate * m.calibration) + reserve(m.window) <= m.window;
const contextMessage = (n: number) => `CONTEXT(${n})`;

/** C1's projection, written independently of src/core/chat/transcript.ts. */
function project(messages: MMsg[]): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === 'user') return [{ role: 'user', content: m.content }];
    if (m.content !== '' && (m.status === 'complete' || m.status === 'stopped' || m.status === 'truncated')) return [{ role: 'assistant', content: m.content }];
    return [];
  });
}

function startReply(m: Model, history: MMsg[]): void {
  m.messages = [...history, { role: 'assistant', content: '', reasoning: '', status: 'streaming' }];
  m.busy = true;
  m.pendingError = false;
  if (m.model.provider !== 'fake') {
    finishReply(m, 'error');
    return;
  }
  if (m.failNextCapabilities) {
    m.failNextCapabilities = false;
    finishReply(m, 'error');
    return;
  }
  if (m.failNextPrepare) {
    m.failNextPrepare = false;
    finishReply(m, 'error');
    return;
  }
  const estimate = estimateOf(m, history);
  if (!fitsModel(m, estimate)) {
    finishReply(m, 'error');
    return;
  }
  // C6: exactly the context message (if any) followed by the C1 transcript.
  const system: ChatMessage[] = m.contextTokens > 0 ? [{ role: 'system', content: contextMessage(m.contextTokens) }] : [];
  m.expectedRequests.push([...system, ...project(history)]);
  m.channel = m.channelsOpened++;
  m.replyEstimate = estimate;
  m.replyInput = null;
}

function finishReply(m: Model, status: Status): void {
  m.messages[m.messages.length - 1]!.status = status;
  m.busy = false;
  m.channel = null;
}

async function check(m: Model, r: Real): Promise<void> {
  await settle();
  const actual = r.session.chat.messages.map((x) => ({
    role: x.role,
    content: x.content,
    reasoning: x.role === 'assistant' ? x.reasoning : '',
    status: x.role === 'assistant' ? x.status : null,
  }));
  expect(actual).toEqual(m.messages);
  expect(r.session.busy).toBe(m.busy);
  // C1: every request the provider saw is exactly the visible transcript before its reply.
  expect(r.provider.requests).toEqual(m.expectedRequests);
  // C2: one stream at a time: the provider was never asked for more streams than the model opened.
  expect(r.provider.channels.length).toBe(m.channelsOpened);
  // C5: when idle, what was saved is what is shown.
  if (!m.busy && m.messages.length > 0) expect(r.saved).toEqual(r.session.chat);
}

type Cmd = fc.AsyncCommand<Model, Real>;
const cmd = (name: string, run: (m: Model, r: Real) => Promise<void> | void): Cmd => ({
  check: () => true,
  run: async (m, r) => {
    await run(m, r);
    await check(m, r);
  },
  toString: () => name,
});

const send = (text: string): Cmd =>
  cmd(`send(${JSON.stringify(text)})`, (m, r) => {
    const ok = r.session.send(text);
    const expected = !m.busy && text.trim() !== '';
    expect(ok).toBe(expected);
    if (expected) startReply(m, [...m.messages, { role: 'user', content: text, reasoning: '', status: null }]);
  });

const regenerate = (): Cmd =>
  cmd('regenerate()', (m, r) => {
    const ok = r.session.regenerate();
    const expected = !m.busy && m.messages.at(-1)?.role === 'assistant';
    expect(ok).toBe(expected);
    if (expected) startReply(m, m.messages.slice(0, -1));
  });

const stop = (): Cmd =>
  cmd('stop()', (m, r) => {
    r.session.stop();
    if (m.busy) finishReply(m, 'stopped');
  });

const setModel = (provider: string): Cmd =>
  cmd(`setModel(${provider})`, (m, r) => {
    m.model = { provider, model: 'm' };
    r.session.setModel(m.model);
  });

const failCapabilities = (): Cmd =>
  cmd('failNextCapabilities()', (m, r) => {
    m.failNextCapabilities = true;
    r.provider.failNextCapabilities = true;
  });

/** Push to the newest channel; the model applies it only if that channel still feeds the live reply. */
function feed(m: Model, r: Real, item: Channel['queue'][number], apply: (reply: MMsg) => void): void {
  const latest = r.provider.channels.length - 1;
  if (latest < 0) return;
  r.provider.channels[latest]!.push(item);
  if (m.busy && m.channel === latest) apply(m.messages[m.messages.length - 1]!);
}

const emit = (kind: 'text' | 'reasoning', text: string): Cmd =>
  cmd(`emit(${kind}, ${JSON.stringify(text)})`, (m, r) =>
    feed(m, r, { event: { type: kind, text } }, (reply) => {
      if (kind === 'text') reply.content += text;
      else reply.reasoning += text;
    }),
  );

const emitError = (): Cmd =>
  cmd('emit(error)', (m, r) => feed(m, r, { event: { type: 'error', message: 'boom' } }, () => (m.pendingError = true)));

const finish = (reason: 'stop' | 'length' | 'error' | 'aborted'): Cmd =>
  cmd(`done(${reason})`, (m, r) =>
    feed(m, r, { event: { type: 'done', reason } }, () => {
      if ((reason === 'stop' || reason === 'length') && m.replyInput !== null && m.replyEstimate > 0) {
        m.calibration = Math.min(4, Math.max(1, m.replyInput / m.replyEstimate));
      }
      const status: Status = reason === 'stop' ? 'complete' : reason === 'length' ? 'truncated' : reason === 'aborted' ? 'stopped' : 'error';
      finishReply(m, status);
    }),
  );

const emitUsage = (input: number): Cmd =>
  cmd(`usage(${input})`, (m, r) => feed(m, r, { event: { type: 'usage', inputTokens: input, outputTokens: 1 } }, () => (m.replyInput = input)));

const setContextSize = (n: number): Cmd =>
  cmd(`contextSize(${n})`, (m, r) => {
    m.contextTokens = n;
    r.contextTokens = n;
  });

const failPrepare = (): Cmd =>
  cmd('failNextPrepare()', (m, r) => {
    m.failNextPrepare = true;
    r.failNextPrepare = true;
  });

const endEarly = (): Cmd => cmd('end-without-done', (m, r) => feed(m, r, { end: true }, () => finishReply(m, 'error')));
const throwInStream = (): Cmd => cmd('throw', (m, r) => feed(m, r, { fail: new Error('socket') }, () => finishReply(m, 'error')));

// Weighted towards the actions that make up a conversation, and sized large: fc.commands
// otherwise favours runs of a handful of steps, too short to reach many interesting states.
const commands = fc.commands(
  [
    fc.oneof({ weight: 3, arbitrary: fc.constantFrom('hello', 'again', 'x') }, fc.string({ maxLength: 8 }), fc.constantFrom('  ', '')).map(send),
    // Long messages, so the transcript itself can overflow the window.
    fc.integer({ min: 1000, max: 12000 }).map((n) => send('w'.repeat(n))),
    fc.constant(regenerate()),
    fc.constant(stop()),
    fc.constantFrom('fake', 'fake', 'fake', 'missing').map(setModel),
    fc.constant(failCapabilities()),
    fc.tuple(fc.constantFrom('text' as const, 'text' as const, 'reasoning' as const), fc.string({ minLength: 1, maxLength: 6 })).map(([k, t]) => emit(k, t)),
    fc.tuple(fc.constantFrom('text' as const, 'reasoning' as const), fc.string({ minLength: 1, maxLength: 6 })).map(([k, t]) => emit(k, t)),
    fc.constant(emitError()),
    fc.constantFrom('stop' as const, 'length' as const, 'error' as const, 'aborted' as const).map(finish),
    fc.constantFrom('stop' as const, 'error' as const).map(finish),
    fc.constant(endEarly()),
    fc.constant(throwInStream()),
    fc.integer({ min: 0, max: 20000 }).map(emitUsage),
    fc.constantFrom(0, 0, 20, 400, 1500, 3000, 6000).map(setContextSize),
    fc.constant(failPrepare()),
  ],
  { maxCommands: 60, size: 'large' },
);

function setup(window = 4096): { model: Model; real: Real } {
  const provider = new FakeProvider();
  provider.window = window;
  let n = 0;
  const real: Real = { provider, saved: null, session: undefined as unknown as ChatSession, contextTokens: 0, failNextPrepare: false };
  const chat: Chat = { id: 'chat-1', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'fake', model: 'm' }, messages: [], context: EMPTY_CONTEXT };
  real.session = new ChatSession(chat, {
    prepare: () => {
      if (real.failNextPrepare) {
        real.failNextPrepare = false;
        return Promise.reject(new Error('cannot read'));
      }
      const t = real.contextTokens;
      const manifest = { notes: [], selections: [], backlinkLists: 0, excluded: 0 };
      return Promise.resolve(t > 0 ? { message: contextMessage(t), tokens: t, manifest, urls: [] } : { message: null, tokens: 0, manifest, urls: [] });
    },
    providers: { get: (id) => (id === 'fake' ? provider : undefined) },
    clock: { now: () => ++n },
    newId: () => `id-${++n}`,
    save: (c) => {
      real.saved = structuredClone(c);
      return Promise.resolve();
    },
  });
  return {
    real,
    model: {
      messages: [], busy: false, model: { provider: 'fake', model: 'm' }, channel: null, channelsOpened: 0, expectedRequests: [],
      failNextCapabilities: false, pendingError: false, window, contextTokens: 0, failNextPrepare: false, calibration: 1, replyEstimate: 0, replyInput: null,
    },
  };
}

describe('ChatSession (INVARIANTS.md C1–C5)', () => {
  it('C1–C6 hold for any sequence of user and provider actions', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2048, max: 9000 }), commands, async (window, cmds) => {
        await fc.asyncModelRun(() => setup(window), cmds);
      }),
    );
  });

  it('C6: refuses an over-budget message with an explanation and never calls the provider', async () => {
    const { real } = setup(4096);
    real.contextTokens = 5000;
    real.session.send('hi');
    await settle();
    expect(real.provider.requests).toEqual([]);
    const reply = real.session.chat.messages[1]!;
    expect(reply).toMatchObject({ status: 'error' });
    expect(reply.role === 'assistant' && reply.error).toContain("doesn't fit the model's context length of 4.1k");
  });

  it('C3: a stopped reply never changes, even if the provider keeps talking', async () => {
    const { real } = setup();
    real.session.send('hi');
    await settle();
    real.provider.channels[0]!.push({ event: { type: 'text', text: 'a' } });
    await settle();
    real.session.stop();
    real.provider.channels[0]!.push({ event: { type: 'text', text: 'LATE' } });
    real.provider.channels[0]!.push({ event: { type: 'done', reason: 'stop' } });
    await settle();
    const reply = real.session.chat.messages[1]!;
    expect(reply).toMatchObject({ role: 'assistant', content: 'a', status: 'stopped' });
  });

  it('C1: reasoning and failed replies are never sent back to the model', async () => {
    const { real } = setup();
    real.session.send('one');
    await settle();
    real.provider.channels[0]!.push({ event: { type: 'reasoning', text: 'secret thoughts' } });
    real.provider.channels[0]!.push({ event: { type: 'text', text: 'answer' } });
    real.provider.channels[0]!.push({ event: { type: 'done', reason: 'stop' } });
    await settle();
    real.session.send('two');
    await settle();
    real.provider.channels[1]!.push({ event: { type: 'text', text: 'half' } });
    real.provider.channels[1]!.push({ event: { type: 'done', reason: 'error' } });
    await settle();
    real.session.send('three');
    await settle();
    expect(real.provider.requests[2]).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });

  it('C6: a reported prompt size calibrates later estimates (never below 1)', async () => {
    const { real } = setup(4096);
    real.contextTokens = 1000;
    real.session.send('hi');
    await settle();
    // Ollama says the prompt was four times the estimate.
    real.provider.channels[0]!.push({ event: { type: 'usage', inputTokens: 4000, outputTokens: 1 } });
    real.provider.channels[0]!.push({ event: { type: 'done', reason: 'stop' } });
    await settle();
    expect(real.session.calibration).toBeGreaterThan(3.9);
    real.session.send('again'); // ~1,010 estimated, ×3.9 ≈ 4,000 — no longer fits 4,096 with room for a reply
    await settle();
    expect(real.provider.requests).toHaveLength(1);
    expect(real.session.chat.messages[3]).toMatchObject({ status: 'error' });

    const low = setup(4096).real;
    low.session.send('hi');
    await settle();
    low.provider.channels[0]!.push({ event: { type: 'usage', inputTokens: 1, outputTokens: 1 } });
    low.provider.channels[0]!.push({ event: { type: 'done', reason: 'stop' } });
    await settle();
    expect(low.session.calibration).toBe(1);
  });

  it('C6: the transcript counts towards the budget, not just the context', async () => {
    const { real } = setup(4096);
    real.session.send('w'.repeat(10000)); // 3,334 + 4 tokens + 1,024 reserve = 4,362 > 4,096
    await settle();
    expect(real.provider.requests).toEqual([]);
    expect(real.session.chat.messages[1]).toMatchObject({ status: 'error' });
    // …while 9,000 characters (3,004 + 1,024 = 4,028) still fits, in a fresh chat
    // (the refused message stays in this one's transcript, as the user sees it).
    const fresh = setup(4096).real;
    fresh.session.send('w'.repeat(9000));
    await settle();
    expect(fresh.provider.requests).toHaveLength(1);
  });

  it('fails closed when capabilities cannot be read', async () => {
    const { real } = setup();
    real.provider.failNextCapabilities = true;
    expect(real.session.send('hi')).toBe(true);
    await settle();
    expect(real.provider.requests).toEqual([]);
    const reply = real.session.chat.messages[1]!;
    expect(reply).toMatchObject({ status: 'error' });
    expect(reply.role === 'assistant' && reply.error).toContain('unknown model');
  });

  it('titles a chat from its first message', async () => {
    const { real } = setup();
    real.session.send('  What is the capital of Burkina Faso, and how is it pronounced in Mooré?\nMore');
    await settle();
    expect(real.session.chat.title).toBe('What is the capital of Burkina Faso, and how is it…');
  });
});
