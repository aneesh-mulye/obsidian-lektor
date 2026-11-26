// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only file allowed to change notes (hard rule 1; eslint/gates.mjs G3,
 * INVARIANTS.md G8). It implements the core's EditApplier, and the core calls
 * it only from accept, create and revert actions the user clicked.
 *
 * If the note is open, the change goes through its editor, so Obsidian's own
 * undo (Ctrl+Z) works; otherwise through vault.process, which reads and
 * writes atomically. It never reads notes for any other purpose.
 */

import { type App, type Editor, MarkdownView } from 'obsidian';
import type { EditApplier, Splice } from '../core/review/types';

export class ReviewController implements EditApplier {
  constructor(private readonly app: App) {}

  async apply(path: string, locate: (text: string) => Splice | null): Promise<'applied' | 'conflict' | 'missing'> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return 'missing';
    const editor = this.openEditor(path);
    if (editor) {
      const splice = locate(editor.getValue());
      if (!splice) return 'conflict';
      editor.replaceRange(splice.insert, editor.offsetToPos(splice.from), editor.offsetToPos(splice.to));
      return 'applied';
    }
    let applied = false;
    await this.app.vault.process(file, (text) => {
      const splice = locate(text);
      if (!splice) return text;
      applied = true;
      return text.slice(0, splice.from) + splice.insert + text.slice(splice.to);
    });
    return applied ? 'applied' : 'conflict';
  }

  async create(path: string, content: string): Promise<'created' | 'exists'> {
    if (this.app.vault.getAbstractFileByPath(path)) return 'exists';
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (folder !== '' && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    await this.app.vault.create(path, content);
    return 'created';
  }

  async trash(path: string): Promise<'trashed' | 'missing'> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return 'missing';
    await this.app.fileManager.trashFile(file); // honours the user's "deleted files" setting
    return 'trashed';
  }

  private openEditor(path: string): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) return leaf.view.editor;
    }
    return null;
  }
}
