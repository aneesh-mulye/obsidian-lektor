// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Proposals: models never edit; they propose, and the user accepts or rejects each hunk (DESIGN.md § Edits and diff review). */

import type { ModelRef } from '../providers/types';

export interface EditSpec {
  find: string;
  replace: string;
  reason?: string;
}

export type HunkStatus = 'pending' | 'accepted' | 'rejected';

export interface HunkRecord {
  readonly id: string;
  /** Which of the proposal's edits it belongs to. */
  readonly edit: number;
  /** Offsets into that edit's `find`. */
  readonly start: number;
  readonly end: number;
  readonly after: string;
  readonly status: HunkStatus;
}

export interface EditProposal {
  readonly kind: 'edit';
  readonly id: string;
  readonly path: string;
  /** The model's own edits: everything below derives from them. */
  readonly edits: readonly EditSpec[];
  /** Where each edit's `find` started in the note when proposed. */
  readonly anchors: readonly number[];
  /** Fingerprint of the text the note should have now, if nothing but this review changed it. */
  readonly expect: string;
  readonly hunks: readonly HunkRecord[];
  readonly createdAt: number;
  readonly model: ModelRef;
}

export interface NoteProposal {
  readonly kind: 'note';
  readonly id: string;
  readonly path: string;
  readonly content: string;
  readonly status: 'pending' | 'created' | 'dismissed';
  readonly createdAt: number;
  readonly model: ModelRef;
}

export type Proposal = EditProposal | NoteProposal;

/** A change to make to a note's current text. */
export interface Splice {
  from: number;
  to: number;
  insert: string;
}

/**
 * The only way the core changes the vault. Implemented solely by
 * src/obsidian/ReviewController.ts, and called only from accept, create and
 * revert actions the user clicked (hard rule 1; INVARIANTS.md W3, G8).
 */
export interface EditApplier {
  /** Atomically: read the note's current text, let `locate` decide the change (null = none), and apply it. */
  apply(path: string, locate: (text: string) => Splice | null): Promise<'applied' | 'conflict' | 'missing'>;
  /** Create a new note; never overwrites. */
  create(path: string, content: string): Promise<'created' | 'exists'>;
  /** Move a note to the trash. */
  trash(path: string): Promise<'trashed' | 'missing'>;
}
