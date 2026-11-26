// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md A4: what the user shares through request_context flows through a real session. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatSession } from '../../src/core/chat/session';
import type { Chat } from '../../src/core/chat/types';
import { prepareContext } from '../../src/core/context/prepare';
import { EMPTY_CONTEXT, addNote, addShared } from '../../src/core/context/state';
import type { ChatEvent, ChatMessage, ChatProvider, ChatRequest } from '../../src/core/providers/types';
import { requestContextTool } from '../../src/core/tools/context';
import { ToolRegistry } from '../../src/core/tools/registry';
import { toolRuns } from '../../src/core/tools/run';
import { type World, latin1, openWorld, pngBytes } from './attachments.fixtures';

const enc = new TextEncoder();
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function testWorld(): World {
  return {
    spec: {
      notes: [
        { path: 'a.md', content: 'ASENT links [[b]]', links: ['b.md'] },
        { path: 'b.md', content: 'BSENT https://b.example/page', links: [] },
        { path: 'c.md', content: 'CSENT', links: [] },
      ],
      attachments: ['img.png', 'notes.txt'],
      bytes: { 'img.png': pngBytes(56, 56, ascii(' IMGSENT ')), 'notes.txt': enc.encode('TXTSENT') },
      patterns: [],
      obsidianFilters: [],
      respectObsidian: false,
    },
    kinds: new Map([
      ['img.png', 'png'],
      ['notes.txt', 'text'],
    ]),
    sentinels: new Map(),
    noteSentinels: new Map(),
  };
}

/** A provider that answers each request from a script. */
class Scripted implements ChatProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  readonly requests: ChatRequest[] = [];
  constructor(
    readonly vision: boolean,
    readonly script: Array<(req: ChatRequest) => ChatEvent[]>,
  ) {}
  capabilities() {
    return Promise.resolve({ toolCalling: 'native' as const, nativeWebSearch: false, images: this.vision, contextWindow: 1_000_000 });
  }
  listModels() {
    return Promise.resolve([]);
  }
  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    await Promise.resolve();
    this.requests.push(structuredClone(req));
    const step = this.script[this.requests.length - 1];
    for (const e of step ? step(req) : [{ type: 'text' as const, text: 'done' }, { type: 'done' as const, reason: 'stop' as const }]) yield e;
  }
}

/** Wait until the condition holds (the session works through several awaits per step). */
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 10_000 && !cond(); i++) await new Promise<void>((r) => setImmediate(r));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};
const waiting = (s: ChatSession) => {
  const m = s.chat.messages.at(-1);
  return m?.role === 'assistant' && m.approval !== undefined;
};
const idle = (s: ChatSession) => !s.busy;
const text = (m: ChatMessage[]) => m.map((x) => x.content).join('\n');
const imageText = (m: ChatMessage[]) =>
  m
    .flatMap((x) => (x.role === 'user' ? (x.images ?? []) : []))
    .map((i) => latin1(i.data))
    .join('\n');

function setup(vision: boolean, storeFull: boolean, script: Scripted['script']) {
  const w = testWorld();
  const { index } = openWorld(w);
  const registry = new ToolRegistry();
  registry.register(requestContextTool({ index, maxDepth: () => 3 }));
  // A probe that reports which notes the model may propose edits to, and which URLs fetch_page knows.
  registry.register({
    name: 'probe',
    description: 'probe',
    schema: z.object({ url: z.string() }),
    approval: 'never',
    touchesVault: false,
    run: (args, ctx) => Promise.resolve({ content: `editable=${[...ctx.editable].sort().join(',')} known=${ctx.knownUrls.has(args.url)}`, summary: 'probe' }),
  });
  const tools = toolRuns(registry, {
    webNames: () => [],
    reviewNames: () => ['probe'],
    displayMode: () => 'inline',
    limits: () => ({ searches: 5, fetches: 5 }),
    attachmentMode: () => 'ask',
  });
  let n = 0;
  const provider = new Scripted(vision, script);
  const saved: Chat[] = [];
  const chat: Chat = {
    id: 'chat',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    model: { provider: 'fake', model: 'm' },
    messages: [],
    context: addNote(EMPTY_CONTEXT, index, 'a.md', () => 'c0').state,
  };
  const session = new ChatSession(chat, {
    providers: { get: () => provider },
    clock: { now: () => ++n },
    newId: () => `id${++n}`,
    save: (c) => {
      saved.push(structuredClone(c));
      return Promise.resolve();
    },
    prepare: (state, accepts) => prepareContext(state, index, { accepts }),
    share: (state, shared) => addShared(state, index, shared, () => `s${++n}`),
    storeFullTranscripts: () => storeFull,
    tools,
  });
  return { session, provider, saved, index };
}

const ask = (args: unknown): ChatEvent[] => [
  { type: 'tool_call', call: { id: 'rc', name: 'request_context', arguments: args } },
  { type: 'done', reason: 'stop' },
];

describe('shared items through the session (INVARIANTS.md A4)', () => {
  it('A4: sent in full for the rest of the reply, chips and manifest afterwards, paths only in history', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(['b.md', 'c.md', 'img.png', 'notes.txt']), fc.boolean(), fc.boolean(), async (ticked, vision, storeFull) => {
        const { session, provider, saved } = setup(vision, storeFull, [
          () => ask({ notes: ['b.md', 'c'], attachments: ['img.png', 'notes.txt'] }),
          () => [
            { type: 'tool_call', call: { id: 'p1', name: 'probe', arguments: { url: 'https://b.example/page' } } },
            { type: 'done', reason: 'stop' },
          ],
          () => [
            { type: 'text', text: 'answer' },
            { type: 'done', reason: 'stop' },
          ],
        ]);
        session.send('look');
        await until(() => waiting(session), 'the card');
        const card = session.chat.messages.at(-1)!;
        expect(card.role === 'assistant' && card.approval?.items?.map((i) => i.id)).toEqual(['b.md', 'c.md', 'img.png', 'notes.txt']);
        // Answer with the ticked ids, and one that was never offered.
        session.answerApproval(card.role === 'assistant' ? card.approval!.id : '', ticked.length > 0, [...ticked, 'a.md', 'evil.md']);
        await until(() => idle(session), 'the reply');
        expect(session.chat.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'complete', content: 'answer' });

        const shared = ticked.filter((p) => p !== 'img.png' || vision);
        const second = provider.requests[1]!.messages;
        // The round after the card: shared text once, in the tool result; images in one user message right after it.
        for (const [p, token] of [['b.md', 'BSENT'], ['c.md', 'CSENT'], ['notes.txt', 'TXTSENT']] as const) {
          expect(text(second).split(token).length - 1, p).toBe(shared.includes(p) ? 1 : 0);
        }
        const toolAt = second.findIndex((m) => m.role === 'tool');
        expect(imageText(second).includes('IMGSENT')).toBe(shared.includes('img.png'));
        if (shared.includes('img.png')) {
          expect(second[toolAt + 1]).toMatchObject({ role: 'user' });
          expect((second[toolAt + 1] as { images?: unknown[] }).images).toHaveLength(1);
        } else expect(second.length).toBe(toolAt + 1);
        // The shared notes may be proposed edits to in the same reply; their URLs are known.
        const probe = provider.requests[2]!.messages.find((m) => m.role === 'tool' && m.toolName === 'probe')!;
        expect(probe.content).toBe(`editable=${['a.md', ...shared.filter((p) => p.endsWith('.md'))].sort().join(',')} known=${shared.includes('b.md')}`);

        // Chips: exactly the shared items. The manifest includes them.
        const chat = session.chat;
        expect(new Set(chat.context.chips.map((c) => c.path))).toEqual(new Set(['a.md', ...shared]));
        const reply = chat.messages.at(-1)!;
        if (reply.role !== 'assistant') throw new Error('no reply');
        expect(new Set([...reply.context!.notes.map((x) => x.path), ...(reply.context!.attachments ?? []).map((x) => x.path)])).toEqual(new Set(['a.md', ...shared]));
        // History: no shared text, unless full transcripts are on, and then it is recoverable exactly.
        const file = JSON.stringify(saved.at(-1));
        // (Images are bytes, not text, so even a full transcript holds only their path.)
        const tokens = { 'b.md': 'BSENT', 'c.md': 'CSENT', 'notes.txt': 'TXTSENT', 'img.png': 'IMGSENT' } as const;
        for (const [p, token] of Object.entries(tokens)) expect(file.includes(token), token).toBe(storeFull && shared.includes(p) && p !== 'img.png');
        // The tool result itself never holds it, whatever the setting.
        expect(JSON.stringify(reply.steps)).not.toMatch(/BSENT|CSENT|TXTSENT|IMGSENT/);
        const step = reply.steps![0]!.calls[0]!.result!;
        if (storeFull && shared.length > 0) {
          expect(step.contextHash).toBeDefined();
          const kept = chat.sentContext![step.contextHash!]!;
          expect(kept).toBe(provider.requests[1]!.messages[toolAt]!.content);
        } else expect(step.contextHash).toBeUndefined();

        // The next message: the shared items arrive through the context message, and the old tool result is paths only.
        session.send('again');
        await until(() => idle(session), 'the next reply');
        const next = provider.requests.at(-1)!.messages;
        const context = next[0]!.role === 'system' ? next[0]!.content : '';
        for (const [p, token] of [['b.md', 'BSENT'], ['c.md', 'CSENT'], ['notes.txt', 'TXTSENT']] as const) {
          expect(context.includes(token), p).toBe(shared.includes(p));
          expect(text(next.slice(1)).includes(token), `${p} outside the context`).toBe(false);
        }
        expect(imageText(next.slice(0, 2)).includes('IMGSENT')).toBe(shared.includes('img.png'));
      }),
      { numRuns: 40 },
    );
  });

  it('A4: Stop on the card shares nothing and ends the reply', async () => {
    const { session, provider } = setup(true, false, [() => ask({ notes: ['b.md'] })]);
    session.send('look');
    await until(() => waiting(session), 'the card');
    session.stop();
    await until(() => idle(session), 'the stop');
    expect(provider.requests).toHaveLength(1);
    expect(session.chat.context.chips.map((c) => c.path)).toEqual(['a.md']);
    expect(session.chat.messages.at(-1)).toMatchObject({ status: 'stopped' });
  });

  it('A4: every round, images included, is checked against the window', async () => {
    const { session, provider } = setup(true, false, [() => ask({ attachments: ['img.png'] })]);
    session.send('look');
    await until(() => waiting(session), 'the card');
    const m = session.chat.messages.at(-1)!;
    const before = m.role === 'assistant' ? m.promptEstimate! : 0;
    session.answerApproval(m.role === 'assistant' ? m.approval!.id : '', true, ['img.png']);
    await until(() => idle(session), 'the reply');
    const reply = session.chat.messages.at(-1)!;
    // The image's estimate (256 tokens at least) is part of the next round's estimate.
    expect(reply.role === 'assistant' && reply.promptEstimate! - before).toBeGreaterThanOrEqual(256);
    expect(provider.requests).toHaveLength(2);
  });

  it('A4: the session passes on only ticked ids that were offered and can be sent (mutant M22)', async () => {
    let got: readonly string[] | null = null;
    const provider = new Scripted(false, [() => ask({})]);
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
            definitions: [{ name: 'request_context', description: '', parameters: {} }],
            async execute(_call, _signal, _approve, extra) {
              got = await extra!.choose!({
                tool: 't',
                title: 't',
                detail: 'd',
                items: [
                  { id: 'x', kind: 'note', label: 'x', tokens: 1 },
                  { id: 'u', kind: 'attachment', label: 'u', tokens: 0, unavailable: 'no' },
                ],
              });
              return { ok: true, content: 'r', summary: 's' };
            },
          }),
        },
      },
    );
    session.send('go');
    await until(() => waiting(session), 'the card');
    const m = session.chat.messages.at(-1)!;
    session.answerApproval(m.role === 'assistant' ? m.approval!.id : '', true, ['x', 'u', 'never-offered']);
    await until(() => got !== null, 'the answer');
    expect(got).toEqual(['x']);
  });
});
