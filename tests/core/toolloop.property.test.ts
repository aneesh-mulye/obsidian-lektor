// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md C7: the tool loop, as a stateful model. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_TOOL_ROUNDS, ChatSession } from '../../src/core/chat/session';
import type { Chat, ToolsDeps } from '../../src/core/chat/types';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import type { Capabilities, ChatEvent, ChatMessage, ChatProvider, ChatRequest } from '../../src/core/providers/types';
import { z } from 'zod';
import { ToolRegistry } from '../../src/core/tools/registry';
import { PROSE, toolRuns } from '../../src/core/tools/run';

class Channel {
  readonly queue: Array<ChatEvent | 'end'> = [];
  wake: (() => void) | null = null;
  push(e: ChatEvent | 'end'): void {
    this.queue.push(e);
    this.wake?.();
  }
  async *iterate(): AsyncGenerator<ChatEvent> {
    for (;;) {
      while (this.queue.length === 0) await new Promise<void>((r) => (this.wake = r));
      const e = this.queue.shift()!;
      if (e === 'end') return;
      yield e;
    }
  }
}

class FakeProvider implements ChatProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  readonly requests: Array<{ messages: ChatMessage[]; tools: boolean }> = [];
  readonly channels: Channel[] = [];
  constructor(readonly toolCalling: Capabilities['toolCalling']) {}
  capabilities() {
    return Promise.resolve({ toolCalling: this.toolCalling, nativeWebSearch: false, images: false, contextWindow: 1_000_000 });
  }
  listModels() {
    return Promise.resolve([]);
  }
  stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push({ messages: structuredClone(req.messages), tools: (req.tools?.length ?? 0) > 0 });
    const ch = new Channel();
    this.channels.push(ch);
    return ch.iterate();
  }
}

/** Tools named by behaviour: ok succeeds, bad fails, ask needs approval. */
const fakeTools: ToolsDeps = {
  forReply({ chat, capabilities }) {
    if (chat.toolsDisabled || capabilities.toolCalling !== 'native') return null;
    return {
      definitions: ['ok', 'bad', 'ask'].map((name) => ({ name, description: name, parameters: { type: 'object' } })),
      async execute(call, _signal, approve) {
        if (call.name === 'ok') return { ok: true, content: `R-${call.id}`, summary: 'ok' };
        if (call.name === 'ask') {
          const yes = await approve({ tool: 'ask', title: 'Allow?', detail: call.id });
          return yes ? { ok: true, content: `A-${call.id}`, summary: 'ok' } : { ok: false, content: 'declined', summary: 'declined' };
        }
        return { ok: false, content: `E-${call.id}`, summary: 'failed' };
      },
    };
  },
};

const settle = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Model

interface MCall { id: string; name: string; result: { ok: boolean; content: string } | null }
interface MRound { text: string; calls: MCall[] }
interface MMsg { role: 'user' | 'assistant'; content: string; status: string | null; steps: MRound[] }

interface Model {
  native: boolean;
  toolsOn: boolean;
  /** The switch as it was when this reply started: it applies from the next message. */
  replyTools: boolean;
  messages: MMsg[];
  busy: boolean;
  round: number;
  offered: boolean;
  pendingCalls: MCall[];
  /** Index into the current round's calls of a call waiting for approval. */
  waiting: number | null;
  baseRequest: ChatMessage[];
  expected: Array<{ messages: ChatMessage[]; tools: boolean }>;
  nextCall: number;
}
interface Real {
  session: ChatSession;
  provider: FakeProvider;
}

/** The model's own projection of tool rounds (C7), written independently. */
function project(rounds: MRound[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rounds) {
    const done = r.calls.filter((c) => c.result !== null);
    if (done.length === 0) {
      if (r.text) out.push({ role: 'assistant', content: r.text });
      continue;
    }
    out.push({ role: 'assistant', content: r.text, toolCalls: done.map((c) => ({ id: c.id, name: c.name, arguments: {} })) });
    for (const c of done) out.push({ role: 'tool', content: c.result!.content, toolName: c.name, toolCallId: c.id });
  }
  return out;
}

function transcript(messages: MMsg[]): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === 'user') return [{ role: 'user', content: m.content }];
    if (m.status !== 'complete' && m.status !== 'stopped' && m.status !== 'truncated') return [];
    const out = project(m.steps);
    if (m.content) out.push({ role: 'assistant', content: m.content });
    return out;
  });
}

const reply = (m: Model) => m.messages[m.messages.length - 1]!;

function request(m: Model): void {
  m.offered = m.native && m.replyTools && m.round < MAX_TOOL_ROUNDS - 1;
  m.expected.push({ messages: [...m.baseRequest, ...project(reply(m).steps)], tools: m.offered });
}

/** Run the current round's calls in order until one waits for approval; then start the next round. */
function runCalls(m: Model): void {
  const round = reply(m).steps[reply(m).steps.length - 1]!;
  for (let i = 0; i < round.calls.length; i++) {
    const c = round.calls[i]!;
    if (c.result !== null) continue;
    if (c.name === 'ask') {
      m.waiting = i;
      return;
    }
    c.result = c.name === 'ok' ? { ok: true, content: `R-${c.id}` } : { ok: false, content: `E-${c.id}` };
  }
  m.waiting = null;
  m.round += 1;
  request(m);
}

async function check(m: Model, r: Real): Promise<void> {
  await settle();
  const actual = r.session.chat.messages.map((x) => ({
    role: x.role,
    content: x.content,
    status: x.role === 'assistant' ? x.status : null,
    steps: x.role === 'assistant' ? (x.steps ?? []).map((s) => ({ text: s.text, calls: s.calls.map((c) => ({ id: c.id, name: c.name, result: c.result ? { ok: c.result.ok, content: c.result.content } : null })) })) : [],
  }));
  expect(actual).toEqual(m.messages);
  expect(r.session.busy).toBe(m.busy);
  expect(r.provider.requests).toEqual(m.expected);
  const last = r.session.chat.messages.at(-1);
  expect(last?.role === 'assistant' && last.approval !== undefined).toBe(m.waiting !== null);
}

type Cmd = fc.AsyncCommand<Model, Real>;
const cmd = (name: string, run: (m: Model, r: Real) => void): Cmd => ({
  check: () => true,
  run: async (m, r) => {
    run(m, r);
    await check(m, r);
  },
  toString: () => name,
});

const latest = (r: Real) => r.provider.channels[r.provider.channels.length - 1];
const liveRound = (m: Model) => m.busy && m.waiting === null;

const commands = fc.commands(
  [
    fc.constantFrom('hi', 'again').map((t) =>
      cmd(`send(${t})`, (m, r) => {
        const ok = r.session.send(t);
        expect(ok).toBe(!m.busy);
        if (!ok) return;
        m.messages.push({ role: 'user', content: t, status: null, steps: [] });
        m.baseRequest = transcript(m.messages);
        m.messages.push({ role: 'assistant', content: '', status: 'streaming', steps: [] });
        m.busy = true;
        m.replyTools = m.toolsOn;
        m.round = 0;
        m.pendingCalls = [];
        request(m);
      }),
    ),
    fc.string({ minLength: 1, maxLength: 4 }).map((t) =>
      cmd(`text(${t})`, (m, r) => {
        latest(r)?.push({ type: 'text', text: t });
        if (liveRound(m)) reply(m).content += t;
      }),
    ),
    fc.constantFrom('ok', 'bad', 'ask').map((name) =>
      cmd(`call(${name})`, (m, r) => {
        const id = `c${m.nextCall++}`;
        latest(r)?.push({ type: 'tool_call', call: { id, name, arguments: {} } });
        if (liveRound(m) && m.offered) m.pendingCalls.push({ id, name, result: null });
      }),
    ),
    fc.constantFrom('stop' as const, 'error' as const).map((reason) =>
      cmd(`done(${reason})`, (m, r) => {
        latest(r)?.push({ type: 'done', reason });
        if (!liveRound(m)) return;
        if (reason === 'stop' && m.pendingCalls.length > 0) {
          reply(m).steps.push({ text: reply(m).content, calls: m.pendingCalls });
          reply(m).content = '';
          m.pendingCalls = [];
          runCalls(m);
          return;
        }
        reply(m).status = reason === 'stop' ? 'complete' : 'error';
        m.busy = false;
      }),
    ),
    fc.boolean().map((yes) =>
      cmd(`approve(${yes})`, (m, r) => {
        const last = r.session.chat.messages.at(-1);
        if (last?.role !== 'assistant' || !last.approval) return;
        r.session.answerApproval(last.approval.id, yes);
        const round = reply(m).steps[reply(m).steps.length - 1]!;
        const c = round.calls[m.waiting!]!;
        c.result = yes ? { ok: true, content: `A-${c.id}` } : { ok: false, content: 'declined' };
        runCalls(m);
      }),
    ),
    fc.constant(
      cmd('stop()', (m, r) => {
        r.session.stop();
        if (!m.busy) return;
        if (reply(m).status === 'streaming') reply(m).status = 'stopped';
        m.busy = false;
        m.waiting = null;
        m.pendingCalls = [];
      }),
    ),
    fc.boolean().map((on) =>
      cmd(`tools(${on})`, (m, r) => {
        r.session.setTools(on);
        m.toolsOn = on;
      }),
    ),
  ],
  { maxCommands: 80, size: 'large' },
);

function setup(native: boolean): { model: Model; real: Real } {
  const provider = new FakeProvider(native ? 'native' : 'none');
  let n = 0;
  const chat: Chat = { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'fake', model: 'm' }, messages: [], context: EMPTY_CONTEXT };
  const session = new ChatSession(chat, {
    providers: { get: () => provider },
    clock: { now: () => ++n },
    newId: () => `id${++n}`,
    save: () => Promise.resolve(),
    tools: fakeTools,
  });
  return {
    real: { session, provider },
    model: { native, toolsOn: true, replyTools: true, messages: [], busy: false, round: 0, offered: false, pendingCalls: [], waiting: null, baseRequest: [], expected: [], nextCall: 0 },
  };
}

describe('tool loop (INVARIANTS.md C7)', () => {
  it('C7: requests, rounds, approvals and Stop follow the model', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), commands, async (native, cmds) => {
        await fc.asyncModelRun(() => setup(native), cmds);
      }),
    );
  });

  it('C7: Stop during an approval declines it, so the waiting tool call finishes instead of hanging', async () => {
    let settled: boolean | null = null;
    const provider = new FakeProvider('native');
    const tools: ToolsDeps = {
      forReply: () => ({
        definitions: [{ name: 'ask', description: 'ask', parameters: { type: 'object' } }],
        async execute(_call, _signal, approve) {
          settled = await approve({ tool: 'ask', title: 'Allow?', detail: 'x' });
          return { ok: settled, content: 'r', summary: 's' };
        },
      }),
    };
    let n = 0;
    const session = new ChatSession(
      { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'fake', model: 'm' }, messages: [], context: EMPTY_CONTEXT },
      { providers: { get: () => provider }, clock: { now: () => ++n }, newId: () => `id${++n}`, save: () => Promise.resolve(), tools },
    );
    session.send('go');
    await settle();
    provider.channels[0]!.push({ type: 'tool_call', call: { id: 'a', name: 'ask', arguments: {} } });
    provider.channels[0]!.push({ type: 'done', reason: 'stop' });
    await settle();
    expect(session.chat.messages.at(-1)).toHaveProperty('approval');
    session.stop();
    await settle();
    expect(settled).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(session.chat.messages.at(-1)).not.toHaveProperty('approval');
  });

  it('C7: the loop ends after at most 8 requests per reply, the last without tools', async () => {
    const { real } = setup(true);
    real.session.send('go');
    for (let i = 0; i < 20; i++) {
      await settle();
      const ch = real.provider.channels.at(-1)!;
      ch.push({ type: 'tool_call', call: { id: `x${i}`, name: 'ok', arguments: {} } });
      ch.push({ type: 'done', reason: 'stop' });
    }
    await settle();
    expect(real.provider.requests).toHaveLength(MAX_TOOL_ROUNDS);
    expect(real.provider.requests.map((q) => q.tools)).toEqual([...Array<boolean>(MAX_TOOL_ROUNDS - 1).fill(true), false]);
    expect(real.session.busy).toBe(false);
  });

  it('B5: a chat switched to Prose sends the Prose instruction and offers no tools that propose; the mode is saved with the chat', async () => {
    const provider = new FakeProvider('native');
    const saved: Chat[] = [];
    let n = 0;
    const chat: Chat = { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'fake', model: 'm' }, messages: [], context: EMPTY_CONTEXT, displayMode: 'inline' };
    const registry = new ToolRegistry();
    for (const name of ['propose_edit', 'propose_note']) {
      registry.register({ name, description: name, schema: z.object({}), approval: 'never', touchesVault: false, run: () => Promise.resolve({ content: '', summary: '' }) });
    }
    const session = new ChatSession(chat, {
      providers: { get: () => provider },
      clock: { now: () => ++n },
      newId: () => `id${++n}`,
      save: (c) => {
        saved.push(c);
        return Promise.resolve();
      },
      tools: toolRuns(registry, { webNames: () => [], reviewNames: () => ['propose_edit', 'propose_note'], displayMode: () => 'sidebar', limits: () => ({ searches: 1, fetches: 1 }) }),
    });
    session.setDisplayMode('prose');
    session.send('Any fixes?');
    await settle();
    provider.channels[0]!.push({ type: 'done', reason: 'stop' });
    await settle();
    expect(provider.requests[0]!.tools).toBe(false);
    expect(provider.requests[0]!.messages.filter((m) => m.role === 'system').map((m) => m.content)).toEqual([PROSE]);
    expect(saved.at(-1)?.displayMode).toBe('prose');
  });
});
