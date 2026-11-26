// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A note's AI edit history, with Revert (DESIGN.md § AI undo history). */

import { type App, Modal, Notice, Setting } from 'obsidian';
import type { EditLog, LogEntry } from '../core/review/log';
import type { ReviewManager } from '../core/review/manager';
import { confirm } from './ConfirmModal';

const OUTCOME: Record<string, string> = {
  reverted: 'Reverted.',
  conflict: 'Could not revert: the note has changed around this edit since. Nothing was changed.',
  missing: 'Could not revert: the note no longer exists.',
  already: 'This edit was already reverted.',
};

export class EditHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly log: EditLog,
    private readonly review: ReviewManager,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(`AI edit history: ${this.path}`);
    void this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass('lektor-history-modal');
    const entries = await this.log.entries(this.path);
    if (entries.length === 0) {
      el.createEl('p', { text: 'Lektor has not changed this note.', cls: 'lektor-note' });
      return;
    }
    const reverted = new Set(entries.flatMap((e) => (e.revertOf ? [e.revertOf] : [])));
    for (const e of [...entries].reverse()) this.entry(el, e, reverted.has(e.id));
    new Setting(el).addButton((b) =>
      b
        .setButtonText("Clear this note's AI history")
        .setWarning()
        .onClick(() => {
          void confirm(this.app, {
            title: 'Clear AI edit history?',
            body: `This deletes the record of every change Lektor made to ${this.path}. The note itself is not changed. It cannot be undone.`,
            action: 'Clear',
          }).then(async (ok) => {
            if (!ok) return;
            await this.log.clear(this.path);
            await this.render();
          });
        }),
    );
  }

  private entry(parent: HTMLElement, e: LogEntry, isReverted: boolean): void {
    const row = parent.createDiv({ cls: 'lektor-history-entry' });
    const head = row.createDiv({ cls: 'lektor-history-entry-head' });
    const kind =
      e.kind === 'create'
        ? 'Created the note'
        : e.kind === 'revert'
          ? e.via === 'undo' ? 'Undone in the note' : 'Reverted a change'
          : e.via === 'redo' ? 'Redone in the note' : 'Accepted a change';
    head.createSpan({ text: `${new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${kind}${e.model ? ` · ${e.model.model}` : ''}` });
    const body = row.createDiv({ cls: 'lektor-hunk-text' });
    if (e.kind === 'create') {
      body.createSpan({ text: e.after.length > 300 ? `${e.after.slice(0, 300)}…` : e.after });
    } else {
      // Show only the change's own line around it; the full context is kept for finding it again.
      const lead = e.contextBefore.slice(e.contextBefore.lastIndexOf('\n') + 1);
      const trail = e.contextAfter.split('\n')[0] ?? '';
      if (lead) body.createSpan({ cls: 'lektor-hunk-context', text: lead });
      if (e.before) body.createEl('del', { text: e.before });
      if (e.after) body.createEl('ins', { text: e.after });
      if (trail) body.createSpan({ cls: 'lektor-hunk-context', text: trail });
    }
    if (e.kind === 'revert') return;
    new Setting(row).addButton((b) => {
      b.setButtonText(isReverted ? 'Reverted' : 'Revert').setDisabled(isReverted);
      b.onClick(() => {
        void this.review.revert(this.path, e.id).then(async (outcome) => {
          new Notice(`Lektor: ${OUTCOME[outcome] ?? outcome}`);
          await this.render();
        });
      });
    });
  }
}
