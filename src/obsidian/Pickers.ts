// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fuzzy pickers for adding context. They list only what the filtered index allows. */

import { type App, FuzzySuggestModal } from 'obsidian';
import type { NoteMeta } from '../core/context/ContextIndex';

export class NotePicker extends FuzzySuggestModal<NoteMeta> {
  constructor(
    app: App,
    private readonly notes: NoteMeta[],
    private readonly onPick: (note: NoteMeta) => void,
  ) {
    super(app);
    this.setPlaceholder('Add a note to the context…');
  }
  override getItems(): NoteMeta[] {
    return this.notes;
  }
  override getItemText(note: NoteMeta): string {
    return note.path.replace(/\.md$/i, '');
  }
  override onChooseItem(note: NoteMeta): void {
    this.onPick(note);
  }
}

export class FolderPicker extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly folders: string[],
    private readonly onPick: (folder: string) => void,
  ) {
    super(app);
    this.setPlaceholder('Add the notes in a folder to the context…');
  }
  override getItems(): string[] {
    return this.folders;
  }
  override getItemText(folder: string): string {
    return folder;
  }
  override onChooseItem(folder: string): void {
    this.onPick(folder);
  }
}
