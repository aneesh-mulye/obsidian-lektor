// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type App, Modal, Setting } from 'obsidian';

/** Ask a yes/no question; resolves true only if the user clicks the action button. */
export function confirm(app: App, opts: { title: string; body: string; action: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.setTitle(opts.title);
        this.contentEl.createEl('p', { text: opts.body });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
          .addButton((b) =>
            b
              .setButtonText(opts.action)
              .setWarning()
              .onClick(() => {
                answered = true;
                this.close();
              }),
          );
      }
      override onClose(): void {
        this.contentEl.empty();
        resolve(answered);
      }
    })(app);
    modal.open();
  });
}
