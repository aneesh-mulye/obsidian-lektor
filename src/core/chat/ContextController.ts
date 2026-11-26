// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The context actions the UI calls, applied to the open chat. After every
 * change the current-note chip is brought up to date, so "follow the active
 * note" always holds (INVARIANTS.md X2 runs the same rule).
 */

import type { ContextIndex } from '../context/ContextIndex';
import { type ContextPlan, type DepthPreview, planContext, previewDepths } from '../context/plan';
import { restoreContext } from '../context/prepare';
import type { AttachmentMode } from '../settings';
import {
  type CapturedSelection,
  type Change,
  type ContextState,
  type Depth,
  addAttachment,
  addFolder,
  addNote,
  addSelection,
  pinChip,
  removeChip,
  renamePath,
  revalidate,
  setActive,
  setBacklinkContents,
  setDepth,
  setFollow,
  setAttachmentMode,
  setRecursive,
  withhold,
  attachmentModeOf,
} from '../context/state';
import type { ChatSession } from './session';

export interface ContextDeps {
  index: ContextIndex;
  /** The note open in the editor (any path; the index decides whether it may be used). */
  activeNote: () => string | null;
  newId: () => string;
  /** The deepest link depth the settings allow. */
  maxDepth: () => Depth;
  onNotice: (message: string) => void;
  /** The attachment mode for chats that never chose one (Settings → Context). Ask if absent. */
  attachmentMode?: () => AttachmentMode;
}

export class ContextController {
  constructor(
    private readonly session: () => ChatSession,
    private readonly deps: ContextDeps,
  ) {}

  get state(): ContextState {
    return this.session().chat.context;
  }

  get index(): ContextIndex {
    return this.deps.index;
  }

  addNote(path: string): void {
    this.apply(addNote(this.state, this.deps.index, path, this.deps.newId));
  }

  /** Add (pin) the note open in the editor. */
  addActiveNote(): void {
    const active = this.deps.activeNote();
    if (active === null) this.deps.onNotice('No note is open.');
    else this.addNote(active);
  }

  addFolder(path: string, recursive: boolean): void {
    this.apply(addFolder(this.state, this.deps.index, path, recursive, this.deps.newId));
  }

  addAttachment(path: string): void {
    this.apply(addAttachment(this.state, this.deps.index, path, this.deps.newId));
  }

  /** Keep an attachment out of this chat (the × on an Upfront chip). */
  withhold(path: string): void {
    this.apply(withhold(this.state, path));
  }

  /** The paperclip: this chat's attachment mode, or undefined for the setting's. */
  setAttachmentMode(mode: AttachmentMode | undefined): void {
    this.apply(setAttachmentMode(this.state, mode));
  }

  /** The setting's attachment mode (for chats that never chose one). */
  get defaultAttachmentMode(): AttachmentMode {
    return this.deps.attachmentMode?.() ?? 'ask';
  }

  /** This chat's attachment mode. */
  get attachmentMode(): AttachmentMode {
    return attachmentModeOf(this.state, this.defaultAttachmentMode);
  }

  addSelection(selection: CapturedSelection): void {
    this.apply(addSelection(this.state, this.deps.index, selection, this.deps.newId));
  }

  remove(id: string): void {
    this.apply(removeChip(this.state, id));
  }

  setDepth(id: string, depth: Depth): void {
    this.apply(setDepth(this.state, id, Math.min(depth, this.deps.maxDepth()) as Depth));
  }

  setBacklinkContents(id: string, on: boolean): void {
    this.apply(setBacklinkContents(this.state, id, on));
  }

  setRecursive(id: string, on: boolean): void {
    this.apply(setRecursive(this.state, id, on));
  }

  pin(id: string): void {
    this.apply(pinChip(this.state, id));
  }

  setFollow(on: boolean): void {
    this.apply(setFollow(this.state, this.deps.index, on, this.deps.activeNote(), this.deps.newId));
  }

  /** The active note changed. */
  activeChanged(): void {
    this.apply(this.state);
  }

  /** Re-apply the rules (e.g. after the link-depth limit changed). */
  settingsChanged(): void {
    this.apply(this.state);
  }

  /** The vault, its links or the exclusion settings changed (the index must already be refreshed). */
  vaultChanged(): void {
    this.apply(revalidate(this.state, this.deps.index));
  }

  renamed(from: string, to: string): void {
    this.apply(renamePath(this.state, from, to));
  }

  /** Bring back a reopened chat's chips. */
  async restore(): Promise<void> {
    const session = this.session();
    const change = await restoreContext(session.chat.context, this.deps.index);
    if (this.session() === session) this.apply(change);
  }

  plan(): ContextPlan {
    return planContext(this.state, this.deps.index, this.defaultAttachmentMode);
  }

  previews(chipId: string): DepthPreview[] {
    const chip = this.state.chips.find((c) => c.id === chipId);
    return chip?.kind === 'note' ? previewDepths(chip, this.deps.index, this.deps.maxDepth(), this.attachmentMode) : [];
  }

  private apply(change: ContextState | Change): void {
    const { state, notice } = 'state' in change ? change : { state: change, notice: undefined };
    // Never deeper than the settings allow, even if the limit was lowered after a chip was set.
    const max = this.deps.maxDepth();
    const clamped = state.chips.some((c) => c.kind === 'note' && c.depth > max)
      ? { ...state, chips: state.chips.map((c) => (c.kind === 'note' && c.depth > max ? { ...c, depth: max } : c)) }
      : state;
    this.session().setContext(setActive(clamped, this.deps.index, this.deps.activeNote(), this.deps.newId));
    if (notice) this.deps.onNotice(notice);
  }
}
