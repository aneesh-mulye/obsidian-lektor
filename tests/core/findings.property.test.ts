// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md F1, F2: findings point at real text, and their highlights match them. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type FindingSet, type ReportFindingsArgs, fencedFindings, findingMarks, makeFindings, reportFindingsTool, suggestFixMessage } from '../../src/core/findings/findings';
import { fingerprint } from '../../src/core/review/fingerprint';
import { ToolError } from '../../src/core/tools/types';
import { KnownUrls, normaliseUrl } from '../../src/core/tools/urls';
import { MODEL, text, word } from './review.fixtures';

const count = (hay: string, needle: string) => {
  let c = 0;
  for (let i = hay.indexOf(needle); i !== -1 && needle !== ''; i = hay.indexOf(needle, i + 1)) c++;
  return c;
};

let n = 0;
const deps = (notes: Map<string, string>, reads: string[] = []) => ({
  readNote: (p: string) => {
    reads.push(p);
    return notes.has(p) ? Promise.resolve(notes.get(p)!) : Promise.reject(new Error('gone'));
  },
  newId: () => `f${++n}`,
  now: () => 0,
});

const KNOWN = ['https://known.example/a', 'https://known.example/b?q=1'];
const source = fc.oneof(fc.constantFrom(...KNOWN), fc.constantFrom('https://attacker.example/?q=secret', 'HTTPS://KNOWN.example/a', 'https://known.example/a#frag', 'javascript:alert(1)', 'not a url', ''), fc.webUrl());

/** A note, a context, and report_findings arguments with quotes that occur once, several times or not at all. */
const world = text.chain((t) =>
  fc.record({
    t: fc.constant(t),
    inContext: fc.boolean(),
    path: fc.constantFrom<string | undefined>('a.md', undefined, 'Private/p.md', 'b.md'),
    findings: fc.array(
      fc.record(
        {
          quote: fc.oneof(
            fc.tuple(fc.nat(), fc.integer({ min: 1, max: 40 })).map(([at, len]) => t.slice(at % t.length, (at % t.length) + len) || 'zz'),
            word,
            fc.constant('not in the note at all'),
          ),
          kind: fc.constantFrom('typo', 'Homophone', 'garden-path', 'claim', ' spaced '),
          explanation: fc.string({ maxLength: 40 }),
          verdict: fc.constantFrom('correct', 'wrong', 'doubtful', 'unverified'),
          sources: fc.array(source, { maxLength: 3 }),
        },
        { requiredKeys: ['quote', 'kind', 'explanation'] },
      ),
      { minLength: 1, maxLength: 6 },
    ),
  }),
);

function known(): KnownUrls {
  const k = new KnownUrls();
  for (const u of KNOWN) k.add(u);
  return k;
}

describe('findings (INVARIANTS.md F1)', () => {
  it('F1: a set exists only for a note in context; every kept quote occurs once, at its position; the rest are named', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const notes = new Map([['a.md', w.t], ['b.md', 'other note']]);
        const editable = new Set(w.inContext ? ['a.md'] : []);
        const args = { findings: w.findings, ...(w.path ? { path: w.path } : {}) } as ReportFindingsArgs;
        const reads: string[] = [];
        const tool = reportFindingsTool(deps(notes, reads));
        const ctx = { signal: new AbortController().signal, knownUrls: known(), approve: () => Promise.resolve(false), editable, model: MODEL };
        const resolved = w.path ?? (editable.size === 1 ? 'a.md' : undefined);
        const target = resolved !== undefined && editable.has(resolved);
        const unique = w.findings.filter((f) => count(w.t, f.quote) === 1);
        let out;
        try {
          out = await tool.run(tool.schema.parse(args), ctx);
        } catch (err) {
          expect(err).toBeInstanceOf(ToolError);
          // Refused: outside the context, or nothing placeable.
          expect(!target || unique.length === 0).toBe(true);
          if (target && unique.length === 0) for (let i = 1; i <= w.findings.length; i++) expect((err as Error).message).toContain(`${i}. `);
          return;
        }
        expect(target && unique.length > 0).toBe(true);
        // Only the note in context was read (never anything else).
        expect(reads.every((p) => p === 'a.md')).toBe(true);
        const set = out.findings!;
        expect(set.path).toBe('a.md');
        expect(set.expect).toBe(fingerprint(w.t));
        expect(set.findings.map((f) => f.quote)).toEqual(unique.map((f) => f.quote));
        for (const f of set.findings) {
          expect(w.t.slice(f.at, f.at + f.quote.length)).toBe(f.quote);
          expect(count(w.t, f.quote)).toBe(1);
          expect(f.status).toBe('open');
          expect(f.kind).toBe(f.kind.trim().toLowerCase());
          // A source is a link only if the chat knew its URL, exactly.
          for (const s of f.sources) expect(s.known).toBe(KNOWN.includes(s.url) && normaliseUrl(s.url) === s.url);
        }
        // The ones not kept are named, so the model can send them again.
        w.findings.forEach((f, i) => {
          if (count(w.t, f.quote) !== 1) expect(out.content).toContain(`${i + 1}. `);
        });
      }),
    );
  });

  it('F1: fenced lektor-findings blocks give the same findings as the tool', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const notes = new Map([['a.md', w.t]]);
        const editable = new Set(['a.md']);
        const args = { findings: w.findings, path: 'a.md' } as ReportFindingsArgs;
        const direct = await makeFindings(args, editable, known(), MODEL, deps(notes)).catch(() => null);
        const fenced = fencedFindings(deps(notes), editable, known(), MODEL);
        const reply = `Here you are.\n\`\`\`lektor-findings\n${JSON.stringify(args)}\n\`\`\`\nDone.`;
        const r = await fenced.extract(reply);
        const strip = (s: FindingSet | null | undefined) => s?.findings.map(({ id: _id, ...f }) => f) ?? null;
        expect(strip(r.findings?.[0])).toEqual(strip(direct?.set));
        expect(r.proposals).toEqual([]);
      }),
    );
  });

  it('F1: broken fenced blocks are reported, not thrown', async () => {
    const fenced = fencedFindings(deps(new Map([['a.md', 'the cat sat']])), new Set(['a.md']), known(), MODEL);
    const r = await fenced.extract('```lektor-findings\nnot json\n```\n```lektor-findings\n{"findings": []}\n```\n```lektor-findings\n{"path": "z.md", "findings": [{"quote": "cat", "kind": "typo", "explanation": ""}]}\n```');
    expect(r.findings).toEqual([]);
    expect(r.problems).toHaveLength(3);
  });
});

describe('finding highlights (INVARIANTS.md F2)', () => {
  const edit = fc.oneof(
    fc.constant({ kind: 'none' as const }),
    fc.record({ kind: fc.constant('type' as const), at: fc.nat(), del: fc.nat({ max: 6 }), ins: fc.oneof(word, fc.constant('')) }),
    fc.record({ kind: fc.constant('paste' as const), from: fc.nat(), len: fc.integer({ min: 1, max: 40 }), to: fc.nat() }),
  );

  it('F2: an open finding is highlighted exactly on its quote: at its position if unchanged, else only where the quote is unique', async () => {
    await fc.assert(
      fc.asyncProperty(world, fc.array(edit, { maxLength: 3 }), fc.array(fc.boolean(), { maxLength: 6 }), async (w, edits, dismiss) => {
        const args: ReportFindingsArgs = { findings: w.findings, path: 'a.md' };
        const { set } = await makeFindings(args, new Set(['a.md']), known(), MODEL, deps(new Map([['a.md', w.t]]))).catch(() => ({ set: null }));
        if (set === null) return;
        const s: FindingSet = { ...set, findings: set.findings.map((f, i) => (dismiss[i] ? { ...f, status: 'dismissed' } : f)) };
        let t = w.t;
        for (const e of edits) {
          if (e.kind === 'type') {
            const at = e.at % (t.length + 1);
            t = t.slice(0, at) + e.ins + t.slice(at + e.del);
          } else if (e.kind === 'paste' && t.length > 0) {
            const from = e.from % t.length;
            const at = e.to % (t.length + 1);
            t = t.slice(0, at) + t.slice(from, from + e.len) + t.slice(at);
          }
        }
        const marks = findingMarks(t, [s]);
        const unchanged = fingerprint(t) === s.expect;
        for (const f of s.findings) {
          const mine = marks.filter((m) => m.findingId === f.id);
          const placeable = f.status === 'open' && ((unchanged && t.startsWith(f.quote, f.at)) || count(t, f.quote) === 1);
          expect(mine).toHaveLength(placeable ? 1 : 0);
          for (const m of mine) {
            expect(t.slice(m.from, m.to)).toBe(f.quote);
            if (unchanged) expect(m.from).toBe(f.at);
            else expect(count(t, f.quote)).toBe(1);
          }
        }
      }),
    );
  });

  it('"Suggest fix" asks for an edit to that passage only', () => {
    const set: FindingSet = { id: 's', path: 'Drafts/Essay.md', expect: '', createdAt: 0, model: MODEL, findings: [] };
    const msg = suggestFixMessage(set, { id: 'f', quote: 'The the', at: 0, kind: 'doubled-word', explanation: 'Doubled word.', sources: [], status: 'open' });
    expect(msg).toBe('Suggest a fix for this doubled-word in Drafts/Essay.md: “The the” (Doubled word). Use propose_edit, changing only that passage.');
  });
});

describe('findings through a session (INVARIANTS.md F1, H6)', () => {
  it('a reported set is kept in the chat, linked from its tool result, and dismissing changes only its status', async () => {
    const { ChatSession } = await import('../../src/core/chat/session');
    const { ToolRegistry } = await import('../../src/core/tools/registry');
    const { toolRuns } = await import('../../src/core/tools/run');
    const { EMPTY_CONTEXT } = await import('../../src/core/context/state');
    const note = 'The the lighthouse was finished in 1844. Its light could be seen fourty kilometres away.';
    const registry = new ToolRegistry();
    registry.register(reportFindingsTool(deps(new Map([['a.md', note]]))));
    let call = 0;
    const provider = {
      id: 'fake',
      label: 'Fake',
      capabilities: () => Promise.resolve({ toolCalling: 'native' as const, nativeWebSearch: false, images: false, contextWindow: 100_000 }),
      listModels: () => Promise.resolve([]),
      async *stream() {
        await Promise.resolve();
        if (call++ === 0) {
          yield {
            type: 'tool_call' as const,
            call: { id: 'c1', name: 'report_findings', arguments: { findings: [{ quote: 'The the', kind: 'doubled-word', explanation: 'Doubled.' }, { quote: 'fourty', kind: 'typo', explanation: 'forty' }, { quote: 'light', kind: 'typo', explanation: 'ambiguous' }] } },
          };
        } else yield { type: 'text' as const, text: 'Found 2.' };
        yield { type: 'done' as const, reason: 'stop' as const };
      },
    };
    let n = 0;
    const session = new ChatSession(
      { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'fake', model: 'm' }, messages: [], context: EMPTY_CONTEXT },
      {
        providers: { get: () => provider },
        clock: { now: () => 0 },
        newId: () => `s${++n}`,
        save: () => Promise.resolve(),
        prepare: () => Promise.resolve({ message: 'CTX', images: [], tokens: 5, manifest: { notes: [{ path: 'a.md', hash: 'h' }], selections: [], attachments: [], backlinkLists: 0, excluded: 0 }, skipped: [], urls: [] }),
        tools: toolRuns(registry, { webNames: () => [], reviewNames: () => [], displayMode: () => 'inline', limits: () => ({ searches: 5, fetches: 5 }) }),
      },
    );
    const proofread = { id: 'proofread', name: 'Proofread', icon: 'spell-check', tools: [], output: 'findings' as const, prompt: 'Proofread.' };
    expect(session.send('', proofread)).toBe(true);
    for (let i = 0; i < 50 && session.busy; i++) await new Promise<void>((r) => setImmediate(r));
    const reply = session.chat.messages.at(-1);
    expect(reply?.role === 'assistant' && reply.status).toBe('complete');
    const result = reply?.role === 'assistant' ? reply.steps?.[0]?.calls[0]?.result : undefined;
    expect(result?.ok).toBe(true);
    expect(result?.content).toContain('3. "light" appears more than once');
    expect(result).not.toHaveProperty('findings'); // only the id is kept on the result
    const set = session.chat.findings?.[result!.findingsId!];
    expect(set?.findings.map((f) => [f.quote, f.at])).toEqual([
      ['The the', 0],
      ['fourty', note.indexOf('fourty')],
    ]);
    session.dismissFinding(set!.id, set!.findings[1]!.id);
    expect(session.chat.findings?.[set!.id]?.findings.map((f) => f.status)).toEqual(['open', 'dismissed']);
    expect(session.chat.findings?.[set!.id]?.findings.map((f) => f.quote)).toEqual(['The the', 'fourty']);
  });
});
