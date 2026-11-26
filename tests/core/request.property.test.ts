// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md A3: request_context shares only what the user approved. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ContextIndex } from '../../src/core/context/ContextIndex';
import { planContext } from '../../src/core/context/plan';
import { REQUEST_CAP } from '../../src/core/context/request';
import { type ContextState, EMPTY_CONTEXT, addAttachment, addNote, addShared, setAttachmentMode, withhold } from '../../src/core/context/state';
import type { AttachmentMode } from '../../src/core/settings';
import { ToolBudget } from '../../src/core/tools/budget';
import { NOTHING_SHARED, requestContextTool } from '../../src/core/tools/context';
import { ToolRegistry } from '../../src/core/tools/registry';
import type { ApprovalItem, StepResult, ToolContext } from '../../src/core/tools/types';
import { KnownUrls } from '../../src/core/tools/urls';
import { type World, exclusionsOf, latin1, openWorld, sendable, world } from './attachments.fixtures';
import type { FakeRawVault } from './vault.fixtures';

const MODES: AttachmentMode[] = ['ask', 'allowed', 'upfront'];

type Answer = { kind: 'deny' } | { kind: 'all' } | { kind: 'subset'; picks: boolean[] } | { kind: 'bogus' } | { kind: 'stop' };

interface Real {
  w: World;
  raw: FakeRawVault;
  index: ContextIndex;
  state: ContextState;
  fallback: AttachmentMode;
  vision: boolean;
  registry: ToolRegistry;
  n: number;
}

const answer: fc.Arbitrary<Answer> = fc.oneof(
  fc.constant<Answer>({ kind: 'deny' }),
  fc.constant<Answer>({ kind: 'all' }),
  fc.array(fc.boolean(), { minLength: 25, maxLength: 25 }).map((picks): Answer => ({ kind: 'subset', picks })),
  fc.constant<Answer>({ kind: 'bogus' }),
  fc.constant<Answer>({ kind: 'stop' }),
);

/** A random request built from names in the world: existing, missing, excluded, by title or path. */
const request = fc.record(
  {
    notes: fc.array(fc.oneof(fc.nat().map((i) => ({ note: i })), fc.constantFrom('missing.md', 'n0', 'N1', 'Private/n2.md', 'nope', '[[n3]]')), { maxLength: 6 }),
    linked_from: fc.record({ note: fc.nat(), depth: fc.integer({ min: 1, max: 3 }) }),
    folder: fc.record({ path: fc.constantFrom('Notes', 'Private', 'Work', 'attachments', 'missing', 'Notes/'), recursive: fc.boolean() }),
    search: fc.constantFrom('n', 'n1', 'N', 'zzz', '  '),
    attachments: fc.array(fc.oneof(fc.nat().map((j) => ({ file: j })), fc.constantFrom('f0.png', 'F1.TXT', 'missing.png', 'Private/f2.png', '![[f3.jpg]]')), { maxLength: 6 }),
    reason: fc.string({ maxLength: 20 }),
    junk: fc.oneof({ weight: 9, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: fc.anything() }),
  },
  { requiredKeys: [] },
);
type Req = typeof request extends fc.Arbitrary<infer T> ? T : never;

/** Turn generated name references into strings, and maybe garbage. */
function argsFor(r: Real, q: Req): unknown {
  const notes = r.w.spec.notes.map((n) => n.path);
  const files = r.w.spec.attachments;
  const out: Record<string, unknown> = {};
  if (q.notes) out.notes = q.notes.map((x) => (typeof x === 'string' ? x : notes[x.note % notes.length]!));
  if (q.linked_from) out.linked_from = { note: notes[q.linked_from.note % notes.length]!, depth: q.linked_from.depth };
  if (q.folder) out.folder = q.folder;
  if (q.search !== undefined) out.search = q.search;
  if (q.attachments) out.attachments = q.attachments.map((x) => (typeof x === 'string' ? x : files[x.file % files.length]!));
  if (q.reason !== undefined) out.reason = q.reason;
  if (q.junk !== undefined) out.junk = q.junk; // strict schema: always an argument error
  return out;
}

interface Call {
  result: StepResult;
  offered: ApprovalItem[] | null;
  readsBeforeCard: string[];
  readsAll: string[];
  ticked: string[];
}

async function call(r: Real, args: unknown, a: Answer): Promise<Call> {
  r.raw.reads.length = 0;
  const controller = new AbortController();
  let offered: ApprovalItem[] | null = null;
  let readsBeforeCard: string[] = [];
  let ticked: string[] = [];
  const ctx: ToolContext = {
    signal: controller.signal,
    knownUrls: new KnownUrls(),
    approve: () => Promise.resolve(false),
    editable: new Set(),
    model: null,
    context: { state: r.state, fallbackMode: r.fallback, accepts: { images: r.vision } },
    choose: (req) => {
      expect(offered, 'one card per call').toBeNull();
      offered = [...req.items];
      readsBeforeCard = [...r.raw.reads];
      const avail = req.items.filter((i) => i.unavailable === undefined).map((i) => i.id);
      switch (a.kind) {
        case 'deny':
          ticked = [];
          break;
        case 'all':
          ticked = avail;
          break;
        case 'subset':
          ticked = avail.filter((_, k) => a.picks[k % a.picks.length]);
          break;
        case 'bogus':
          // Ids never offered: excluded paths, unavailable items, made-up ones. The session drops them; the tool must too.
          ticked = [...r.w.spec.attachments, ...r.w.spec.notes.map((n) => n.path), 'made/up.md'].filter((p) => !avail.includes(p));
          break;
        case 'stop':
          controller.abort();
          ticked = [];
      }
      return Promise.resolve(ticked);
    },
  };
  const result = await r.registry.execute({ id: `call-${++r.n}`, name: 'request_context', arguments: args }, new Set(['request_context']), new ToolBudget({ searches: 5, fetches: 5 }), ctx);
  return { result, offered, readsBeforeCard, readsAll: [...r.raw.reads], ticked };
}

function checkCall(r: Real, before: ContextState, c: Call): void {
  const ex = exclusionsOf(r.raw.spec);
  const plan = planContext(before, r.index, r.fallback);
  const inContext = new Set([...plan.notes.map((n) => n.path), ...plan.attachments.map((x) => x.path)]);
  const mode = before.attachmentMode ?? r.fallback;
  const withheld = new Set(before.withheld ?? []);
  const linkedUnsent = new Set(plan.attachmentLists.flatMap((l) => l.paths));
  const auto = (p: string) => mode === 'allowed' && linkedUnsent.has(p) && !withheld.has(p);

  // The card: at most REQUEST_CAP items, none excluded, none already in context.
  if (c.offered) {
    expect(c.offered.length).toBeLessThanOrEqual(REQUEST_CAP);
    for (const i of c.offered) {
      expect(ex.isExcluded(i.id), `excluded ${i.id} on the card`).toBe(false);
      expect(inContext.has(i.id), `${i.id} already in context`).toBe(false);
    }
    // Nothing read before the user answered, except Allowed-mode grants (which are read after, with the rest).
    expect(c.readsBeforeCard).toEqual([]);
  }
  // Nothing excluded is ever read.
  for (const p of c.readsAll) expect(ex.isExcluded(p), `read excluded ${p}`).toBe(false);

  const sentText = (c.result.transient?.content ?? '') + (c.result.transient?.images ?? []).map((i) => latin1(i.data)).join('\n');
  const onCard = new Set((c.offered ?? []).map((i) => i.id));
  const viaCard = (p: string) => (c.offered ?? []).some((i) => i.id === p && i.unavailable === undefined) && c.ticked.includes(p);
  const seen = new Set<string>();
  // A note reaches the model if and only if the user ticked it on the card.
  for (const [p, token] of r.w.noteSentinels) {
    if (inContext.has(p)) continue; // already sent with the context; never listed here
    if (sentText.includes(token)) seen.add(p);
    expect(seen.has(p), `note ${p}`).toBe(c.result.ok && viaCard(p));
  }
  // A file reaches the model only if the user ticked it, or Allowed mode granted it without a card; a ticked file that can be sent always does.
  for (const [p, token] of r.w.sentinels) {
    if (inContext.has(p)) continue;
    const kind = r.w.kinds.get(p)!;
    if (sentText.includes(token)) seen.add(p);
    if (seen.has(p)) expect(viaCard(p) || (auto(p) && !onCard.has(p)), `file ${p} (${kind}) without approval`).toBe(true);
    if (c.result.ok && viaCard(p) && sendable(kind, r.vision)) expect(seen.has(p), `ticked ${p} (${kind}) not sent`).toBe(true);
  }
  if (!c.result.ok) expect(seen.size).toBe(0);
  // Shared items (the chips to be) are exactly what was sent.
  if (c.result.shared) expect(new Set([...c.result.shared.notes, ...c.result.shared.attachments])).toEqual(seen);
  else expect(seen.size).toBe(0);
  // What chat history keeps never holds a sentinel.
  for (const token of [...r.w.noteSentinels.values(), ...r.w.sentinels.values()]) {
    expect(c.result.content.includes(token)).toBe(false);
    expect(c.result.summary.includes(token)).toBe(false);
  }
  // Denying, ticking nothing, "nothing matched", Stop: the same answer, which names nothing not already in context.
  if (!c.result.transient && c.result.ok) {
    const m = /^(.*?)( Already in the context: (.*)\.)?$/s.exec(c.result.content)!;
    expect(m[1]).toBe(NOTHING_SHARED);
    if (m[3]) for (const p of m[3].split(', ')) expect(inContext.has(JSON.parse(p) as string)).toBe(true);
    expect(c.result.shared).toBeUndefined();
  }
}

type Cmd = fc.AsyncCommand<Real, Real>;

const requestCmd = fc.tuple(request, answer).map(
  ([q, a]): Cmd => ({
    check: () => true,
    run: async (_m, r) => {
      const before = r.state;
      const c = await call(r, argsFor(r, q), a);
      checkCall(r, before, c);
      // As the session does: shared items become chips.
      if (c.result.shared) {
        const after = addShared(before, r.index, c.result.shared, () => `c${++r.n}`);
        const added = after.chips.filter((x) => !before.chips.some((y) => y.id === x.id)).map((x) => x.path);
        expect(new Set(added)).toEqual(new Set([...c.result.shared.notes, ...c.result.shared.attachments]));
        r.state = after;
      }
    },
    toString: () => `request(${JSON.stringify(q)}, ${a.kind})`,
  }),
);

/** Ask for the attachments a note in context links to: the Allowed-mode case. */
const linkedCmd = fc.tuple(fc.nat(), answer).map(
  ([k, a]): Cmd => ({
    check: () => true,
    run: async (_m, r) => {
      const plan = planContext(r.state, r.index, r.fallback);
      const notes = plan.notes.map((n) => n.path);
      if (notes.length === 0) return;
      const note = r.w.spec.notes.find((n) => n.path === notes[k % notes.length])!;
      const files = note.links.filter((l) => r.w.kinds.has(l));
      if (files.length === 0) return;
      const before = r.state;
      const c = await call(r, { attachments: files }, a);
      checkCall(r, before, c);
      if (c.result.shared) r.state = addShared(before, r.index, c.result.shared, () => `c${++r.n}`);
    },
    toString: () => `requestLinked(${k}, ${a.kind})`,
  }),
);

const commands = fc.commands(
  [
    requestCmd,
    requestCmd,
    linkedCmd,
    fc.tuple(request, answer).map(
      ([q, a]): Cmd => ({
        check: () => true,
        run: async (_m, r) => {
          const before = r.state;
          const c = await call(r, argsFor(r, q), a);
          checkCall(r, before, c);
          // As the session does: shared items become chips.
          if (c.result.shared) {
            const after = addShared(before, r.index, c.result.shared, () => `c${++r.n}`);
            const added = after.chips.filter((x) => !before.chips.some((y) => y.id === x.id)).map((x) => x.path);
            expect(new Set(added)).toEqual(new Set([...c.result.shared.notes, ...c.result.shared.attachments]));
            r.state = after;
          }
        },
        toString: () => `request(${JSON.stringify(q)}, ${a.kind})`,
      }),
    ),
    fc.nat().map(
      (i): Cmd => ({
        check: () => true,
        run: (_m, r) => {
          r.state = addNote(r.state, r.index, r.w.spec.notes[i % r.w.spec.notes.length]!.path, () => `c${++r.n}`).state;
          return Promise.resolve();
        },
        toString: () => `addNote(${i})`,
      }),
    ),
    fc.nat().map(
      (j): Cmd => ({
        check: () => true,
        run: (_m, r) => {
          const p = r.w.spec.attachments[j % r.w.spec.attachments.length]!;
          r.state = j % 2 === 0 ? addAttachment(r.state, r.index, p, () => `c${++r.n}`).state : withhold(r.state, p);
          return Promise.resolve();
        },
        toString: () => `attachment(${j})`,
      }),
    ),
    fc.option(fc.constantFrom(...MODES), { nil: undefined }).map(
      (m): Cmd => ({
        check: () => true,
        run: (_m, r) => {
          r.state = setAttachmentMode(r.state, m);
          return Promise.resolve();
        },
        toString: () => `mode(${m})`,
      }),
    ),
  ],
  { maxCommands: 40, size: 'large' },
);

function setup(w: World, fallback: AttachmentMode, vision: boolean): Real {
  const { raw, index } = openWorld(w);
  const registry = new ToolRegistry();
  registry.register(requestContextTool({ index, maxDepth: () => 3 }));
  return { w, raw, index, state: EMPTY_CONTEXT, fallback, vision, registry, n: 0 };
}

describe('request_context (INVARIANTS.md A3)', () => {
  it('A3: only what the user ticked (or Allowed mode grants) reaches the model; history keeps paths only', async () => {
    await fc.assert(
      fc.asyncProperty(world, fc.constantFrom(...MODES), fc.boolean(), commands, async (w, fallback, vision, cmds) => {
        const real = setup(w, fallback, vision);
        await fc.asyncModelRun(() => ({ model: real, real }), cmds);
      }),
    );
  });

  it('A3: a request matching more than 20 files shows no card, reads nothing and asks the model to narrow it', async () => {
    const notes = Array.from({ length: 25 }, (_, i) => ({ path: `Big/n${i}.md`, content: `BIG${i}X`, links: [] }));
    const w: World = {
      spec: { notes, attachments: [], bytes: {}, patterns: [], obsidianFilters: [], respectObsidian: false },
      kinds: new Map(),
      sentinels: new Map(),
      noteSentinels: new Map(notes.map((n, i) => [n.path, `BIG${i}X`])),
    };
    const r = setup(w, 'ask', false);
    const c = await call(r, { folder: { path: 'Big' } }, { kind: 'all' });
    expect(c.offered).toBeNull();
    expect(c.readsAll).toEqual([]);
    expect(c.result.ok).toBe(false);
    expect(c.result.content).toMatch(/more than 20 files/);
    // Exactly 20 is fine.
    r.raw.spec.notes = notes.slice(0, 20);
    r.index.refresh();
    const ok = await call(r, { folder: { path: 'Big' } }, { kind: 'all' });
    expect(ok.offered).toHaveLength(20);
    expect(ok.result.shared?.notes).toHaveLength(20);
  });

  it('A3: denying and "nothing matched" are the same answer', async () => {
    const w: World = {
      spec: { notes: [{ path: 'a.md', content: 'ASENT', links: [] }], attachments: [], bytes: {}, patterns: ['Private'], obsidianFilters: [], respectObsidian: false },
      kinds: new Map(),
      sentinels: new Map(),
      noteSentinels: new Map([['a.md', 'ASENT']]),
    };
    const r = setup(w, 'ask', false);
    const denied = await call(r, { notes: ['a.md'] }, { kind: 'deny' });
    const missing = await call(r, { notes: ['nothing-like-it.md'] }, { kind: 'all' });
    expect(denied.offered).toHaveLength(1);
    expect(missing.offered).toBeNull();
    expect(denied.result.content).toBe(missing.result.content);
    expect(denied.result.content).toBe(NOTHING_SHARED);
    // The user still sees the difference.
    expect(denied.result.summary).not.toBe(missing.result.summary);
  });

  it('A3: in Allowed mode, a linked attachment is granted without a card, unless the user withheld it', async () => {
    const w: World = {
      spec: {
        notes: [{ path: 'n.md', content: 'N', links: ['a.txt', 'b.txt'] }],
        attachments: ['a.txt', 'b.txt', 'c.txt'],
        bytes: { 'a.txt': new TextEncoder().encode('ASENT'), 'b.txt': new TextEncoder().encode('BSENT'), 'c.txt': new TextEncoder().encode('CSENT') },
        patterns: [],
        obsidianFilters: [],
        respectObsidian: false,
      },
      kinds: new Map([
        ['a.txt', 'text'],
        ['b.txt', 'text'],
        ['c.txt', 'text'],
      ]),
      sentinels: new Map(),
      noteSentinels: new Map(),
    };
    const r = setup(w, 'allowed', false);
    r.state = withhold(addNote(EMPTY_CONTEXT, r.index, 'n.md', () => 'c1').state, 'b.txt');
    const c = await call(r, { attachments: ['a.txt', 'b.txt', 'c.txt'] }, { kind: 'deny' });
    // a.txt: linked, granted. b.txt: linked but withheld, so asked. c.txt: not linked, so asked.
    expect(c.offered?.map((i) => i.id)).toEqual(['b.txt', 'c.txt']);
    expect(c.result.transient?.content).toContain('ASENT');
    expect(c.result.transient?.content).not.toContain('BSENT');
    expect(c.result.transient?.content).not.toContain('CSENT');
    expect(c.result.shared?.attachments).toEqual(['a.txt']);
    // In Ask mode the same request asks for all three.
    r.state = setAttachmentMode(r.state, 'ask');
    const asked = await call(r, { attachments: ['a.txt', 'b.txt', 'c.txt'] }, { kind: 'deny' });
    expect(asked.offered?.map((i) => i.id)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(asked.result.transient).toBeUndefined();
  });

  it('A3: an image for a model without vision is listed but cannot be ticked', async () => {
    const w: World = {
      spec: { notes: [], attachments: ['p.png'], bytes: { 'p.png': new Uint8Array([0x89, 0x50]) }, patterns: [], obsidianFilters: [], respectObsidian: false },
      kinds: new Map([['p.png', 'png']]),
      sentinels: new Map(),
      noteSentinels: new Map(),
    };
    const r = setup(w, 'ask', false);
    const c = await call(r, { attachments: ['p.png'] }, { kind: 'bogus' });
    expect(c.offered).toEqual([{ id: 'p.png', kind: 'attachment', label: 'p.png', tokens: 0, unavailable: 'this model can’t see images' }]);
    expect(c.result.content).toBe(NOTHING_SHARED);
    expect(c.readsAll).toEqual([]);
  });
});
