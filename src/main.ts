// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Notice, Plugin } from 'obsidian';
import { SettingsStore } from './core/settings';
import { LektorView, VIEW_TYPE_LEKTOR } from './obsidian/LektorView';
import { LektorSettingTab } from './obsidian/SettingsTab';

export default class LektorPlugin extends Plugin {
  // Not `settings`: Obsidian 1.13+ declares Plugin.settings for raw loaded data.
  settingsStore: SettingsStore = SettingsStore.load(null);

  override async onload(): Promise<void> {
    this.settingsStore = SettingsStore.load(await this.loadData());
    if (this.settingsStore.problems.length > 0) {
      new Notice('Lektor: some saved settings could not be read. Open Settings → Lektor to review them.');
    }

    this.registerView(VIEW_TYPE_LEKTOR, (leaf) => new LektorView(leaf));
    this.addRibbonIcon('message-square', 'Open Lektor', () => void this.activateView());
    this.addCommand({ id: 'open-sidebar', name: 'Open sidebar', callback: () => void this.activateView() });
    this.addSettingTab(new LektorSettingTab(this.app, this));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settingsStore.toData());
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LEKTOR)[0] ?? null;
    if (leaf === null) {
      leaf = workspace.getRightLeaf(false);
      if (leaf === null) return;
      await leaf.setViewState({ type: VIEW_TYPE_LEKTOR, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}
