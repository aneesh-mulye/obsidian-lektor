// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A chat's context: the chips above the composer (DESIGN.md § Context system).
 * Pure functions over plain data. What the chips describe is exactly what
 * the model is sent (INVARIANTS.md X2).
 */

import type { AttachmentMode } from '../settings';
import type { ContextIndex } from './ContextIndex';

export type Depth = 0 | 1 | 2 | 3;

export interface NoteChip {
  readonly kind: 'note';
  readonly id: string;
  readonly path: string;
  /** Levels of outgoing links to follow. */
  readonly depth: Depth;
  /** Send the contents of notes linking here, not just their paths. */
  readonly backlinkContents: boolean;
  /** The chip that follows the active note. */
  readonly current: boolean;
  /** Hash of the note's text when it was last sent. */
  readonly lastHash?: string;
  /** The note changed since it was last sent (shown after reopening a chat). */
  readonly changed?: boolean;
}

export interface FolderChip {
  readonly kind: 'folder';
  readonly id: string;
  readonly path: string;
  readonly recursive: boolean;
}

export interface SelectionChip {
  readonly kind: 'selection';
  readonly id: string;
  /** The note the text was selected in. */
  readonly path: string;
  /** Character range in the note when captured. */
  readonly from: number;
  readonly to: number;
  /** Hash of the selected text. */
  readonly hash: string;
  /** The text itself; never stored in chat history, so absent until restored. */
  readonly text?: string;
}

/** A file that is not a note: an image, a text file (DESIGN.md § Embeds and attachments). */
export interface AttachmentChip {
  readonly kind: 'attachment';
  readonly id: string;
  readonly path: string;
  /** Hash of the file's bytes when it was last sent. */
  readonly lastHash?: string;
  /** The file changed since it was last sent (shown after reopening a chat). */
  readonly changed?: boolean;
}

export type Chip = NoteChip | FolderChip | SelectionChip | AttachmentChip;

export interface ContextState {
  /** Whether a chip follows the active note. */
  readonly followActive: boolean;
  readonly chips: readonly Chip[];
  /** This chat's attachment mode (the paperclip); absent means the setting's. */
  readonly attachmentMode?: AttachmentMode;
  /**
   * Attachments the user removed: kept out of this chat until added again. Upfront mode does not
   * bring them back, and Allowed mode does not grant them without asking.
   */
  readonly withheld?: readonly string[];
}

/** The chat's attachment mode, or the setting's for chats that never chose one. */
export function attachmentModeOf(s: ContextState, fallback: AttachmentMode): AttachmentMode {
  return s.attachmentMode ?? fallback;
}

export const EMPTY_CONTEXT: ContextState = Object.freeze({ followActive: true, chips: Object.freeze([]) });

export interface Change {
  state: ContextState;
  /** Something to tell the user (a refusal, or chips that were dropped). */
  notice?: string;
}

export interface CapturedSelection {
  path: string;
  text: string;
  from: number;
  to: number;
  hash: string;
}

const why = (index: ContextIndex, path: string, what: string): string =>
  index.isExcluded(path) ? `${path} is excluded, so it can't be added.` : `${what} ${path} doesn't exist.`;

const noteChips = (s: ContextState) => s.chips.filter((c): c is NoteChip => c.kind === 'note');

function withChips(s: ContextState, chips: readonly Chip[]): ContextState {
  return { ...s, chips };
}

/** Add a note. Adding the note the current chip follows pins it. */
export function addNote(s: ContextState, index: ContextIndex, path: string, newId: () => string): Change {
  if (!index.note(path)) return { state: s, notice: why(index, path, 'The note') };
  const existing = noteChips(s).find((c) => c.path === path);
  if (existing) return { state: existing.current ? pinChip(s, existing.id) : s };
  const chip: NoteChip = { kind: 'note', id: newId(), path, depth: 0, backlinkContents: false, current: false };
  return { state: withChips(s, [...s.chips, chip]) };
}

export function addFolder(s: ContextState, index: ContextIndex, path: string, recursive: boolean, newId: () => string): Change {
  if (!index.hasFolder(path)) return { state: s, notice: why(index, path, 'The folder') };
  if (s.chips.some((c) => c.kind === 'folder' && c.path === path)) return { state: s };
  return { state: withChips(s, [...s.chips, { kind: 'folder', id: newId(), path, recursive }]) };
}

export function addSelection(s: ContextState, index: ContextIndex, sel: CapturedSelection, newId: () => string): Change {
  if (!index.note(sel.path)) return { state: s, notice: why(index, sel.path, 'The note') };
  if (sel.text === '') return { state: s };
  return { state: withChips(s, [...s.chips, { kind: 'selection', id: newId(), ...sel }]) };
}

const unwithhold = (s: ContextState, path: string): ContextState => {
  if (!s.withheld?.includes(path)) return s;
  const withheld = s.withheld.filter((p) => p !== path);
  const { withheld: _w, ...rest } = s;
  return withheld.length > 0 ? { ...rest, withheld } : rest;
};

/** Add an attachment. Adding one the user removed earlier lets it back in. */
export function addAttachment(s: ContextState, index: ContextIndex, path: string, newId: () => string): Change {
  if (!index.attachment(path)) return { state: s, notice: why(index, path, 'The file') };
  const open = unwithhold(s, path);
  if (open.chips.some((c) => c.kind === 'attachment' && c.path === path)) return { state: open };
  return { state: withChips(open, [...open.chips, { kind: 'attachment', id: newId(), path }]) };
}

/** Keep an attachment out of this chat (removing an Upfront chip, which has no chip of its own). */
export function withhold(s: ContextState, path: string): ContextState {
  const chips = s.chips.filter((c) => !(c.kind === 'attachment' && c.path === path));
  if (s.withheld?.includes(path)) return chips.length === s.chips.length ? s : withChips(s, chips);
  return { ...withChips(s, chips), withheld: [...(s.withheld ?? []), path] };
}

/** This chat's attachment mode; undefined goes back to the setting. */
export function setAttachmentMode(s: ContextState, mode: AttachmentMode | undefined): ContextState {
  const { attachmentMode: _m, ...rest } = s;
  return mode === undefined ? rest : { ...rest, attachmentMode: mode };
}

/** Items the user shared through a request_context card become chips (DESIGN.md § Model-initiated requests). */
export function addShared(s: ContextState, index: ContextIndex, shared: { notes: readonly string[]; attachments: readonly string[] }, newId: () => string): ContextState {
  let state = s;
  for (const path of shared.notes) state = addNote(state, index, path, newId).state;
  for (const path of shared.attachments) state = addAttachment(state, index, path, newId).state;
  return state;
}

/** Remove a chip. Removing the current-note chip stops the following for this chat; removing an attachment withholds it. */
export function removeChip(s: ContextState, id: string): ContextState {
  const chip = s.chips.find((c) => c.id === id);
  if (!chip) return s;
  if (chip.kind === 'attachment') return withhold(s, chip.path);
  const followActive = chip.kind === 'note' && chip.current ? false : s.followActive;
  return { ...s, followActive, chips: s.chips.filter((c) => c.id !== id) };
}

function updateNote(s: ContextState, id: string, fn: (c: NoteChip) => NoteChip): ContextState {
  return withChips(s, s.chips.map((c) => (c.id === id && c.kind === 'note' ? fn(c) : c)));
}

export function setDepth(s: ContextState, id: string, depth: Depth): ContextState {
  return updateNote(s, id, (c) => ({ ...c, depth }));
}

export function setBacklinkContents(s: ContextState, id: string, on: boolean): ContextState {
  return updateNote(s, id, (c) => ({ ...c, backlinkContents: on }));
}

export function setRecursive(s: ContextState, id: string, on: boolean): ContextState {
  return withChips(s, s.chips.map((c) => (c.id === id && c.kind === 'folder' ? { ...c, recursive: on } : c)));
}

/** Keep the current note when the active note changes; following carries on with a new chip. */
export function pinChip(s: ContextState, id: string): ContextState {
  return updateNote(s, id, (c) => ({ ...c, current: false }));
}

export function setFollow(s: ContextState, index: ContextIndex, on: boolean, active: string | null, newId: () => string): ContextState {
  const next = { ...s, followActive: on };
  return on ? setActive(next, index, active, newId) : withChips(next, next.chips.filter((c) => !(c.kind === 'note' && c.current)));
}

/** The active note changed: move the current-note chip to it (or drop it, if it is excluded or gone). */
export function setActive(s: ContextState, index: ContextIndex, active: string | null, newId: () => string): ContextState {
  if (!s.followActive) return s;
  const current = noteChips(s).find((c) => c.current);
  const usable = active !== null && index.note(active) !== null;
  const pinned = usable && noteChips(s).some((c) => !c.current && c.path === active);
  if (!usable || pinned) return current ? withChips(s, s.chips.filter((c) => c.id !== current.id)) : s;
  if (current?.path === active) return s;
  if (current) {
    return updateNote(s, current.id, (): NoteChip => ({ kind: 'note', id: current.id, path: active, depth: 0, backlinkContents: false, current: true }));
  }
  const chip: NoteChip = { kind: 'note', id: newId(), path: active, depth: 0, backlinkContents: false, current: true };
  return withChips(s, [chip, ...s.chips]);
}

/** After a vault or settings change: drop chips whose note or folder is now excluded or gone. */
export function revalidate(s: ContextState, index: ContextIndex): Change {
  const dropped: string[] = [];
  const chips = s.chips.filter((c) => {
    const ok = c.kind === 'folder' ? index.hasFolder(c.path) : c.kind === 'attachment' ? index.attachment(c.path) !== null : index.note(c.path) !== null;
    if (!ok) dropped.push(c.kind === 'selection' ? `a selection from ${c.path}` : c.path);
    return ok;
  });
  if (dropped.length === 0) return { state: s };
  const what = dropped.length === 1 ? dropped[0]! : `${dropped.length} items`;
  return { state: withChips(s, chips), notice: `Removed from context because it is now excluded or no longer exists: ${what}.` };
}

/** A note or folder was renamed: chips follow it. */
export function renamePath(s: ContextState, from: string, to: string): ContextState {
  const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  const moved = withChips(s, s.chips.map((c) => ({ ...c, path: move(c.path) })));
  return s.withheld ? { ...moved, withheld: s.withheld.map(move) } : moved;
}
