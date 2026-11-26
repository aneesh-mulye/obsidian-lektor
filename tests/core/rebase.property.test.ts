// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md B1–B4: rebase honesty, staleness, lossless auto-rebase, inline marks. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Chat } from '../../src/core/chat/types';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import { EditLog } from '../../src/core/review/log';
import { type ProposalHost, ReviewManager } from '../../src/core/review/manager';
import { editTextNow, locateHunk, proposeEdit } from '../../src/core/review/proposals';
import { inlineMarks, rebase, staleness } from '../../src/core/review/rebase';
import type { EditApplier, EditProposal, HunkRecord, Proposal, Splice } from '../../src/core/review/types';
import type { Storage, StorageNamespace } from '../../src/core/storage';

const MODEL = { provider: 'ollama', model: 'm' };
let n = 0;
const id = () => `h${++n}`;

const word = fc.constantFrom('the', 'teh', 'cat', 'sat', 'on', 'mat', 'keeper', 'light', 'its', "it's", 'their', 'there', '1844', 'naïve');
const sep = fc.constantFrom(' ', ' ', ', ', '. ', '\n');
const prose = fc.array(fc.tuple(word, sep), { minLength: 6, maxLength: 50 }).map((ws) => ws.map(([w, s]) => w + s).join(''));

type UserEdit = { kind: 'type'; at: number; del: number; ins: string } | { kind: 'paste'; from: number; len: number; to: number };
const userEdit: fc.Arbitrary<UserEdit> = fc.oneof(
  fc.record({ kind: fc.constant('type' as const), at: fc.nat(), del: fc.nat({ max: 8 }), ins: fc.oneof(word, fc.constant('')) }),
  fc.record({ kind: fc.constant('paste' as const), from: fc.nat(), len: fc.integer({ min: 2, max: 80 }), to: fc.nat() }),
);
function applyUser(t: string, e: UserEdit): string {
  if (e.kind === 'type') {
    const s = e.at % (t.length + 1);
    return t.slice(0, s) + e.ins + t.slice(s + e.del);
  }
  if (t.length === 0) return t;
  const f = e.from % t.length;
  const at = e.to % (t.length + 1);
  return t.slice(0, at) + t.slice(f, f + e.len) + t.slice(at);
}

/** A proposal on `text`, some hunks decided (accepted ones applied to the text), then user edits. */
const world = fc
  .tuple(
    prose,
    fc.array(fc.tuple(fc.nat(), fc.integer({ min: 3, max: 40 }), fc.array(word, { maxLength: 5 })), { minLength: 1, maxLength: 4 }),
    fc.array(fc.constantFrom('accept', 'reject', 'leave'), { maxLength: 8 }),
    fc.array(userEdit, { maxLength: 4 }),
  )
  .map(([t, picks, decisions, edits]) => {
    const v = proposeEdit(
      { path: 'a.md', edits: picks.map(([at, len, ws]) => ({ find: t.slice(at % t.length, (at % t.length) + len), replace: ws.join(' '), reason: 'r' })) },
      { text: t, id: 'p', hunkId: id, createdAt: 0, model: MODEL },
    );
    if (!v.ok) return null;
    let p = v.proposal;
    let text = t;
    p.hunks.forEach((h, i) => {
      const d = decisions[i] ?? 'leave';
      if (d === 'leave') return;
      if (d === 'accept') {
        const s = locateHunk(text, p, h.id);
        if (!s) return;
        text = text.slice(0, s.from) + s.insert + text.slice(s.to);
        // The review's own accept keeps the note "as expected".
        p = { ...p, expect: rebaseExpect(text), hunks: p.hunks.map((x) => (x.id === h.id ? { ...x, status: 'accepted' } : x)) };
      } else {
        p = { ...p, hunks: p.hunks.map((x) => (x.id === h.id ? { ...x, status: 'rejected' } : x)) };
      }
    });
    const edited = edits.reduce(applyUser, text);
    return { p, before: text, text: edited, userEdited: edits.length > 0 && edited !== text };
  })
  .filter((w): w is NonNullable<typeof w> => w !== null);

import { fingerprint as rebaseExpect } from '../../src/core/review/fingerprint';

const beforeOf = (p: EditProposal, h: HunkRecord) => p.edits[h.edit]!.find.slice(h.start, h.end);

describe('rebase (INVARIANTS.md B1, B2, B4)', () => {
  it('B1: every pending hunk is kept (locatable, same change) or dropped with a reason; decided hunks untouched', () => {
    fc.assert(
      fc.property(world, ({ p, text }) => {
        const pending = p.hunks.filter((h) => h.status === 'pending');
        const r = rebase(text, p);
        expect(new Set([...r.kept, ...r.dropped.map((d) => d.hunkId)])).toEqual(new Set(pending.map((h) => h.id)));
        expect(r.kept.length + r.dropped.length).toBe(pending.length);
        for (const hid of r.kept) {
          const old = p.hunks.find((h) => h.id === hid)!;
          const now = r.proposal.hunks.find((h) => h.id === hid)!;
          expect(now.status).toBe('pending');
          const s = locateHunk(text, r.proposal, hid);
          expect(s).not.toBeNull();
          expect(text.slice(s!.from, s!.to)).toBe(beforeOf(p, old));
          expect(s!.insert).toBe(old.after);
        }
        for (const d of r.dropped) {
          const now = r.proposal.hunks.find((h) => h.id === d.hunkId)!;
          expect(now.status).toBe('dropped');
          expect(now.dropReason).toBe(d.reason);
          expect(locateHunk(text, r.proposal, d.hunkId)).toBeNull();
        }
        // Decided hunks are untouched: same record, same edit text (its index may shift when unused edits are dropped).
        for (const h of p.hunks.filter((x) => x.status !== 'pending')) {
          const now = r.proposal.hunks.find((x) => x.id === h.id)!;
          expect({ ...now, edit: 0 }).toEqual({ ...h, edit: 0 });
          expect(r.proposal.edits[now.edit]).toEqual(p.edits[h.edit]);
        }
      }),
    );
  });

  it('B1: a rebase stores only the model\'s own text (H5), and repeated rebases don\'t pile up edits', () => {
    fc.assert(
      fc.property(world, fc.array(userEdit, { maxLength: 3 }), ({ p, text }, more) => {
        const regions = p.edits.map((_, i) => editTextNow(p, i));
        const r = rebase(text, p);
        for (const e of r.proposal.edits) {
          if (p.edits.includes(e)) continue;
          expect(regions.some((region) => region.includes(e.find))).toBe(true);
        }
        // Rebase again after more typing: at most one edit per hunk.
        const again = rebase(more.reduce(applyUser, text), r.proposal);
        expect(again.proposal.edits.length).toBeLessThanOrEqual(p.hunks.length);
        expect(new Set(again.proposal.hunks.map((h) => h.edit)).size).toBe(again.proposal.edits.length);
      }),
    );
  });

  it('B1: with no user edits, a rebase drops nothing and changes nothing', () => {
    fc.assert(
      fc.property(world, ({ p, before }) => {
        const r = rebase(before, p);
        expect(r.dropped).toEqual([]);
        expect(r.proposal).toBe(p);
      }),
    );
  });

  it('B1: after a rebase, accepting the kept hunks in any order writes exactly each one', () => {
    fc.assert(
      fc.property(world, fc.nat(), ({ p, text }, seed) => {
        const r = rebase(text, p);
        let q = r.proposal;
        let t = text;
        const order = [...r.kept].sort((a, b) => ((a.charCodeAt(1) * 7 + seed) % 5) - ((b.charCodeAt(1) * 7 + seed) % 5));
        for (const hid of order) {
          const s = locateHunk(t, q, hid);
          expect(s).not.toBeNull();
          const h = q.hunks.find((x) => x.id === hid)!;
          expect(t.slice(s!.from, s!.to)).toBe(beforeOf(q, h));
          const next = t.slice(0, s!.from) + s!.insert + t.slice(s!.to);
          // As the manager does: the note stays "as expected" only if it was before this accept.
          const nextExpect = rebaseExpect(t) === q.expect ? rebaseExpect(next) : q.expect;
          q = { ...q, expect: nextExpect, hunks: q.hunks.map((x) => (x.id === hid ? { ...x, status: 'accepted' } : x)) };
          t = next;
        }
      }),
    );
  });

  it('B2, B4: stale = pending hunks that cannot be located; marks = exactly the locatable ones', () => {
    fc.assert(
      fc.property(world, ({ p, text }) => {
        const { stale, locatable } = staleness(text, p);
        for (const h of p.hunks.filter((x) => x.status === 'pending')) {
          expect(stale.includes(h.id)).toBe(locateHunk(text, p, h.id) === null);
          expect(locatable.includes(h.id)).toBe(locateHunk(text, p, h.id) !== null);
        }
        const marks = inlineMarks(text, [p]);
        expect(marks.map((m) => m.hunkId).sort()).toEqual([...locatable].sort());
        for (const m of marks) {
          const h = p.hunks.find((x) => x.id === m.hunkId)!;
          expect(m.from).toBeGreaterThanOrEqual(0);
          expect(m.to).toBeLessThanOrEqual(text.length);
          expect(text.slice(m.from, m.to)).toBe(beforeOf(p, h));
          expect(m.insert).toBe(h.after);
        }
      }),
    );
  });

  // Regression (B1, CI run): after the user deleted a space, accepting "the 1" → "1844" duplicated the other
  // edit's text ("1844844"), so "844" became ambiguous. A rebase now re-anchors whenever the note changed
  // outside the review, so positions are exact again.
  it('accepting one hunk cannot make another ambiguous after the user edited the note', () => {
    const text = 'the 1844 on. it\'s the, the there, ';
    const v = proposeEdit(
      { path: 'a.md', edits: [{ find: 'the 1', replace: '1844' }, { find: '844', replace: '' }] },
      { text, id: 'p', hunkId: id, createdAt: 0, model: MODEL },
    );
    if (!v.ok) throw new Error(v.error);
    const edited = text.replace('1844 on', '1844on');
    const r = rebase(edited, v.proposal);
    expect(r.dropped).toEqual([]);
    const [first, second] = r.kept;
    let q = r.proposal;
    const s1 = locateHunk(edited, q, first!)!;
    const t1 = edited.slice(0, s1.from) + s1.insert + edited.slice(s1.to);
    q = { ...q, expect: rebaseExpect(t1), hunks: q.hunks.map((x) => (x.id === first ? { ...x, status: 'accepted' } : x)) };
    expect(locateHunk(t1, q, second!)).not.toBeNull();
  });

  it('B1: knowing the text the review last saw, positions carry through the change exactly; touched hunks are dropped', () => {
    fc.assert(
      fc.property(world, userEdit, ({ p, before }, e) => {
        const text = applyUser(before, e);
        fc.pre(text !== before);
        // The model of the change: the common prefix and suffix of the two texts.
        let pre = 0;
        while (pre < Math.min(before.length, text.length) && before[pre] === text[pre]) pre++;
        let suf = 0;
        while (suf < Math.min(before.length, text.length) - pre && before[before.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
        const oldEnd = before.length - suf;
        const r = rebase(text, p, before);
        for (const h of p.hunks.filter((x) => x.status === 'pending')) {
          const old = locateHunk(before, p, h.id)!;
          const untouchedBefore = old.to <= pre && !(old.from === old.to && old.from === pre && oldEnd > pre);
          const untouchedAfter = old.from >= oldEnd;
          const now = locateHunk(text, r.proposal, h.id);
          if (untouchedBefore) expect(now?.from).toBe(old.from);
          else if (untouchedAfter) expect(now?.from).toBe(old.from + text.length - before.length);
          else expect(r.dropped.map((d) => d.hunkId)).toContain(h.id);
        }
      }),
    );
  });

  it('without the previous text, a passage that now appears twice is dropped, never guessed', () => {
    const text = 'Their keeper lived their for months.';
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'lived their for', replace: 'lived there for' }] }, { text, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    // The user pastes the sentence again, then changes the original's surroundings.
    const edited = 'Their keeper lived their for months. Their keeper lived their for months.'.replace('Their keeper lived', 'The keeper lived');
    const r = rebase(edited, v.proposal);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([{ hunkId: v.proposal.hunks[0]!.id, reason: 'the passage now appears more than once' }]);
  });

  it('without the previous text, two hunks that would now overlap keep only the first', () => {
    const text = 'ab-bc';
    const v = proposeEdit(
      { path: 'a.md', edits: [{ find: 'ab', replace: 'X' }, { find: 'bc', replace: 'Y' }] },
      { text, id: 'p', hunkId: id, createdAt: 0, model: MODEL },
    );
    if (!v.ok) throw new Error(v.error);
    const [h1, h2] = v.proposal.hunks;
    const r = rebase('abc', v.proposal); // the user deleted "-b"
    expect(r.kept).toEqual([h1!.id]);
    expect(r.dropped).toEqual([{ hunkId: h2!.id, reason: 'it now overlaps another proposed change' }]);
  });

  it('a one-word edit inside a long edit loses only the hunks it touched', () => {
    const text = 'The the lighthouse on Skerryvore was finished in 1844, and its keepers lived their for months at a time.';
    const v = proposeEdit(
      { path: 'a.md', edits: [{ find: text, replace: 'The lighthouse on Skerryvore was finished in 1844, and its keepers lived there for months at a time.' }] },
      { text, id: 'p', hunkId: id, createdAt: 0, model: MODEL },
    );
    if (!v.ok) throw new Error(v.error);
    expect(v.proposal.hunks).toHaveLength(2);
    const edited = text.replace('Skerryvore', 'Skerry Vore'); // the user edits between the two hunks
    expect(staleness(edited, v.proposal).stale).toHaveLength(2); // the whole edit's passage no longer matches
    const r = rebase(edited, v.proposal);
    expect(r.dropped).toEqual([]); // but each hunk re-anchors on its own context
    expect(r.kept).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

class Host implements ProposalHost {
  chat: Chat = { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: MODEL, messages: [], context: EMPTY_CONTEXT, proposals: {} };
  updateProposal(pid: string, fn: (p: Proposal) => Proposal) {
    const p = this.chat.proposals![pid];
    if (p) this.chat = { ...this.chat, proposals: { ...this.chat.proposals, [pid]: fn(p) } };
  }
}
const noStorage: Storage = {
  read: () => Promise.resolve(null),
  write: () => Promise.resolve(),
  append: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  list: (_ns: StorageNamespace) => Promise.resolve([]),
};
const noApplier: EditApplier = {
  apply: (_p: string, _l: (t: string) => Splice | null) => Promise.resolve('conflict'),
  create: () => Promise.resolve('exists'),
  trash: () => Promise.resolve('missing'),
};

describe('automatic rebase (INVARIANTS.md B3)', () => {
  it('B3: after typing that touches no hunk, the manager rebases by itself and every hunk is exactly where it went', () => {
    fc.assert(
      fc.property(world, userEdit, ({ p, before }, e) => {
        const text = applyUser(before, e);
        fc.pre(text !== before);
        const host = new Host();
        host.chat = { ...host.chat, proposals: { p } };
        const manager = new ReviewManager({ applier: noApplier, log: new EditLog(noStorage, id), readNote: () => Promise.resolve(text), clock: { now: () => 0 } });
        manager.noteChanged(host, 'a.md', before); // the review sees the note as it left it
        manager.noteChanged(host, 'a.md', text); // then the user types
        let pre = 0;
        while (pre < Math.min(before.length, text.length) && before[pre] === text[pre]) pre++;
        let suf = 0;
        while (suf < Math.min(before.length, text.length) - pre && before[before.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
        const oldEnd = before.length - suf;
        const pending = p.hunks.filter((x) => x.status === 'pending');
        const moved = pending.map((h) => {
          const old = locateHunk(before, p, h.id)!;
          if (old.to <= pre && !(old.from === old.to && old.from === pre && oldEnd > pre)) return { h, at: old.from };
          if (old.from >= oldEnd) return { h, at: old.from + text.length - before.length };
          return { h, at: null };
        });
        fc.pre(pending.length > 0 && moved.every((m) => m.at !== null));
        const now = host.chat.proposals!.p as EditProposal;
        expect(manager.stale.has('p')).toBe(false);
        for (const m of moved) expect(locateHunk(text, now, m.h.id)?.from).toBe(m.at);
      }),
    );
  });

  it('B3: rebases by itself only when nothing would be dropped; otherwise reports stale hunks and leaves it be', () => {
    fc.assert(
      fc.property(world, ({ p, text }) => {
        const host = new Host();
        host.chat = { ...host.chat, proposals: { p } };
        const manager = new ReviewManager({ applier: noApplier, log: new EditLog(noStorage, id), readNote: () => Promise.resolve(text), clock: { now: () => 0 } });
        manager.noteChanged(host, 'a.md', text);
        const { stale } = staleness(text, p);
        const r = rebase(text, p);
        const now = host.chat.proposals!.p;
        if (!p.hunks.some((h) => h.status === 'pending') || rebaseExpect(text) === p.expect) {
          expect(now).toBe(p); // nothing changed outside the review
          expect(manager.stale.has('p')).toBe(false);
        } else if (r.dropped.length === 0) {
          expect(now).toEqual(r.proposal);
          expect(manager.stale.has('p')).toBe(false);
        } else {
          expect(now).toBe(p); // nothing dropped behind the user's back
          expect([...manager.stale.get('p')!]).toEqual(stale);
        }
      }),
    );
  });
});
