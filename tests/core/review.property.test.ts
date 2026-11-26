// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md W2–W6: proposal validation, no write without accept, undo safety, history, propose_note. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Chat } from '../../src/core/chat/types';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import { applyHunks } from '../../src/core/review/hunks';
import { EditLog } from '../../src/core/review/log';
import { type ProposalHost, ReviewManager } from '../../src/core/review/manager';
import { newNotePathProblem, proposeEdit } from '../../src/core/review/proposals';
import { proposeEditTool, proposeNoteTool } from '../../src/core/review/tools';
import type { EditApplier, Proposal, Splice } from '../../src/core/review/types';
import { type Storage, type StorageNamespace, isStorageKey } from '../../src/core/storage';
import { KnownUrls } from '../../src/core/tools/urls';

const MODEL = { provider: 'ollama', model: 'm' };

class MemStorage implements Storage {
  readonly files = new Map<string, string>();
  private k(ns: StorageNamespace, key: string) {
    if (!isStorageKey(key)) throw new Error(`bad key ${String(key)}`);
    return `${ns}/${key}`;
  }
  read(ns: StorageNamespace, key: string) { return Promise.resolve(this.files.get(this.k(ns, key)) ?? null); }
  write(ns: StorageNamespace, key: string, data: string) { this.files.set(this.k(ns, key), data); return Promise.resolve(); }
  append(ns: StorageNamespace, key: string, data: string) { const k = this.k(ns, key); this.files.set(k, (this.files.get(k) ?? '') + data); return Promise.resolve(); }
  remove(ns: StorageNamespace, key: string) { this.files.delete(this.k(ns, key)); return Promise.resolve(); }
  list(ns: StorageNamespace) { return Promise.resolve([...this.files.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1))); }
}

interface Write { kind: 'apply' | 'create' | 'trash'; path: string; before: string; after: string }

/** An in-memory vault behind EditApplier that records every write it makes. */
class FakeVault implements EditApplier {
  readonly notes = new Map<string, string>();
  readonly writes: Write[] = [];
  apply(path: string, locate: (text: string) => Splice | null) {
    const text = this.notes.get(path);
    if (text === undefined) return Promise.resolve('missing' as const);
    const s = locate(text);
    if (!s) return Promise.resolve('conflict' as const);
    const next = text.slice(0, s.from) + s.insert + text.slice(s.to);
    this.notes.set(path, next);
    this.writes.push({ kind: 'apply', path, before: text, after: next });
    return Promise.resolve('applied' as const);
  }
  create(path: string, content: string) {
    if (this.notes.has(path)) return Promise.resolve('exists' as const);
    this.notes.set(path, content);
    this.writes.push({ kind: 'create', path, before: '', after: content });
    return Promise.resolve('created' as const);
  }
  trash(path: string) {
    const text = this.notes.get(path);
    if (text === undefined) return Promise.resolve('missing' as const);
    this.notes.delete(path);
    this.writes.push({ kind: 'trash', path, before: text, after: '' });
    return Promise.resolve('trashed' as const);
  }
}

class Host implements ProposalHost {
  chat: Chat = { id: 'chat1', title: '', createdAt: 0, updatedAt: 0, model: MODEL, messages: [], context: EMPTY_CONTEXT, proposals: {} };
  updateProposal(id: string, fn: (p: Proposal) => Proposal) {
    const p = this.chat.proposals![id];
    if (p) this.chat = { ...this.chat, proposals: { ...this.chat.proposals, [id]: fn(p) } };
  }
  add(p: Proposal) {
    this.chat = { ...this.chat, proposals: { ...this.chat.proposals, [p.id]: p } };
  }
}

/** True if `after` is `before` with exactly one span `out` replaced by `ins`. */
function singleSpan(before: string, after: string, out: string, ins: string): boolean {
  if (after.length !== before.length - out.length + ins.length) return false;
  for (let p = 0; p <= before.length - out.length; p++) {
    if (before.startsWith(out, p) && after.startsWith(before.slice(0, p) + ins) && after.endsWith(before.slice(p + out.length))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The edit world

const word = fc.constantFrom('the', 'teh', 'cat', 'sat', 'on', 'mat', 'keeper', 'light', 'its', "it's", 'their', 'there', '1844', 'naïve', '日本');
const sep = fc.constantFrom(' ', ' ', ', ', '. ', '\n');
const text = fc.array(fc.tuple(word, sep), { minLength: 3, maxLength: 40 }).map((ws) => ws.map(([w, s]) => w + s).join(''));
const PATHS = ['a.md', 'Notes/b.md', 'c.md'];

let n = 0;
const id = () => `id${++n}`;

// ---------------------------------------------------------------------------

describe('proposal validation (INVARIANTS.md W2, design invariant 8)', () => {
  it('W2: a proposal exists iff every find occurs exactly once, edits do not overlap, and something changes', () => {
    const editsFor = (t: string) =>
      fc.array(
        fc.oneof(
          fc.tuple(fc.nat(), fc.integer({ min: 1, max: 25 }), fc.array(word, { maxLength: 4 })).map(([at, len, ws]) => ({
            find: t.slice(at % Math.max(1, t.length), (at % Math.max(1, t.length)) + len),
            replace: ws.join(' '),
          })),
          fc.record({ find: fc.oneof(word, fc.string({ minLength: 1 })), replace: fc.string() }),
        ),
        { minLength: 1, maxLength: 4 },
      );
    fc.assert(
      fc.property(text.chain((t) => fc.tuple(fc.constant(t), editsFor(t))), ([t, edits]) => {
        const valid = edits.filter((e) => e.find !== '');
        fc.pre(valid.length === edits.length);
        const count = (s: string) => {
          let c = 0;
          for (let i = t.indexOf(s); i !== -1; i = t.indexOf(s, i + 1)) c++;
          return c;
        };
        const spans = edits.map((e) => ({ s: t.indexOf(e.find), e: t.indexOf(e.find) + e.find.length })).sort((x, y) => x.s - y.s);
        const unique = edits.every((e) => count(e.find) === 1);
        const disjoint = spans.every((sp, i) => i === 0 || spans[i - 1]!.e <= sp.s);
        const changes = edits.some((e) => e.find !== e.replace);
        const v = proposeEdit({ path: 'a.md', edits }, { text: t, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
        expect(v.ok).toBe(unique && disjoint && changes);
        if (v.ok) {
          // The hunks reproduce the model's edits exactly.
          v.proposal.edits.forEach((e, i) => {
            const own = v.proposal.hunks.filter((h) => h.edit === i);
            expect(applyHunks(e.find, own, own.map((_, k) => k))).toBe(e.replace);
          });
        }
      }),
    );
  });

  it('W2: only notes in the context can be edited', async () => {
    const vault = new Map([['a.md', 'the cat sat'], ['Private/p.md', 'secret']]);
    const tool = proposeEditTool({ readNote: (p) => Promise.resolve(vault.get(p)!), isExcluded: (p) => p.startsWith('Private'), exists: (p) => vault.has(p), newId: id, now: () => 0 });
    const ctx = { signal: new AbortController().signal, knownUrls: new KnownUrls(), approve: () => Promise.resolve(false), editable: new Set(['a.md']), model: MODEL };
    await expect(tool.run({ path: 'Private/p.md', edits: [{ find: 'secret', replace: 'x' }] }, ctx)).rejects.toThrow('only propose edits to notes in the context');
    await expect(tool.run({ path: '../a.md', edits: [{ find: 'cat', replace: 'dog' }] }, ctx)).rejects.toThrow('only propose edits');
    const ok = await tool.run({ path: 'a.md', edits: [{ find: 'cat', replace: 'dog', reason: 'r' }] }, ctx);
    expect(ok.proposal).toMatchObject({ kind: 'edit', path: 'a.md' });
  });
});

describe('review (INVARIANTS.md W3–W5, design invariants 3, 6, 7)', () => {
  interface World {
    vault: FakeVault;
    storage: MemStorage;
    log: EditLog;
    manager: ReviewManager;
    host: Host;
    /** Applied accepts, creates and reverts per path, to check the log against. */
    logged: Map<string, { hunk: number; create: number; revert: number }>;
    /** The text each proposal expects its note to have, if only its own accepts changed it. */
    expected: Map<string, string>;
  }

  const count = (hay: string, needle: string) => {
    let c = 0;
    for (let i = hay.indexOf(needle); i !== -1 && needle !== ''; i = hay.indexOf(needle, i + 1)) c++;
    return c;
  };

  const bump = (w: World, path: string, kind: 'hunk' | 'create' | 'revert') => {
    const c = w.logged.get(path) ?? { hunk: 0, create: 0, revert: 0 };
    c[kind] += 1;
    w.logged.set(path, c);
  };

  type Cmd = fc.AsyncCommand<World, World>;
  const cmd = (name: string, run: (w: World) => Promise<void>, writes: 'none' | 'maybe'): Cmd => ({
    check: () => true,
    async run(_m, w) {
      const before = w.vault.writes.length;
      await run(w);
      if (writes === 'none') expect(w.vault.writes.length, `${name} wrote to the vault`).toBe(before);
      // W5: the log matches what happened.
      for (const [path, c] of w.logged) {
        const entries = await w.log.entries(path);
        expect(entries.filter((e) => e.kind === 'hunk')).toHaveLength(c.hunk);
        expect(entries.filter((e) => e.kind === 'create')).toHaveLength(c.create);
        expect(entries.filter((e) => e.kind === 'revert')).toHaveLength(c.revert);
      }
    },
    toString: () => name,
  });

  const edits = (w: World, path: string, picks: Array<[number, number, string[]]>) => {
    const t = w.vault.notes.get(path) ?? '';
    return picks.map(([at, len, ws]) => {
      const s = at % Math.max(1, t.length);
      return { find: t.slice(s, s + len) || 'zz', replace: ws.join(' '), reason: 'r' };
    });
  };

  const proposals = (w: World) => Object.values(w.host.chat.proposals ?? {});

  const commands = fc.commands(
    [
      fc.tuple(fc.nat(), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 2, max: 30 }), fc.array(word, { maxLength: 4 })), { minLength: 1, maxLength: 3 })).map(([pi, picks]) =>
        cmd(`propose(${pi})`, async (w) => {
          const path = PATHS[pi % PATHS.length]!;
          const t = w.vault.notes.get(path);
          if (t === undefined) return;
          const v = proposeEdit({ path, edits: edits(w, path, picks) }, { text: t, id: id(), hunkId: id, createdAt: 0, model: MODEL });
          await Promise.resolve();
          if (v.ok) {
            w.host.add(v.proposal);
            w.expected.set(v.proposal.id, t);
          }
        }, 'none'),
      ),
      fc.tuple(fc.nat(), fc.nat()).map(([pi, hi]) =>
        cmd(`accept(${pi}, ${hi})`, async (w) => {
          const ps = proposals(w).filter((p) => p.kind === 'edit');
          const p = ps[pi % Math.max(1, ps.length)];
          if (p?.kind !== 'edit') return;
          const h = p.hunks[hi % p.hunks.length]!;
          const before = w.vault.writes.length;
          const outcome = await w.manager.acceptHunk(w.host, p.id, h.id);
          const after = (w.host.chat.proposals![p.id] as typeof p).hunks.find((x) => x.id === h.id)!;
          if (outcome === 'applied') {
            // W3: exactly this hunk, at one place, nothing else.
            const write = w.vault.writes.at(-1)!;
            expect(w.vault.writes.length).toBe(before + 1);
            expect(singleSpan(write.before, write.after, p.edits[h.edit]!.find.slice(h.start, h.end), h.after)).toBe(true);
            expect(after.status).toBe('accepted');
            // W3: and at the right place. If anything else changed the note, the passage had to be unambiguous.
            if (write.before !== w.expected.get(p.id)) {
              const own = p.hunks.filter((k) => k.edit === h.edit);
              const region = applyHunks(p.edits[h.edit]!.find, own, own.flatMap((k, i) => (k.status === 'accepted' ? [i] : [])));
              expect(count(write.before, region)).toBe(1);
            }
            w.expected.set(p.id, write.after);
            bump(w, p.path, 'hunk');
          } else {
            expect(w.vault.writes.length).toBe(before);
            if (h.status === 'pending') expect(after.status).toBe('pending');
          }
          // Accepting a decided hunk again never applies twice.
          if (after.status !== 'pending') {
            const again = w.vault.writes.length;
            expect(await w.manager.acceptHunk(w.host, p.id, h.id)).toBe('done');
            expect(w.vault.writes.length).toBe(again);
          }
        }, 'maybe'),
      ),
      fc.tuple(fc.nat(), fc.nat()).map(([pi, hi]) =>
        cmd(`reject(${pi}, ${hi})`, async (w) => {
          const ps = proposals(w).filter((p) => p.kind === 'edit');
          const p = ps[pi % Math.max(1, ps.length)];
          if (p?.kind !== 'edit') return;
          w.manager.rejectHunk(w.host, p.id, p.hunks[hi % p.hunks.length]!.id);
          await Promise.resolve();
        }, 'none'),
      ),
      fc.nat().map((pi) =>
        cmd(`acceptAll(${pi})`, async (w) => {
          const ps = proposals(w).filter((p) => p.kind === 'edit');
          const p = ps[pi % Math.max(1, ps.length)];
          if (p?.kind !== 'edit') return;
          const before = w.vault.writes.length;
          const { applied } = await w.manager.acceptAll(w.host, p.id);
          expect(w.vault.writes.length).toBe(before + applied);
          for (let k = 0; k < applied; k++) bump(w, p.path, 'hunk');
        }, 'maybe'),
      ),
      fc.nat().map((pi) =>
        cmd(`rejectAll(${pi})`, async (w) => {
          const ps = proposals(w).filter((p) => p.kind === 'edit');
          const p = ps[pi % Math.max(1, ps.length)];
          if (p) w.manager.rejectAll(w.host, p.id);
          await Promise.resolve();
        }, 'none'),
      ),
      // The user types: anywhere, including inside a proposed passage. Not through the applier.
      fc.tuple(fc.nat(), fc.nat(), fc.nat({ max: 6 }), fc.oneof(word, fc.constant(''))).map(([pi, at, del, ins]) =>
        cmd(`type(${pi}, ${at}, -${del}, "${ins}")`, async (w) => {
          const path = PATHS[pi % PATHS.length]!;
          const t = w.vault.notes.get(path);
          if (t === undefined) return;
          const s = at % (t.length + 1);
          w.vault.notes.set(path, t.slice(0, s) + ins + t.slice(s + del));
          await Promise.resolve();
        }, 'none'),
      ),
      // The user copies part of the note and pastes it elsewhere: the usual way passages get duplicated.
      fc.tuple(fc.nat(), fc.nat(), fc.oneof(fc.integer({ min: 2, max: 60 }), fc.integer({ min: 60, max: 400 })), fc.nat()).map(([pi, from, len, to]) =>
        cmd(`paste(${pi}, ${from}+${len} → ${to})`, async (w) => {
          const path = PATHS[pi % PATHS.length]!;
          const t = w.vault.notes.get(path);
          if (t === undefined || t.length === 0) return;
          const s0 = from % t.length;
          const copy = t.slice(s0, s0 + len);
          const at = to % (t.length + 1);
          w.vault.notes.set(path, t.slice(0, at) + copy + t.slice(at));
          await Promise.resolve();
        }, 'none'),
      ),
      fc.tuple(fc.nat(), fc.nat()).map(([pi, ei]) =>
        cmd(`revert(${pi}, ${ei})`, async (w) => {
          const path = PATHS[pi % PATHS.length]!;
          const entries = (await w.log.entries(path)).filter((e) => e.kind !== 'revert');
          const e = entries[ei % Math.max(1, entries.length)];
          if (!e) return;
          const before = w.vault.writes.length;
          const textBefore = w.vault.notes.get(path);
          const outcome = await w.manager.revert(path, e.id);
          if (outcome === 'reverted') {
            const write = w.vault.writes.at(-1)!;
            expect(w.vault.writes.length).toBe(before + 1);
            // W4: the spot was identified unambiguously.
            if (e.kind !== 'create') {
              const needle = e.contextBefore + e.after + e.contextAfter;
              // An empty needle means the change emptied the note: the only place to undo it is an empty note.
              if (needle === '') expect(textBefore).toBe('');
              else expect(count(textBefore!, needle)).toBe(1);
            }
            // W4: reverses exactly that change (or trashes an unchanged created note), never anything else.
            if (e.kind === 'create') expect(write).toMatchObject({ kind: 'trash', before: e.after });
            else expect(singleSpan(textBefore!, write.after, e.after, e.before)).toBe(true);
            bump(w, path, 'revert');
          } else {
            expect(w.vault.writes.length).toBe(before);
          }
        }, 'maybe'),
      ),
      fc.tuple(fc.nat(), fc.string({ maxLength: 20 })).map(([pi, content]) =>
        cmd(`proposeNote+create(${pi})`, async (w) => {
          const path = `New/n${pi % 4}.md`;
          if (newNotePathProblem(path, () => false, (p) => w.vault.notes.has(p))) return;
          const p: Proposal = { kind: 'note', id: id(), path, content, status: 'pending', createdAt: 0, model: MODEL };
          w.host.add(p);
          const outcome = await w.manager.createNote(w.host, p.id);
          expect(outcome).toBe('created');
          expect(w.vault.notes.get(path)).toBe(content); // W6: exactly what was proposed
          bump(w, path, 'create');
        }, 'maybe'),
      ),
      fc.nat().map((pi) =>
        cmd(`rename(${pi})`, async (w) => {
          const from = PATHS[pi % PATHS.length]!;
          const t = w.vault.notes.get(from);
          if (t === undefined) return;
          const to = `Moved/${from.replace('/', '-')}`;
          if (w.vault.notes.has(to)) return;
          w.vault.notes.delete(from);
          w.vault.notes.set(to, t);
          const before = await w.log.entries(from);
          await w.log.renamed(from, to);
          // W5: history follows the note.
          expect(await w.log.entries(to)).toEqual(before);
          if (w.logged.has(from)) {
            w.logged.set(to, w.logged.get(from)!);
            w.logged.delete(from);
          }
        }, 'none'),
      ),
    ],
    { maxCommands: 50, size: 'large' },
  );

  it('W3–W5: the vault changes only on accept, create or revert, by exactly the hunk; the log records each', async () => {
    await fc.assert(
      fc.asyncProperty(fc.tuple(text, text, text), commands, async (texts, cmds) => {
        const vault = new FakeVault();
        texts.forEach((t, i) => vault.notes.set(PATHS[i]!, t));
        const storage = new MemStorage();
        const log = new EditLog(storage, id);
        const manager = new ReviewManager({ applier: vault, log, readNote: (p) => (vault.notes.has(p) ? Promise.resolve(vault.notes.get(p)!) : Promise.reject(new Error('gone'))), clock: { now: () => 0 } });
        const world: World = { vault, storage, log, manager, host: new Host(), logged: new Map(), expected: new Map() };
        await fc.asyncModelRun(() => ({ model: world, real: world }), cmds);
      }),
    );
  });

  it('W1+W3: accepting every hunk, in any order, with no other edits, gives exactly the model’s edits', async () => {
    await fc.assert(
      fc.asyncProperty(text, fc.array(fc.tuple(fc.nat(), fc.integer({ min: 3, max: 30 }), fc.array(word, { maxLength: 5 })), { minLength: 1, maxLength: 3 }), fc.nat(), async (t, picks, seed) => {
        const vault = new FakeVault();
        vault.notes.set('a.md', t);
        const raw = picks.map(([at, len, ws]) => ({ find: t.slice(at % t.length, (at % t.length) + len), replace: ws.join(' ') }));
        const v = proposeEdit({ path: 'a.md', edits: raw }, { text: t, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
        fc.pre(v.ok);
        if (!v.ok) return;
        const host = new Host();
        host.add(v.proposal);
        const manager = new ReviewManager({ applier: vault, log: new EditLog(new MemStorage(), id), readNote: () => Promise.resolve(''), clock: { now: () => 0 } });
        const order = [...v.proposal.hunks].sort((x, y) => ((x.start * 31 + seed) % 7) - ((y.start * 31 + seed) % 7));
        for (const h of order) expect(await manager.acceptHunk(host, 'p', h.id)).toBe('applied');
        let expected = t;
        for (const e of [...raw].sort((x, y) => t.indexOf(y.find) - t.indexOf(x.find))) {
          const at = t.indexOf(e.find);
          expected = expected.slice(0, at) + e.replace + expected.slice(at + e.find.length);
        }
        expect(vault.notes.get('a.md')).toBe(expected);
      }),
    );
  });

  it('W4: a revert whose spot is no longer unique reports a conflict and changes nothing', async () => {
    const vault = new FakeVault();
    vault.notes.set('a.md', 'Intro. The keepers lived their for months. Outro.');
    const log = new EditLog(new MemStorage(), id);
    const manager = new ReviewManager({ applier: vault, log, readNote: (p) => Promise.resolve(vault.notes.get(p)!), clock: { now: () => 0 } });
    const host = new Host();
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'lived their for', replace: 'lived there for' }] }, { text: vault.notes.get('a.md')!, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host.add(v.proposal);
    await manager.acceptAll(host, 'p');
    const accepted = vault.notes.get('a.md')!;
    vault.notes.set('a.md', accepted + accepted); // the user pasted the whole note again
    const writes = vault.writes.length;
    const [entry] = await log.entries('a.md');
    expect(await manager.revert('a.md', entry!.id)).toBe('conflict');
    expect(vault.writes.length).toBe(writes);
    expect(vault.notes.get('a.md')).toBe(accepted + accepted);
  });

  // Regression (W3–W5 seed -1474712944, CI run): a change that emptied the whole note has no context to
  // anchor on. The revert put the text back into the empty note, which is right; the checker counted an
  // empty anchor as zero occurrences.
  it('W4: reverting a change that emptied the note puts the text back', async () => {
    const vault = new FakeVault();
    vault.notes.set('a.md', 'the the the ');
    const log = new EditLog(new MemStorage(), id);
    const manager = new ReviewManager({ applier: vault, log, readNote: (p) => Promise.resolve(vault.notes.get(p)!), clock: { now: () => 0 } });
    const host = new Host();
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'the the the ', replace: '' }] }, { text: 'the the the ', id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host.add(v.proposal);
    await manager.acceptAll(host, 'p');
    expect(vault.notes.get('a.md')).toBe('');
    const [entry] = await log.entries('a.md');
    expect(await manager.revert('a.md', entry!.id)).toBe('reverted');
    expect(vault.notes.get('a.md')).toBe('the the the ');
  });

  it('W4: a revert with no edits since restores the text exactly', async () => {
    const vault = new FakeVault();
    vault.notes.set('a.md', 'The the lighthouse keepers lived their for months.');
    const log = new EditLog(new MemStorage(), id);
    const manager = new ReviewManager({ applier: vault, log, readNote: (p) => Promise.resolve(vault.notes.get(p)!), clock: { now: () => 0 } });
    const host = new Host();
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'lived their for', replace: 'lived there for' }] }, { text: vault.notes.get('a.md')!, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host.add(v.proposal);
    const original = vault.notes.get('a.md');
    await manager.acceptAll(host, 'p');
    expect(vault.notes.get('a.md')).toBe('The the lighthouse keepers lived there for months.');
    const [entry] = await log.entries('a.md');
    expect(await manager.revert('a.md', entry!.id)).toBe('reverted');
    expect(vault.notes.get('a.md')).toBe(original);
    expect(await manager.revert('a.md', entry!.id)).toBe('already');
  });
});

describe('propose_note (INVARIANTS.md W6)', () => {
  it('W6: only new, allowed Markdown paths', () => {
    const path = fc.oneof(
      fc.constantFrom('New/idea.md', 'idea.md', 'a.md', 'Private/x.md', '.hidden/x.md', '../x.md', '/abs.md', 'x.txt', 'a/./b.md', 'a//b.md', 'C:/x.md', 'a\\b.md', `${'x'.repeat(201)}.md`, 'Notes/b.md'),
      fc.string(),
    );
    fc.assert(
      fc.property(path, (p) => {
        const existing = new Set(['a.md', 'Notes/b.md']);
        const problem = newNotePathProblem(p, (x) => x.split('/')[0] === 'Private', (x) => existing.has(x));
        const segs = p.split('/');
        const ok =
          p.toLowerCase().endsWith('.md') &&
          p.length <= 512 &&
          // eslint-disable-next-line no-control-regex -- control characters are exactly what the rule rejects
          segs.every((s) => s !== '' && s !== '.' && s !== '..' && !s.startsWith('.') && s.length <= 200 && !/[\\:*?"<>|\u0000-\u001f]/.test(s)) &&
          segs[0] !== 'Private' &&
          !existing.has(p);
        expect(problem === null).toBe(ok);
      }),
    );
  });

  it('W6: a created note is trashed by a revert only if unchanged since', async () => {
    const vault = new FakeVault();
    const log = new EditLog(new MemStorage(), id);
    const manager = new ReviewManager({ applier: vault, log, readNote: (p) => Promise.resolve(vault.notes.get(p)!), clock: { now: () => 0 } });
    const host = new Host();
    const tool = proposeNoteTool({ readNote: () => Promise.resolve(''), isExcluded: () => false, exists: (p) => vault.notes.has(p), newId: id, now: () => 0 });
    const ctx = { signal: new AbortController().signal, knownUrls: new KnownUrls(), approve: () => Promise.resolve(false), editable: new Set<string>(), model: MODEL };
    for (const changed of [false, true]) {
      const out = await tool.run({ path: `New/n${changed ? 2 : 1}.md`, content: 'hello' }, ctx);
      host.add(out.proposal!);
      expect(vault.notes.has(out.proposal!.path)).toBe(false); // nothing before Create
      expect(await manager.createNote(host, out.proposal!.id)).toBe('created');
      if (changed) vault.notes.set(out.proposal!.path, 'hello, edited');
      const [entry] = await log.entries(out.proposal!.path);
      expect(await manager.revert(out.proposal!.path, entry!.id)).toBe(changed ? 'conflict' : 'reverted');
      expect(vault.notes.has(out.proposal!.path)).toBe(changed);
    }
  });
});
