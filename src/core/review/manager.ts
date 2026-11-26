// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Accept, reject, create and revert: the only code that asks the EditApplier
 * to change the vault, and every public method here is a user's click
 * (hard rule 1; INVARIANTS.md W3–W6). Changes run one at a time.
 */

import type { Chat, Clock } from '../chat/types';
import type { EditLog, LogEntry } from './log';
import { fingerprint } from './fingerprint';
import { editTextNow, locateHunk } from './proposals';
import type { EditApplier, EditProposal, NoteProposal, Proposal, Splice } from './types';

/** Where a proposal lives: the chat session that made it. */
export interface ProposalHost {
  readonly chat: Chat;
  updateProposal(id: string, fn: (p: Proposal) => Proposal): void;
}

export type AcceptOutcome = 'applied' | 'conflict' | 'missing' | 'done';
export type RevertOutcome = 'reverted' | 'conflict' | 'missing' | 'already';

/** Characters kept on each side of a change, to find it again for a revert. */
const CONTEXT = 40;

export class ReviewManager {
  #queue: Promise<unknown> = Promise.resolve();
  /** Why a hunk or note card could not be applied, until it is tried again (shown on the card). */
  readonly problems = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(
    private readonly deps: {
      applier: EditApplier;
      log: EditLog;
      /** The note's current text (through ContextBroker). */
      readNote: (path: string) => Promise<string>;
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
      const result = await this.deps.applier.apply(p.path, (text) => {
        splice = locateHunk(text, p, hunkId);
        if (splice) {
          context = { before: text.slice(Math.max(0, splice.from - CONTEXT), splice.from), after: text.slice(splice.to, splice.to + CONTEXT) };
          // Only if the note was as this review left it does it stay "as expected" afterwards.
          if (fingerprint(text) === p.expect) expect = fingerprint(text.slice(0, splice.from) + splice.insert + text.slice(splice.to));
        }
        return splice;
      });
      if (result === 'applied' && splice !== null) {
        const s: Splice = splice;
        host.updateProposal(proposalId, (q) =>
          q.kind !== 'edit' ? q : { ...q, expect, hunks: q.hunks.map((h) => (h.id === hunkId ? { ...h, status: 'accepted' } : h)) },
        );
        this.problems.delete(hunkId);
        await this.deps.log.append(p.path, {
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
