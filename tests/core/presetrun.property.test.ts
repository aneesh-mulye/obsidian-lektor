// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md PR2: a preset run sends exactly its preset, through a real session and tool run. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatSession } from '../../src/core/chat/session';
import type { Chat } from '../../src/core/chat/types';
import type { PreparedContext } from '../../src/core/context/prepare';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import { PRESET_OUTPUTS, PRESET_TOOLS, type Preset } from '../../src/core/presets/preset';
import type { Capabilities, ChatEvent, ChatMessage, ChatProvider, ChatRequest } from '../../src/core/providers/types';
import { DISPLAY_MODES, type DisplayMode } from '../../src/core/settings';
import { ToolRegistry } from '../../src/core/tools/registry';
import { PROSE, toolRuns } from '../../src/core/tools/run';
import type { Tool } from '../../src/core/tools/types';

interface Sent {
  model: string;
  messages: ChatMessage[];
  tools: string[];
}

class FakeProvider implements ChatProvider {
  readonly id = 'fake';
  readonly label = 'Fake';
  native = true;
  readonly requests: Sent[] = [];
  capabilities(): Promise<Capabilities> {
    return Promise.resolve({ toolCalling: this.native ? 'native' : 'none', nativeWebSearch: false, images: false, contextWindow: 1_000_000 });
  }
  listModels() {
    return Promise.resolve([]);
  }
  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    this.requests.push({ model: req.model, messages: structuredClone(req.messages), tools: (req.tools ?? []).map((t) => t.name).sort() });
    await Promise.resolve();
    yield { type: 'text', text: 'ok' };
    yield { type: 'done', reason: 'stop' };
  }
}

const NAMES = ['web_search', 'fetch_page', 'request_context', 'propose_edit', 'propose_note', 'report_findings'];
const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  schema: z.object({}),
  approval: 'never',
  touchesVault: false,
  run: () => Promise.resolve({ content: name, summary: name }),
});

interface World {
  provider: FakeProvider;
  session: ChatSession;
  searchConfigured: boolean;
  /** Whether a note is in the context (so edits and findings have something to point at). */
  note: boolean;
  defaultMode: DisplayMode;
}

const prepared = (note: boolean): PreparedContext => ({
  message: note ? 'CONTEXT a.md' : null,
  images: [],
  tokens: 10,
  manifest: { notes: note ? [{ path: 'a.md', hash: 'h' }] : [], selections: [], attachments: [], backlinkLists: 0, excluded: 0 },
  skipped: [],
  urls: [],
});

function world(native: boolean, defaultMode: DisplayMode): World {
  const provider = new FakeProvider();
  provider.native = native;
  const registry = new ToolRegistry();
  for (const n of NAMES) registry.register(fakeTool(n));
  const w = { provider, searchConfigured: false, note: true, defaultMode } as World;
  const tools = toolRuns(registry, {
    webNames: () => [...(w.searchConfigured ? ['web_search'] : []), 'fetch_page'],
    reviewNames: () => ['propose_edit', 'propose_note'],
    displayMode: () => w.defaultMode,
    limits: () => ({ searches: 5, fetches: 5 }),
    attachmentMode: () => 'ask',
    fenced: () => ({ instructions: 'FENCED lektor-edit', extract: () => Promise.resolve({ proposals: [], problems: [] }) }),
    fencedFindings: () => ({ instructions: 'FENCED lektor-findings', extract: () => Promise.resolve({ proposals: [], findings: [], problems: [] }) }),
  });
  const chat: Chat = { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'fake', model: 'm-chat' }, messages: [], context: EMPTY_CONTEXT };
  let n = 0;
  w.session = new ChatSession(chat, {
    providers: { get: (id) => (id === 'fake' ? provider : undefined) },
    clock: { now: () => 0 },
    newId: () => `id${++n}`,
    save: () => Promise.resolve(),
    prepare: () => Promise.resolve(prepared(w.note)),
    tools,
  });
  return w;
}

const settle = async (w: World) => {
  for (let i = 0; i < 50 && w.session.busy; i++) await new Promise<void>((r) => setImmediate(r));
  expect(w.session.busy).toBe(false);
};

let marker = 0;
const presetArb: fc.Arbitrary<Preset> = fc
  .record(
    {
      output: fc.constantFrom(...PRESET_OUTPUTS),
      tools: fc.subarray([...PRESET_TOOLS]),
      ownModel: fc.boolean(),
      display: fc.option(fc.constantFrom(...DISPLAY_MODES), { nil: undefined }),
      searches: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
    },
    { requiredKeys: ['output', 'tools', 'ownModel'] },
  )
  .map((r) => {
    const m = ++marker;
    return {
      id: `p${m}`,
      name: `Preset ${m}`,
      icon: 'sparkles',
      tools: r.tools,
      output: r.output,
      prompt: `Do the thing. PRESET-${m}-PROMPT`,
      ...(r.ownModel ? { model: { provider: 'fake', model: `m-preset-${m}` } } : {}),
      ...(r.display ? { display: r.display } : {}),
      ...(r.searches !== undefined ? { searches: r.searches } : {}),
    } satisfies Preset;
  });

/** What the reply to the chat's last user message should be offered, written independently of toolRuns. */
function expectedTools(w: World, preset: Preset | undefined): string[] {
  const chat = w.session.chat;
  if (!w.provider.native) return [];
  const prose = (chat.displayMode ?? w.defaultMode) === 'prose';
  const web = chat.toolsDisabled ? [] : [...(w.searchConfigured ? ['web_search'] : []), 'fetch_page'].filter((n) => !preset || (preset.tools as string[]).includes(n));
  const review =
    preset?.output === 'findings' ? (w.note ? ['report_findings'] : []) : preset?.output === 'chat' || prose ? [] : [...(w.note ? ['propose_edit'] : []), 'propose_note'];
  return [...web, 'request_context', ...review].sort();
}

/** Checks the request(s) of the reply just finished. */
function check(w: World, from: number, preset: Preset | undefined): void {
  const sent = w.provider.requests.slice(from);
  expect(sent.length).toBe(1);
  const req = sent[0]!;
  const systems = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const prompts = req.messages.filter((m) => /PRESET-\d+-PROMPT/.test(m.content));
  if (preset) {
    // Exactly one system message carries this preset's prompt; no other preset's prompt is anywhere.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.role).toBe('system');
    expect(prompts[0]!.content).toContain(preset.prompt);
    expect(req.model).toBe(preset.model?.model ?? 'm-chat');
  } else {
    expect(prompts).toHaveLength(0);
    expect(req.model).toBe('m-chat');
  }
  expect(w.session.chat.model).toEqual({ provider: 'fake', model: 'm-chat' }); // the chat's own model never changes
  expect(req.tools).toEqual(expectedTools(w, preset));
  // Without native tool calling: fenced findings for findings presets with a note to point at.
  const fencedFindings = !w.provider.native && preset?.output === 'findings' && w.note;
  expect(systems.some((s) => s.includes('lektor-findings'))).toBe(fencedFindings);
  if (preset?.output === 'findings' || preset?.output === 'chat') {
    expect(systems.some((s) => s.includes('lektor-edit'))).toBe(false);
    expect(systems.includes(PROSE)).toBe(false);
  }
  if (preset?.output === 'findings' && w.provider.native && w.note) expect(prompts[0]!.content).toContain('report_findings');
}

type Cmd = fc.AsyncCommand<World, World>;
const cmd = (name: string, run: (w: World) => Promise<void>): Cmd => ({ check: () => true, run: (_m, w) => run(w), toString: () => name });

const commands = fc.commands(
  [
    fc.constant(
      cmd('send', async (w) => {
        const from = w.provider.requests.length;
        expect(w.session.send('hello')).toBe(true);
        await settle(w);
        check(w, from, undefined);
      }),
    ),
    presetArb.chain((p) =>
      fc.constantFrom('', 'focus on the intro').map((typed) =>
        cmd(`run(${p.id}: ${p.output}, tools=${p.tools.join('+')}${p.model ? ', own model' : ''}${p.display ? `, ${p.display}` : ''}, "${typed}")`, async (w) => {
          const from = w.provider.requests.length;
          expect(w.session.send(typed, p)).toBe(true);
          if (p.display) expect(w.session.chat.displayMode).toBe(p.display);
          await settle(w);
          check(w, from, p);
          // The model sees the run as a user turn that names the preset, with what was typed.
          const turn = w.provider.requests.at(-1)!.messages.filter((m) => m.role === 'user').at(-1)!;
          expect(turn.content).toContain(p.name);
          if (typed) expect(turn.content).toContain(typed);
        }),
      ),
    ),
    fc.constant(
      cmd('regenerate', async (w) => {
        const last = w.session.chat.messages.at(-2);
        if (!w.session.regenerate()) return;
        const from = w.provider.requests.length;
        await settle(w);
        // The same snapshot again.
        check(w, from, last?.role === 'user' ? last.preset : undefined);
      }),
    ),
    fc.constant(cmd('globe', (w) => Promise.resolve(w.session.setTools(w.session.chat.toolsDisabled === true)))),
    fc.constantFrom(...DISPLAY_MODES).map((m) => cmd(`mode(${m})`, (w) => Promise.resolve(w.session.setDisplayMode(m)))),
    fc.constant(cmd('search provider on/off', (w) => Promise.resolve(void (w.searchConfigured = !w.searchConfigured)))),
    fc.constant(cmd('note in context on/off', (w) => Promise.resolve(void (w.note = !w.note)))),
    fc.constant(cmd('model with/without tool calling', (w) => Promise.resolve(void (w.provider.native = !w.provider.native)))),
  ],
  { maxCommands: 30 },
);

describe('preset runs (INVARIANTS.md PR2)', () => {
  it('PR2: a preset reply carries its prompt once and gets exactly its tools; other messages carry none of it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.constantFrom(...DISPLAY_MODES), commands, async (native, mode, cmds) => {
        const w = world(native, mode);
        await fc.asyncModelRun(() => ({ model: w, real: w }), cmds);
      }),
    );
  });

  it('PR2: a preset’s caps replace the global caps for its reply only', async () => {
    const registry = new ToolRegistry();
    registry.register({ ...fakeTool('web_search'), cap: 'searches' });
    const runs = toolRuns(registry, {
      webNames: () => ['web_search'],
      reviewNames: () => [],
      displayMode: () => 'sidebar',
      limits: () => ({ searches: 2, fetches: 2 }),
    });
    const chat: Chat = { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: null, messages: [], context: EMPTY_CONTEXT };
    const caps: Capabilities = { toolCalling: 'native', nativeWebSearch: false, images: false, contextWindow: 1000 };
    const searchesAllowed = async (preset?: Preset) => {
      const run = runs.forReply({ chat, capabilities: caps, contextUrls: [], editable: [], ...(preset ? { preset } : {}) })!;
      let n = 0;
      for (let i = 0; i < 10; i++) if ((await run.execute({ id: `${i}`, name: 'web_search', arguments: {} }, new AbortController().signal, () => Promise.resolve(false))).ok) n++;
      return n;
    };
    const p: Preset = { id: 'p', name: 'P', icon: 'x', tools: ['web_search'], output: 'chat', prompt: 'x', searches: 4 };
    expect(await searchesAllowed(p)).toBe(4);
    expect(await searchesAllowed({ ...p, searches: 0 })).toBe(0);
    expect(await searchesAllowed()).toBe(2);
    const { searches: _s, ...uncapped } = p;
    expect(await searchesAllowed(uncapped)).toBe(2);
  });
});
