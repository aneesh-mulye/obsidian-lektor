// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Accept, reject, create and revert: the only code that asks the EditApplier
 * to change the vault, and every public method that writes is a user's click
 * (hard rule 1; INVARIANTS.md W3–W6). Changes run one at a time.
 *
 * It also follows the note's own undo and redo (INVARIANTS.md B6): when the
 * note is back to exactly the text it had before an accept, that hunk is
 * pending again; when it is back to exactly the text right after, it is
 * accepted again. That changes only cards and the log, never the vault.
 */

import type { Chat, Clock } from '../chat/types';
import type { EditLog, LogEntry } from './log';
import { fingerprint } from './fingerprint';
import { editTextNow, locateHunk } from './proposals';
import { type RebaseResult, rebase, staleness } from './rebase';
import type { EditApplier, EditProposal, HunkRecord, NoteProposal, Proposal, Splice } from './types';

/** Where a proposal lives: the chat session that made it. */
export interface ProposalHost {
  readonly chat: Chat;
  updateProposal(id: string, fn: (p: Proposal) => Proposal): void;
}

export type AcceptOutcome = 'applied' | 'conflict' | 'missing' | 'done';
export type RevertOutcome = 'reverted' | 'conflict' | 'missing' | 'already';

/** Characters kept on each side of a change, to find it again for a revert. */
const CONTEXT = 40;

/** An accept the review follows through the note's undo and redo. In memory only. */
interface Followed {
  readonly chatId: string;
  readonly proposalId: string;
  readonly hunkId: string;
  /** Fingerprints of texts the note had before the accept: just before it, and the last text the review knew before that. */
  readonly before: readonly string[];
  /** Fingerprint of the text just after it. */
  readonly after: string;
  /** The proposal just before and just after the accept. */
  readonly prior: EditProposal;
  readonly next: EditProposal;
  /** Its latest log entry (the accept, or the redo since). */
  entry: LogEntry | null;
  /** Whether the note has the change, as far as its text shows. */
  inNote: boolean;
  /** Whether its chat's card says so yet (a chat that isn't open catches up when it opens). */
  shown: boolean;
  /** Undone, and the text right after it can still come back. False once something else is accepted without it. */
  redoable: boolean;
}

/** How many accepts are followed per note; older ones are forgotten. */
const FOLLOWED_MAX = 100;

/**
 * `snapshot` (the proposal just before or after an accept), with the user's later decisions on its
 * other hunks kept: a hunk rejected or dropped since stays so.
 */
function restore(snapshot: EditProposal, current: EditProposal, hunkId: string): EditProposal {
  const now = new Map(current.hunks.map((h) => [h.id, h]));
  return {
    ...snapshot,
    path: current.path,
    hunks: snapshot.hunks.map((h): HunkRecord => {
      const c = now.get(h.id);
      if (h.id === hunkId || h.status !== 'pending' || !c || c.status === 'pending') return h;
      return { ...h, status: c.status, ...(c.dropReason !== undefined ? { dropReason: c.dropReason } : {}) };
    }),
  };
}

export class ReviewManager {
  #queue: Promise<unknown> = Promise.resolve();
  /** Why a hunk or note card could not be applied, until it is tried again (shown on the card). */
  readonly problems = new Map<string, string>();
  /** Stale pending hunks, by proposal, that an automatic rebase could not keep (the amber dot). */
  readonly stale = new Map<string, readonly string[]>();
  /**
   * The text each note had when the review last saw it, so a rebase can carry positions through
   * the user's change exactly. In memory only; never stored.
   */
  readonly #seen = new Map<string, string>();
  /** Accepts followed through undo and redo, per note, oldest first. */
  readonly #followed = new Map<string, Followed[]>();
  /** The fingerprint of the last text the review knew each note to have. */
  readonly #last = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(
    private readonly deps: {
      applier: EditApplier;
      log: EditLog;
      /** The note's current text (through ContextBroker). */
      readNote: (path: string) => Promise<string>;
      /** The note's text in an open editor, if any (it may be ahead of the disk). */
      editorText?: (path: string) => string | null;
      clock: Clock;
    },
  ) {}

  readonly subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  readonly version = (): number => this.#version;

  private changed(): void {
    this.#version += 1;
    for (const l of this.#listeners) l();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  private edit(host: ProposalHost, id: string): EditProposal | null {
    const p = host.chat.proposals?.[id];
    return p?.kind === 'edit' ? p : null;
  }

  /** Accept one hunk (a click on ✓). */
  acceptHunk(host: ProposalHost, proposalId: string, hunkId: string): Promise<AcceptOutcome> {
    return this.serial(async () => {
      const p = this.edit(host, proposalId);
      const hunk = p?.hunks.find((h) => h.id === hunkId);
      if (!p || !hunk || hunk.status !== 'pending') return 'done';
      let splice: Splice | null = null;
      let context = { before: '', after: '' };
      let expect = p.expect;
      let states: { before: string; after: string } | null = null;
      const result = await this.deps.applier.apply(p.path, (text) => {
        splice = locateHunk(text, p, hunkId);
        if (splice) {
          context = { before: text.slice(Math.max(0, splice.from - CONTEXT), splice.from), after: text.slice(splice.to, splice.to + CONTEXT) };
          const next = text.slice(0, splice.from) + splice.insert + text.slice(splice.to);
          states = { before: fingerprint(text), after: fingerprint(next) };
          // Only if the note was as this review left it does it stay "as expected" afterwards.
          if (states.before === p.expect) {
            expect = states.after;
            this.#seen.set(p.path, next);
          }
        }
        return splice;
      });
      if (result === 'applied' && splice !== null && states !== null) {
        const s: Splice = splice;
        const fp: { before: string; after: string } = states;
        host.updateProposal(proposalId, (q) =>
          q.kind !== 'edit' ? q : { ...q, expect, hunks: q.hunks.map((h) => (h.id === hunkId ? { ...h, status: 'accepted' } : h)) },
        );
        this.problems.delete(hunkId);
        const next = this.edit(host, proposalId);
        const followed = next ? this.#follow(p.path, { chatId: host.chat.id, proposalId, hunkId, before: fp.before, after: fp.after, prior: p, next }) : null;
        const entry = await this.deps.log.append(p.path, {
          kind: 'hunk',
          before: p.edits[hunk.edit]!.find.slice(hunk.start, hunk.end),
          after: s.insert,
          contextBefore: context.before,
          contextAfter: context.after,
          at: this.deps.clock.now(),
          chatId: host.chat.id,
          model: p.model,
          proposalId,
          hunkId,
        });
        if (followed) followed.entry = entry;
      } else {
        this.problems.set(hunkId, result === 'missing' ? `${p.path} no longer exists.` : 'The note has changed here since this was proposed, so this change no longer fits.');
      }
      this.changed();
      return result;
    });
  }

  /** Reject one hunk (a click on ✕). Never writes. */
  rejectHunk(host: ProposalHost, proposalId: string, hunkId: string): void {
    host.updateProposal(proposalId, (q) =>
      q.kind !== 'edit' ? q : { ...q, hunks: q.hunks.map((h) => (h.id === hunkId && h.status === 'pending' ? { ...h, status: 'rejected' } : h)) },
    );
    this.problems.delete(hunkId);
    this.changed();
  }

  /** Accept every pending hunk, in order; returns how many could not be applied. */
  async acceptAll(host: ProposalHost, proposalId: string): Promise<{ applied: number; failed: number }> {
    const p = this.edit(host, proposalId);
    let applied = 0;
    let failed = 0;
    for (const h of p?.hunks.filter((x) => x.status === 'pending') ?? []) {
      const r = await this.acceptHunk(host, proposalId, h.id);
      if (r === 'applied') applied += 1;
      else if (r !== 'done') failed += 1;
    }
    return { applied, failed };
  }

  rejectAll(host: ProposalHost, proposalId: string): void {
    host.updateProposal(proposalId, (q) => (q.kind !== 'edit' ? q : { ...q, hunks: q.hunks.map((h) => (h.status === 'pending' ? { ...h, status: 'rejected' } : h)) }));
    this.changed();
  }

  /**
   * A note's text changed (typing in the editor, or on disk). Check the proposals for it in this
   * chat: rebase by itself only when nothing would be dropped (INVARIANTS.md B3); otherwise
   * leave the proposal as it is and report its stale hunks.
   */
  noteChanged(host: ProposalHost, path: string, text: string): void {
    const previous = this.#seen.get(path);
    this.#seen.set(path, text);
    this.#track(path, text);
    let changed = this.#sync(host);
    for (const p of Object.values(host.chat.proposals ?? {})) {
      if (p.kind !== 'edit' || p.path !== path || !p.hunks.some((h) => h.status === 'pending')) continue;
      if (fingerprint(text) === p.expect) {
        if (this.stale.delete(p.id)) changed = true;
        continue;
      }
      const { stale } = staleness(text, p);
      const result = rebase(text, p, previous);
      if (result.dropped.length === 0) {
        host.updateProposal(p.id, () => result.proposal);
        this.stale.delete(p.id);
      } else {
        this.stale.set(p.id, stale);
      }
      changed = true;
    }
    if (changed) this.changed();
  }

  /** A note or folder was renamed: the open chat's proposals for it follow it. */
  renamed(host: ProposalHost, from: string, to: string): void {
    const moved = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null);
    for (const map of [this.#seen, this.#last, this.#followed] as Map<string, unknown>[]) {
      for (const [path, value] of [...map]) {
        const m = moved(path);
        if (m === null) continue;
        map.delete(path);
        map.set(m, value);
      }
    }
    let changed = false;
    for (const p of Object.values(host.chat.proposals ?? {})) {
      const m = moved(p.path);
      if (m === null) continue;
      host.updateProposal(p.id, (q) => ({ ...q, path: m }));
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Rebase now (a click on Rebase): keep what can be re-anchored, drop the rest, and say why. */
  rebaseNow(host: ProposalHost, proposalId: string): Promise<RebaseResult | null> {
    return this.serial(async () => {
      const p = this.edit(host, proposalId);
      if (!p) return null;
      let text = this.deps.editorText?.(p.path) ?? null;
      if (text === null) {
        try {
          text = await this.deps.readNote(p.path);
        } catch {
          const dropped = p.hunks.filter((h) => h.status === 'pending').map((h) => ({ hunkId: h.id, reason: 'the note no longer exists' }));
          const reasons = new Map(dropped.map((d) => [d.hunkId, d.reason]));
          const proposal: EditProposal = { ...p, hunks: p.hunks.map((h) => (reasons.has(h.id) ? { ...h, status: 'dropped', dropReason: reasons.get(h.id)! } : h)) };
          host.updateProposal(proposalId, () => proposal);
          this.stale.delete(proposalId);
          this.changed();
          return { proposal, kept: [], dropped };
        }
      }
      const result = rebase(text, p, this.#seen.get(p.path));
      this.#seen.set(p.path, text);
      host.updateProposal(proposalId, () => result.proposal);
      this.stale.delete(proposalId);
      for (const d of result.dropped) this.problems.delete(d.hunkId);
      this.changed();
      return result;
    });
  }

  /** Discard a proposal's remaining hunks (a click on Discard). Never writes. */
  discard(host: ProposalHost, proposalId: string): void {
    this.stale.delete(proposalId);
    this.rejectAll(host, proposalId);
  }

  /** Create a proposed note (a click on Create). */
  createNote(host: ProposalHost, proposalId: string): Promise<'created' | 'exists' | 'done'> {
    return this.serial(async () => {
      const p = host.chat.proposals?.[proposalId];
      if (p?.kind !== 'note' || p.status !== 'pending') return 'done';
      const result = await this.deps.applier.create(p.path, p.content);
      if (result === 'created') {
        host.updateProposal(proposalId, (q): Proposal => (q.kind === 'note' ? ({ ...q, status: 'created' } satisfies NoteProposal) : q));
        this.problems.delete(proposalId);
        await this.deps.log.append(p.path, {
          kind: 'create', before: '', after: p.content, contextBefore: '', contextAfter: '',
          at: this.deps.clock.now(), chatId: host.chat.id, model: p.model, proposalId,
        });
      } else {
        this.problems.set(proposalId, `A note already exists at ${p.path}.`);
      }
      this.changed();
      return result;
    });
  }

  dismissNote(host: ProposalHost, proposalId: string): void {
    host.updateProposal(proposalId, (q): Proposal => (q.kind === 'note' && q.status === 'pending' ? { ...q, status: 'dismissed' } : q));
    this.changed();
  }

  /** Whether the review follows accepts in this note through undo and redo (so changes on disk matter). */
  tracks(path: string): boolean {
    return (this.#followed.get(path)?.length ?? 0) > 0;
  }

  /** A chat was opened: its cards catch up with undo and redo that happened while it wasn't. Never writes. */
  sync(host: ProposalHost): void {
    if (this.#sync(host)) this.changed();
  }

  /** Resolves once every queued change and log entry so far is done. */
  settled(): Promise<void> {
    return this.#queue.then(() => undefined);
  }

  /** Start following a new accept: anything undone before it can no longer be redone. */
  #follow(path: string, r: Omit<Followed, 'before' | 'entry' | 'inNote' | 'shown' | 'redoable'> & { before: string }): Followed {
    const last = this.#last.get(path);
    const list = (this.#followed.get(path) ?? []).filter((f) => f.inNote || f.shown);
    for (const f of list) if (!f.inNote) f.redoable = false;
    const followed: Followed = { ...r, before: last !== undefined && last !== r.before ? [r.before, last] : [r.before], entry: null, inNote: true, shown: true, redoable: false };
    list.push(followed);
    this.#followed.set(path, list.slice(-FOLLOWED_MAX));
    this.#last.set(path, r.after);
    return followed;
  }

  /** The note's text is now `text`: which followed accepts does it still have? */
  #track(path: string, text: string): void {
    const fp = fingerprint(text);
    this.#last.set(path, fp);
    const list = this.#followed.get(path);
    if (!list) return;
    // Undo: back to a text the note had before an accept it still has. That accept, and every later one, are out.
    // The texts known from before it: those before each accept up to it, and those right after the earlier ones it still has.
    const undo = (from: number, to: number) => {
      for (const u of list.slice(from, to + 1)) {
        if (!u.inNote) continue;
        u.inNote = false;
        u.redoable = true;
        this.#log(path, u, 'undo');
      }
    };
    const latest = list.findLastIndex((r) => r.inNote);
    for (let i = latest; i >= 0; i--) {
      const r = list[i]!;
      if (r.inNote && r.after === fp) return undo(i + 1, latest); // right after this one: the later ones are out
      if (r.before.includes(fp)) return undo(i, latest);
    }
    // Redo: back to the text right after an undone accept. It, and the undone ones before it, are back.
    for (let j = 0; j < list.length; j++) {
      const r = list[j]!;
      if (r.inNote || !r.redoable || r.after !== fp) continue;
      for (const u of list.slice(0, j + 1)) {
        if (u.inNote || !u.redoable) continue;
        u.inNote = true;
        this.#log(path, u, 'redo');
      }
      return;
    }
  }

  /** Bring the chat's cards up to date with what the note has. Never writes. */
  #sync(host: ProposalHost): boolean {
    let changed = false;
    for (const [path, list] of this.#followed) {
      const mine = list.filter((r) => r.chatId === host.chat.id && r.shown !== r.inNote);
      // Latest undo first and earliest redo first, so each snapshot builds on the one before.
      for (const r of [...mine.filter((x) => !x.inNote).reverse(), ...mine.filter((x) => x.inNote)]) {
        r.shown = r.inNote;
        this.problems.delete(r.hunkId);
        host.updateProposal(r.proposalId, (q) => {
          if (q.kind !== 'edit') return q;
          const own = q.hunks.find((h) => h.id === r.hunkId);
          if (!own || (own.status === 'accepted') === r.inNote) return q;
          return restore(r.inNote ? r.next : r.prior, q, r.hunkId);
        });
        changed = true;
      }
      const kept = list.filter((r) => r.inNote || r.shown || r.redoable);
      if (kept.length === 0) this.#followed.delete(path);
      else if (kept.length !== list.length) this.#followed.set(path, kept);
    }
    return changed;
  }

  /** Record an undo (as a revert of the accept) or a redo (as a new accept) in the AI history. */
  #log(path: string, r: Followed, via: 'undo' | 'redo'): void {
    void this.serial(async () => {
      const e = r.entry;
      if (!e) return;
      const at = this.deps.clock.now();
      if (via === 'undo') {
        // A revert from the AI history that put the text back exactly is already logged.
        if ((await this.deps.log.entries(path)).some((x) => x.revertOf === e.id)) return;
        await this.deps.log.append(path, { kind: 'revert', before: e.after, after: e.before, contextBefore: e.contextBefore, contextAfter: e.contextAfter, at, revertOf: e.id, via });
        return;
      }
      r.entry = await this.deps.log.append(path, {
        kind: 'hunk', before: e.before, after: e.after, contextBefore: e.contextBefore, contextAfter: e.contextAfter, at,
        ...(e.chatId !== undefined ? { chatId: e.chatId } : {}), ...(e.model ? { model: e.model } : {}),
        ...(e.proposalId !== undefined ? { proposalId: e.proposalId } : {}), ...(e.hunkId !== undefined ? { hunkId: e.hunkId } : {}),
        via,
      });
    });
  }

  /** Undo one logged change (a click on Revert in the AI history). */
  revert(path: string, entryId: string): Promise<RevertOutcome> {
    return this.serial(async () => {
      const entries = await this.deps.log.entries(path);
      const entry = entries.find((e) => e.id === entryId);
      if (!entry || entry.kind === 'revert') return 'missing';
      if (entries.some((e) => e.revertOf === entryId)) return 'already';
      const result = entry.kind === 'create' ? await this.revertCreate(path, entry) : await this.revertHunk(path, entry);
      this.changed();
      return result;
    });
  }

  private async revertHunk(path: string, entry: LogEntry): Promise<RevertOutcome> {
    let context = { before: '', after: '' };
    const needle = entry.contextBefore + entry.after + entry.contextAfter;
    const result = await this.deps.applier.apply(path, (text) => {
      const first = needle === '' ? (text === '' ? 0 : -1) : text.indexOf(needle);
      if (first === -1 || (needle !== '' && text.indexOf(needle, first + 1) !== -1)) return null; // not exactly once: conflict
      const from = first + entry.contextBefore.length;
      context = { before: text.slice(Math.max(0, from - CONTEXT), from), after: text.slice(from + entry.after.length, from + entry.after.length + CONTEXT) };
      return { from, to: from + entry.after.length, insert: entry.before };
    });
    if (result !== 'applied') return result;
    await this.deps.log.append(path, {
      kind: 'revert', before: entry.after, after: entry.before, contextBefore: context.before, contextAfter: context.after,
      at: this.deps.clock.now(), revertOf: entry.id,
    });
    return 'reverted';
  }

  /** A created note is moved to the trash only if its text is unchanged since. */
  private async revertCreate(path: string, entry: LogEntry): Promise<RevertOutcome> {
    let text: string;
    try {
      text = await this.deps.readNote(path);
    } catch {
      return 'missing';
    }
    if (text !== entry.after) return 'conflict';
    const result = await this.deps.applier.trash(path);
    if (result === 'missing') return 'missing';
    await this.deps.log.append(path, {
      kind: 'revert', before: entry.after, after: '', contextBefore: '', contextAfter: '', at: this.deps.clock.now(), revertOf: entry.id,
    });
    return 'reverted';
  }
}

/** For the diff card: how a hunk reads in place (text before it, what goes, what comes, text after). */
export function hunkView(p: EditProposal, hunkId: string, around = 40): { lead: string; before: string; after: string; trail: string } | null {
  const h = p.hunks.find((x) => x.id === hunkId);
  if (!h) return null;
  const find = p.edits[h.edit]!.find;
  return {
    lead: find.slice(Math.max(0, h.start - around), h.start),
    before: find.slice(h.start, h.end),
    after: h.after,
    trail: find.slice(h.end, h.end + around),
  };
}

export { editTextNow };
