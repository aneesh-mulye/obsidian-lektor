// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md B6: undo and redo in the editor move the card with them. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EditLog } from '../../src/core/review/log';
import { ReviewManager } from '../../src/core/review/manager';
import { proposeEdit } from '../../src/core/review/proposals';
import type { EditApplier, EditProposal, HunkStatus, Splice } from '../../src/core/review/types';
import { Host, MODEL, MemStorage, text, word } from './review.fixtures';

/** One undo step: a change, or several CodeMirror grouped together. */
interface Step {
  before: string;
  after: string;
  /** The hunks accepted in this step. */
  accepts: string[];
}

/** Notes with a linear undo history per note, like CodeMirror's: each change is a step, and a new change discards what was undone. */
class EditorVault implements EditApplier {
  readonly notes = new Map<string, string>();
  readonly done = new Map<string, Step[]>();
  readonly undone = new Map<string, Step[]>();
  /** Set by the test for the next write: it joins the step before (CodeMirror groups quick, adjacent changes). */
  join = false;

  change(path: string, next: string): void {
    const before = this.notes.get(path)!;
    const done = this.done.get(path) ?? [];
    const last = done.at(-1);
    if (this.join && last) last.after = next;
    else done.push({ before, after: next, accepts: [] });
    this.join = false;
    this.done.set(path, done);
    this.undone.set(path, []);
    this.notes.set(path, next);
  }

  apply(path: string, locate: (text: string) => Splice | null) {
    const t = this.notes.get(path);
    if (t === undefined) return Promise.resolve('missing' as const);
    const s = locate(t);
    if (!s) return Promise.resolve('conflict' as const);
    this.change(path, t.slice(0, s.from) + s.insert + t.slice(s.to));
    return Promise.resolve('applied' as const);
  }
  create() {
    return Promise.reject(new Error('not in this test'));
  }
  trash() {
    return Promise.reject(new Error('not in this test'));
  }

  undo(path: string): Step | null {
    const s = this.done.get(path)?.pop();
    if (!s) return null;
    this.notes.set(path, s.before);
    this.undone.set(path, [...(this.undone.get(path) ?? []), s]);
    return s;
  }
  redo(path: string): Step | null {
    const s = this.undone.get(path)?.pop();
    if (!s) return null;
    this.notes.set(path, s.after);
    this.done.set(path, [...(this.done.get(path) ?? []), s]);
    return s;
  }
}

const PATHS = ['a.md', 'b.md'];
let n = 0;
const id = () => `u${++n}`;

const statuses = (host: Host): Map<string, HunkStatus> =>
  new Map(Object.values(host.chat.proposals ?? {}).flatMap((p) => (p.kind === 'edit' ? p.hunks.map((h) => [h.id, h.status] as const) : [])));

const edits = (t: string, picks: Array<[number, number, string[]]>) =>
  picks.map(([at, len, ws]) => {
    const s = at % Math.max(1, t.length);
    return { find: t.slice(s, s + len) || 'zz', replace: ws.join(' ') };
  });

/** The latest accept of a hunk, as the test saw it. */
interface Accept {
  path: string;
  before: string;
  after: string;
  /** Every text the review knew the note to have before this accept, this accept's own before-text included. */
  known: Set<string>;
  /** The texts right after this accept and after every later accept in the note (a redo of one brings back the undone ones before it). */
  afters: Set<string>;
}

interface World {
  vault: EditorVault;
  log: EditLog;
  manager: ReviewManager;
  hosts: Host[];
  open: number;
  /** Every text the review was told of, or produced by an accept, per note. */
  known: Map<string, string[]>;
  accepts: Map<string, Accept>;
  /** Texts reported while each chat was not open: what it may catch up on when it opens. */
  since: Map<string, string[]>;
  /** Typing steps not reported yet, per note. */
  unreported: Map<string, number>;
}

const host = (w: World) => w.hosts[w.open]!;

/** Every status change is one B6 allows, given the texts reported since the chat last looked. */
function verifyFlips(w: World, h: Host, before: Map<string, HunkStatus>, texts: readonly string[]): void {
  for (const [hid, now] of statuses(h)) {
    const was = before.get(hid);
    if (was === undefined || was === now) continue;
    const a = w.accepts.get(hid);
    if (was === 'accepted') {
      // Soundness: out only when the note is exactly as it was at some point before that accept.
      expect(now).toBe('pending');
      expect(a && texts.some((t) => a.known.has(t)), `${hid} undone with no text from before its accept`).toBe(true);
    } else if (now === 'accepted') {
      // Soundness: back only when the note is exactly as it was right after that accept, or a later one.
      expect(a && texts.some((t) => a.afters.has(t)), `${hid} redone with no text from right after an accept`).toBe(true);
    } else {
      // Decisions survive, and automatic rebases drop nothing (B3).
      expect.fail(`${hid} went from ${was} to ${now} without a click`);
    }
  }
}

/** The log matches the open chat's cards: accepts minus reverts is 1 for an accepted hunk and 0 otherwise. */
async function verifyLog(w: World): Promise<void> {
  await w.manager.settled();
  for (const path of PATHS) {
    const entries = await w.log.entries(path);
    const hunkOf = new Map(entries.filter((e) => e.kind === 'hunk').map((e) => [e.id, e.hunkId]));
    const net = new Map<string, number>();
    for (const e of entries) {
      const hid = e.kind === 'hunk' ? e.hunkId : e.kind === 'revert' ? hunkOf.get(e.revertOf ?? '') : undefined;
      if (hid !== undefined) net.set(hid, (net.get(hid) ?? 0) + (e.kind === 'hunk' ? 1 : -1));
    }
    for (const p of Object.values(host(w).chat.proposals ?? {})) {
      if (p.kind !== 'edit' || p.path !== path) continue;
      for (const hk of p.hunks) expect(net.get(hk.id) ?? 0, `log for ${hk.id} (${hk.status})`).toBe(hk.status === 'accepted' ? 1 : 0);
    }
  }
}

/** The editor tells the review the note's text (each undo and redo step at once; typing once it settles). */
async function report(w: World, path: string): Promise<void> {
  const t = w.vault.notes.get(path)!;
  const h = host(w);
  const before = statuses(h);
  w.manager.noteChanged(h, path, t);
  w.known.get(path)!.push(t);
  for (const other of w.hosts) if (other !== h) w.since.get(other.chat.id)!.push(t);
  w.unreported.set(path, 0);
  verifyFlips(w, h, before, [t]);
  await verifyLog(w);
}

function recordAccepts(w: World, path: string, hunks: readonly string[], steps: readonly Step[]): void {
  hunks.forEach((hid, i) => {
    const step = steps[i]!;
    const known = new Set([...w.known.get(path)!, step.before]);
    for (const a of w.accepts.values()) if (a.path === path) a.afters.add(step.after);
    w.accepts.set(hid, { path, before: step.before, after: step.after, known, afters: new Set([step.after]) });
    w.known.get(path)!.push(step.before, step.after);
  });
}

/** Accept one hunk, as a click on ✓ would, and note what it did. */
async function accept(w: World, p: EditProposal, hid: string, join = false): Promise<'applied' | 'other'> {
  const t = w.vault.notes.get(p.path)!;
  const prev = w.accepts.get(hid);
  // CodeMirror may group an accept with the typing just before it (one step the review never saw).
  w.vault.join = join && w.unreported.get(p.path) === 1;
  const before = statuses(host(w));
  const outcome = await w.manager.acceptHunk(host(w), p.id, hid);
  w.vault.join = false;
  if (outcome !== 'applied') return 'other';
  const step = w.vault.done.get(p.path)!.at(-1)!;
  step.accepts.push(hid);
  w.unreported.set(p.path, 0);
  recordAccepts(w, p.path, [hid], [{ ...step, before: t }]);
  // Exactness: a hunk that went back to pending, accepted again from the same text, writes what it wrote first.
  if (prev && before.get(hid) === 'pending' && t === prev.before) expect(w.vault.notes.get(p.path)).toBe(prev.after);
  await verifyLog(w);
  return 'applied';
}

type Cmd = fc.AsyncCommand<World, World>;
const cmd = (name: string, run: (w: World) => Promise<void>): Cmd => ({ check: () => true, run: (_m, w) => run(w), toString: () => name });
const editsIn = (w: World): EditProposal[] => Object.values(host(w).chat.proposals ?? {}).filter((p): p is EditProposal => p.kind === 'edit');

const acceptCmd = fc.tuple(fc.nat(), fc.nat(), fc.boolean()).map(([pi, hi, join]) =>
  cmd(`accept(${pi}, ${hi}${join ? ', joined' : ''})`, async (w) => {
    const ps = editsIn(w);
    const p = ps[pi % Math.max(1, ps.length)];
    if (!p) return;
    await accept(w, p, p.hunks[hi % p.hunks.length]!.id, join);
  }),
);
const undoCmd = fc.nat().map((pi) =>
  cmd(`undo(${pi})`, async (w) => {
    const path = PATHS[pi % PATHS.length]!;
    if (w.vault.undo(path)) await report(w, path);
  }),
);
const redoCmd = fc.nat().map((pi) =>
  cmd(`redo(${pi})`, async (w) => {
    const path = PATHS[pi % PATHS.length]!;
    if (w.vault.redo(path)) await report(w, path);
  }),
);

// Accepts, undo and redo are listed twice: they are what this test is about.
const commands = fc.commands(
  [
    acceptCmd,
    acceptCmd,
    undoCmd,
    undoCmd,
    redoCmd,
    redoCmd,
    fc.tuple(fc.nat(), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 2, max: 30 }), fc.array(word, { maxLength: 4 })), { minLength: 1, maxLength: 3 })).map(([pi, picks]) =>
      cmd(`propose(${pi})`, async (w) => {
        const path = PATHS[pi % PATHS.length]!;
        const t = w.vault.notes.get(path)!;
        const v = proposeEdit({ path, edits: edits(t, picks) }, { text: t, id: id(), hunkId: id, createdAt: 0, model: MODEL });
        if (v.ok) host(w).add(v.proposal);
        await Promise.resolve();
      }),
    ),
    fc.nat().map((pi) =>
      cmd(`acceptAll(${pi})`, async (w) => {
        const p = editsIn(w)[pi % Math.max(1, editsIn(w).length)];
        if (!p) return;
        const order = p.hunks.filter((h) => h.status === 'pending').map((h) => h.id);
        const steps = w.vault.done.get(p.path)?.length ?? 0;
        await w.manager.acceptAll(host(w), p.id);
        const now = statuses(host(w));
        const accepted = order.filter((hid) => now.get(hid) === 'accepted');
        const added = (w.vault.done.get(p.path) ?? []).slice(steps);
        expect(added).toHaveLength(accepted.length);
        added.forEach((s, i) => s.accepts.push(accepted[i]!));
        if (accepted.length > 0) w.unreported.set(p.path, 0);
        recordAccepts(w, p.path, accepted, added);
        await verifyLog(w);
      }),
    ),
    fc.tuple(fc.nat(), fc.nat()).map(([pi, hi]) =>
      cmd(`reject(${pi}, ${hi})`, async (w) => {
        const p = editsIn(w)[pi % Math.max(1, editsIn(w).length)];
        if (p) w.manager.rejectHunk(host(w), p.id, p.hunks[hi % p.hunks.length]!.id);
        await verifyLog(w);
      }),
    ),
    fc.tuple(fc.nat(), fc.nat(), fc.nat({ max: 6 }), fc.oneof(word, fc.constant(''))).map(([pi, at, del, ins]) =>
      cmd(`type(${pi}, ${at}, -${del}, "${ins}")`, async (w) => {
        const path = PATHS[pi % PATHS.length]!;
        const t = w.vault.notes.get(path)!;
        const s = at % (t.length + 1);
        const next = t.slice(0, s) + ins + t.slice(s + del);
        if (next === t) return;
        w.vault.change(path, next);
        w.unreported.set(path, (w.unreported.get(path) ?? 0) + 1);
        await Promise.resolve();
      }),
    ),
    fc.nat().map((pi) => cmd(`report(${pi})`, (w) => report(w, PATHS[pi % PATHS.length]!))),
    fc.nat().map((k) =>
      cmd(`open(chat${k % 2})`, async (w) => {
        const h = w.hosts[k % 2]!;
        if (h === host(w)) return;
        const before = statuses(h);
        w.open = k % 2;
        w.manager.sync(h);
        verifyFlips(w, h, before, w.since.get(h.chat.id)!);
        w.since.set(h.chat.id, []);
        await verifyLog(w);
      }),
    ),
  ],
  { maxCommands: 60, size: 'large' },
);

function world(texts: readonly string[]): World {
  const vault = new EditorVault();
  texts.forEach((t, i) => vault.notes.set(PATHS[i]!, t));
  const log = new EditLog(new MemStorage(), id);
  const manager = new ReviewManager({ applier: vault, log, readNote: (p) => Promise.resolve(vault.notes.get(p)!), clock: { now: () => 0 } });
  const hosts = [new Host('chat0'), new Host('chat1')];
  return {
    vault, log, manager, hosts, open: 0,
    known: new Map(texts.map((t, i) => [PATHS[i]!, [t]])),
    accepts: new Map(),
    since: new Map(hosts.map((h) => [h.chat.id, []])),
    unreported: new Map(),
  };
}

describe('undo and redo follow the note (INVARIANTS.md B6)', () => {
  it('B6: cards change only to what the note’s text shows, decisions survive, and the log matches the cards', async () => {
    await fc.assert(
      fc.asyncProperty(fc.tuple(text, text), commands, async (texts, cmds) => {
        const w = world(texts);
        // Both chats know the notes as they start, as when the editor opens them.
        for (const path of PATHS) await report(w, path);
        await fc.asyncModelRun(() => ({ model: w, real: w }), cmds);
      }),
    );
  });

  it('B6: undoing k steps makes exactly their accepts pending again, and redoing j of them makes exactly those accepted', async () => {
    const unit = fc.record({ type: fc.boolean(), reported: fc.boolean(), join: fc.boolean(), hunk: fc.nat() });
    await fc.assert(
      fc.asyncProperty(
        text,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 2, max: 30 }), fc.array(word, { maxLength: 4 })), { minLength: 1, maxLength: 4 }),
        fc.array(unit, { minLength: 1, maxLength: 6 }),
        fc.nat(),
        fc.nat(),
        async (t, picks, units, k0, j0) => {
          const w = world([t, 'unused']);
          const v = proposeEdit({ path: 'a.md', edits: edits(t, picks) }, { text: t, id: id(), hunkId: id, createdAt: 0, model: MODEL });
          fc.pre(v.ok);
          if (!v.ok) return;
          host(w).add(v.proposal);
          await report(w, 'a.md');
          let mark = 0;
          for (const u of units) {
            // Typing that can't recreate an earlier text: a fresh marker at the start of the note.
            if (u.type) {
              w.vault.change('a.md', `§${++mark} ${w.vault.notes.get('a.md')!}`);
              w.unreported.set('a.md', (w.unreported.get('a.md') ?? 0) + 1);
              if (u.reported) await report(w, 'a.md');
            }
            const pending = (host(w).chat.proposals![v.proposal.id] as EditProposal).hunks.filter((h) => h.status === 'pending');
            if (pending.length === 0) continue;
            await accept(w, host(w).chat.proposals![v.proposal.id] as EditProposal, pending[u.hunk % pending.length]!.id, u.join);
          }
          const status = (hid: string) => statuses(host(w)).get(hid);
          const steps = [...(w.vault.done.get('a.md') ?? [])];
          const k = k0 % (steps.length + 1);
          const undone: Step[] = [];
          for (let i = 0; i < k; i++) {
            undone.push(w.vault.undo('a.md')!);
            await report(w, 'a.md');
          }
          for (const s of steps) for (const hid of s.accepts) expect(status(hid), `after ${k} undos`).toBe(undone.includes(s) ? 'pending' : 'accepted');
          const j = j0 % (k + 1);
          for (let i = 0; i < j; i++) {
            w.vault.redo('a.md');
            await report(w, 'a.md');
          }
          const stillUndone = new Set(undone.slice(0, k - j));
          for (const s of steps) for (const hid of s.accepts) expect(status(hid), `after ${k} undos and ${j} redos`).toBe(stillUndone.has(s) ? 'pending' : 'accepted');
        },
      ),
    );
  });

  it('B6: Ctrl+Z after Accept takes the card back to pending, Ctrl+Shift+Z accepts it again, and the history says so', async () => {
    const w = world(['The the lighthouse keepers lived their for months.', '']);
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'The the lighthouse', replace: 'The lighthouse' }] }, { text: w.vault.notes.get('a.md')!, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host(w).add(v.proposal);
    await report(w, 'a.md');
    const [h] = v.proposal.hunks;
    expect(await accept(w, v.proposal, h!.id)).toBe('applied');
    expect(w.vault.notes.get('a.md')).toBe('The lighthouse keepers lived their for months.');

    w.vault.undo('a.md');
    await report(w, 'a.md');
    expect(statuses(host(w)).get(h!.id)).toBe('pending');
    w.vault.redo('a.md');
    await report(w, 'a.md');
    expect(statuses(host(w)).get(h!.id)).toBe('accepted');
    w.vault.undo('a.md');
    await report(w, 'a.md');
    // Accepting again from the card writes the same change.
    expect(await accept(w, host(w).chat.proposals!.p as EditProposal, h!.id)).toBe('applied');
    expect(w.vault.notes.get('a.md')).toBe('The lighthouse keepers lived their for months.');
    await w.manager.settled();
    expect((await w.log.entries('a.md')).map((e) => `${e.kind}${e.via ? `:${e.via}` : ''}`)).toEqual(['hunk', 'revert:undo', 'hunk:redo', 'revert:undo', 'hunk']);
  });

  it('B6: a revert from the AI history that restores the text exactly is not logged twice', async () => {
    const w = world(['Intro. The keepers lived their for months.', '']);
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'lived their for', replace: 'lived there for' }] }, { text: w.vault.notes.get('a.md')!, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host(w).add(v.proposal);
    await report(w, 'a.md');
    await accept(w, v.proposal, v.proposal.hunks[0]!.id);
    const [entry] = await w.log.entries('a.md');
    expect(await w.manager.revert('a.md', entry!.id)).toBe('reverted');
    await report(w, 'a.md'); // the editor reports the revert's change
    expect(statuses(host(w)).get(v.proposal.hunks[0]!.id)).toBe('pending');
    expect((await w.log.entries('a.md')).map((e) => e.kind)).toEqual(['hunk', 'revert']);
  });

  /** A note with two proposals, one hunk each, both accepted: the texts before, between and after. */
  async function twoAccepts() {
    const w = world(['the cat sat on the mat. the keeper lit the light. ', '']);
    const t0 = w.vault.notes.get('a.md')!;
    const p1 = proposeEdit({ path: 'a.md', edits: [{ find: 'cat sat', replace: 'dog sat' }] }, { text: t0, id: 'p1', hunkId: id, createdAt: 0, model: MODEL });
    const p2 = proposeEdit({ path: 'a.md', edits: [{ find: 'lit the', replace: 'lit up the' }] }, { text: t0, id: 'p2', hunkId: id, createdAt: 0, model: MODEL });
    if (!p1.ok || !p2.ok) throw new Error('bad proposals');
    host(w).add(p1.proposal);
    host(w).add(p2.proposal);
    await report(w, 'a.md');
    await accept(w, p1.proposal, p1.proposal.hunks[0]!.id);
    const t1 = w.vault.notes.get('a.md')!;
    // The user types in between, and the editor reports it.
    w.vault.change('a.md', `${t1}More. `);
    await report(w, 'a.md');
    const t2 = w.vault.notes.get('a.md')!;
    await accept(w, host(w).chat.proposals!.p2 as EditProposal, p2.proposal.hunks[0]!.id);
    const t3 = w.vault.notes.get('a.md')!;
    const h1 = p1.proposal.hunks[0]!.id;
    const h2 = p2.proposal.hunks[0]!.id;
    return { w, t0, t1, t2, t3, h1, h2 };
  }

  /** The note is restored in one go (from a backup, a sync, git), skipping the steps in between: as a closed note's change on disk is reported. */
  async function restoreOnDisk(w: World, text: string) {
    w.vault.change('a.md', text);
    await report(w, 'a.md');
  }

  it('B6: a note restored to the text before both accepts takes both out; restored to right after both, both are back', async () => {
    const { w, t0, t3, h1, h2 } = await twoAccepts();
    await restoreOnDisk(w, t0);
    expect([statuses(host(w)).get(h1), statuses(host(w)).get(h2)]).toEqual(['pending', 'pending']);
    await restoreOnDisk(w, t3);
    expect([statuses(host(w)).get(h1), statuses(host(w)).get(h2)]).toEqual(['accepted', 'accepted']);
  });

  it('B6: a note restored to the text right after an earlier accept takes the later one out, and keeps the earlier', async () => {
    const { w, t1, h1, h2 } = await twoAccepts();
    await restoreOnDisk(w, t1);
    expect([statuses(host(w)).get(h1), statuses(host(w)).get(h2)]).toEqual(['accepted', 'pending']);
  });

  it('B6: an accept undone before another accept is not brought back by redoing that other one', async () => {
    const w = world(['the cat sat on the mat. the keeper lit the light. ', '']);
    const t0 = w.vault.notes.get('a.md')!;
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'cat sat', replace: 'dog sat' }, { find: 'lit the', replace: 'lit up the' }] }, { text: t0, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host(w).add(v.proposal);
    await report(w, 'a.md');
    const [h1, h2] = v.proposal.hunks.map((h) => h.id);
    await accept(w, v.proposal, h1!);
    w.vault.undo('a.md');
    await report(w, 'a.md');
    await accept(w, host(w).chat.proposals!.p as EditProposal, h2!); // a new change: the first can no longer be redone
    w.vault.undo('a.md');
    await report(w, 'a.md');
    w.vault.redo('a.md');
    await report(w, 'a.md');
    expect([statuses(host(w)).get(h1!), statuses(host(w)).get(h2!)]).toEqual(['pending', 'accepted']);
  });

  it('B6: the same holds when the undone accept is in a chat that is not open', async () => {
    const w = world(['the cat sat on the mat. the keeper lit the light. ', '']);
    const t0 = w.vault.notes.get('a.md')!;
    const v1 = proposeEdit({ path: 'a.md', edits: [{ find: 'cat sat', replace: 'dog sat' }] }, { text: t0, id: 'p1', hunkId: id, createdAt: 0, model: MODEL });
    const v2 = proposeEdit({ path: 'a.md', edits: [{ find: 'lit the', replace: 'lit up the' }] }, { text: t0, id: 'p2', hunkId: id, createdAt: 0, model: MODEL });
    if (!v1.ok || !v2.ok) throw new Error('bad proposals');
    w.hosts[0]!.add(v1.proposal);
    w.hosts[1]!.add(v2.proposal);
    await report(w, 'a.md');
    await accept(w, v1.proposal, v1.proposal.hunks[0]!.id); // in chat 0
    w.open = 1;
    w.manager.sync(w.hosts[1]!);
    w.vault.undo('a.md'); // Ctrl+Z, with chat 1 open
    await report(w, 'a.md');
    await accept(w, v2.proposal, v2.proposal.hunks[0]!.id); // a new change in chat 1
    w.vault.undo('a.md');
    await report(w, 'a.md');
    w.vault.redo('a.md');
    await report(w, 'a.md');
    w.open = 0;
    w.manager.sync(w.hosts[0]!);
    expect(statuses(w.hosts[0]!).get(v1.proposal.hunks[0]!.id)).toBe('pending');
    expect(statuses(w.hosts[1]!).get(v2.proposal.hunks[0]!.id)).toBe('accepted');
  });

  // Regression (B6 seed 757111334, a mistake in the test's model): two runs of typing the review never saw, then an
  // accept CodeMirror grouped with the second. Undo lands on text the review never knew, so the card can't follow:
  // the known limit in INVARIANTS.md B6. It stays as it was, and nothing is written or logged.
  it('B6: an undo onto text the review never saw leaves the card as it was', async () => {
    const w = world(['the cat sat on the mat. ', '']);
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'cat sat', replace: 'dog sat' }] }, { text: w.vault.notes.get('a.md')!, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host(w).add(v.proposal);
    await report(w, 'a.md');
    w.vault.change('a.md', `§1 ${w.vault.notes.get('a.md')!}`);
    w.vault.change('a.md', `§2 ${w.vault.notes.get('a.md')!}`);
    w.vault.join = true; // grouped with the second typing
    expect(await w.manager.acceptHunk(host(w), 'p', v.proposal.hunks[0]!.id)).toBe('applied');
    w.vault.join = false;
    w.vault.undo('a.md');
    const notes = new Map(w.vault.notes);
    w.manager.noteChanged(host(w), 'a.md', w.vault.notes.get('a.md')!);
    await w.manager.settled();
    expect(statuses(host(w)).get(v.proposal.hunks[0]!.id)).toBe('accepted');
    expect(w.vault.notes).toEqual(notes);
    expect((await w.log.entries('a.md')).map((e) => e.kind)).toEqual(['hunk']);
  });

  it('B6: undo after a rename keeps the proposal under the new name', async () => {
    const w = world(['the cat sat on the mat. ', '']);
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'cat sat', replace: 'dog sat' }] }, { text: w.vault.notes.get('a.md')!, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host(w).add(v.proposal);
    await report(w, 'a.md');
    await accept(w, v.proposal, v.proposal.hunks[0]!.id);
    const before = w.vault.done.get('a.md')!.at(-1)!.before;
    w.manager.renamed(host(w), 'a.md', 'Moved/a.md');
    w.manager.noteChanged(host(w), 'Moved/a.md', before); // Ctrl+Z in the renamed note
    const p = host(w).chat.proposals!.p as EditProposal;
    expect(p.hunks[0]!.status).toBe('pending');
    expect(p.path).toBe('Moved/a.md');
  });

  it('B6: a chat that was not open catches up when it opens, and following never writes', async () => {
    const w = world(['the cat sat on the mat. ', '']);
    const v = proposeEdit({ path: 'a.md', edits: [{ find: 'cat sat', replace: 'dog sat' }] }, { text: w.vault.notes.get('a.md')!, id: 'p', hunkId: id, createdAt: 0, model: MODEL });
    if (!v.ok) throw new Error(v.error);
    host(w).add(v.proposal);
    await report(w, 'a.md');
    await accept(w, v.proposal, v.proposal.hunks[0]!.id);
    w.open = 1; // the user switches chats, then presses Ctrl+Z in the note
    const text = w.vault.notes.get('a.md');
    w.vault.undo('a.md');
    await report(w, 'a.md');
    expect(statuses(w.hosts[0]!).get(v.proposal.hunks[0]!.id)).toBe('accepted'); // not open: not yet
    const notes = new Map(w.vault.notes);
    w.open = 0;
    w.manager.sync(w.hosts[0]!);
    expect(statuses(w.hosts[0]!).get(v.proposal.hunks[0]!.id)).toBe('pending');
    expect(w.vault.notes).toEqual(notes);
    expect(text).not.toBe(w.vault.notes.get('a.md'));
  });
});
