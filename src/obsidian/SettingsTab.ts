// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type App, Notice, type Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { AttachmentMode, DisplayMode, SettingsPatch, SettingsStore } from '../core/settings';

export interface SettingsHost extends Plugin {
  settingsStore: SettingsStore;
  saveSettings(): Promise<void>;
}

const DISPLAY_LABELS: Record<DisplayMode, string> = {
  prose: 'Prose',
  sidebar: 'Sidebar diff',
  inline: 'Inline',
};

const ATTACHMENT_LABELS: Record<AttachmentMode, string> = {
  ask: 'Ask for each one',
  allowed: 'Allow if linked from context',
  upfront: 'Send up front',
};

export class LektorSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const store = this.host.settingsStore;
    const s = store.settings;

    const other = store.problems.filter((p) => p.path !== 'context.excludedFolders');
    if (other.length > 0) {
      const box = containerEl.createDiv({ cls: 'lektor-settings-warning' });
      box.createEl('p', { text: 'Some saved settings could not be read and are using their defaults:' });
      const list = box.createEl('ul');
      for (const p of other) list.createEl('li', { text: `${p.path || 'Settings file'}: ${p.message}` });
    }

    // Context
    new Setting(containerEl).setName('Context').setHeading();

    if (!store.exclusionsIntact) {
      containerEl.createDiv({
        cls: 'lektor-settings-warning',
        text: 'Your saved list of excluded folders could not be read, so Lektor will not share any notes until you set the list again below and save it.',
      });
    }

    let draft = store.exclusionsIntact ? s.context.excludedFolders.join('\n') : '';
    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('One glob pattern per line, such as Private/**. Matching notes are never sent to a model and never appear in pickers.')
      .setClass('lektor-exclusions')
      .addTextArea((text) =>
        text
          .setPlaceholder('Private/**\nJournal')
          .setValue(draft)
          .onChange((value) => {
            draft = value;
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Save list')
          .setCta()
          .onClick(() => void this.saveExclusions(draft)),
      );

    new Setting(containerEl)
      .setName('Attachments')
      .setDesc('Whether files linked from notes in context are sent, and when.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(ATTACHMENT_LABELS)
          .setValue(s.context.attachmentMode)
          .onChange((value) => void this.apply({ context: { attachmentMode: value as AttachmentMode } })),
      );

    new Setting(containerEl)
      .setName('Maximum link depth')
      .setDesc('How many levels of outgoing links a note in context may pull in (0–3).')
      .addSlider((slider) =>
        slider
          .setLimits(0, 3, 1)
          .setValue(s.context.maxLinkDepth)
          .setDynamicTooltip()
          .onChange((value) => void this.apply({ context: { maxLinkDepth: value } })),
      );

    // Tools
    new Setting(containerEl).setName('Tools').setHeading();

    new Setting(containerEl)
      .setName('Searches per message')
      .setDesc('The most web searches a model may run for one message.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 50, 1)
          .setValue(s.tools.searchesPerMessage)
          .setDynamicTooltip()
          .onChange((value) => void this.apply({ tools: { searchesPerMessage: value } })),
      );

    new Setting(containerEl)
      .setName('Page fetches per message')
      .setDesc('The most web pages a model may fetch for one message.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 50, 1)
          .setValue(s.tools.fetchesPerMessage)
          .setDynamicTooltip()
          .onChange((value) => void this.apply({ tools: { fetchesPerMessage: value } })),
      );

    // Review
    new Setting(containerEl).setName('Review').setHeading();

    new Setting(containerEl)
      .setName('Default display mode')
      .setDesc('How proposed edits are shown. You can switch per chat from the sidebar header.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(DISPLAY_LABELS)
          .setValue(s.review.defaultDisplayMode)
          .onChange((value) => void this.apply({ review: { defaultDisplayMode: value as DisplayMode } })),
      );

    // Privacy
    new Setting(containerEl).setName('Privacy').setHeading();

    new Setting(containerEl)
      .setName('Store full transcripts')
      .setDesc('Chat history normally records which notes were in context, not their contents. Turn this on to keep the full text of every chat.')
      .addToggle((toggle) =>
        toggle
          .setValue(s.privacy.storeFullTranscripts)
          .onChange((value) => void this.apply({ privacy: { storeFullTranscripts: value } })),
      );
  }

  private async apply(patch: SettingsPatch): Promise<void> {
    const result = this.host.settingsStore.update(patch);
    if (!result.ok) {
      new Notice(`Lektor: ${result.problems[0]?.message ?? 'that value is not allowed.'}`);
      this.display();
      return;
    }
    await this.save();
  }

  private async saveExclusions(text: string): Promise<void> {
    const result = this.host.settingsStore.setExcludedFolders(text.split(/\r?\n/));
    if (!result.ok) {
      new Notice(`Lektor: ${result.problems[0]?.message ?? 'that list is not allowed.'}`);
      return;
    }
    if (await this.save()) {
      new Notice('Lektor: excluded folders saved.');
      this.display();
    }
  }

  private async save(): Promise<boolean> {
    try {
      await this.host.saveSettings();
      return true;
    } catch (err) {
      console.error('Lektor: saving settings failed', err);
      new Notice('Lektor: could not save settings. See the developer console for details.');
      return false;
    }
  }
}
