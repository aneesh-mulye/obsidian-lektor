// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Notice, Plugin } from 'obsidian';
import { ChatHistory } from './core/chat/history';
import { ChatManager } from './core/chat/manager';
import { OllamaProvider } from './core/providers/ollama';
import type { ChatProvider } from './core/providers/types';
import { SettingsStore } from './core/settings';
import { confirm } from './obsidian/ConfirmModal';
import { FetchHttpClient } from './obsidian/Http';
import { LektorView, VIEW_TYPE_LEKTOR } from './obsidian/LektorView';
import { PluginStorage } from './obsidian/PluginStorage';
import { LektorSettingTab } from './obsidian/SettingsTab';

export default class LektorPlugin extends Plugin {
  // Not `settings`: Obsidian 1.13+ declares Plugin.settings for raw loaded data.
  settingsStore: SettingsStore = SettingsStore.load(null);
  ollama!: OllamaProvider;
  private chats!: ChatManager;

  override async onload(): Promise<void> {
    this.settingsStore = SettingsStore.load(await this.loadData());
    if (this.settingsStore.problems.length > 0) {
      new Notice('Lektor: some saved settings could not be read. Open Settings → Lektor to review them.');
    }

    const http = new FetchHttpClient();
    this.ollama = new OllamaProvider(http, () => this.settingsStore.settings.models.ollama.baseUrl);
    const providers: ChatProvider[] = [this.ollama];
    const byId = new Map(providers.map((p) => [p.id, p]));

    this.chats = new ChatManager({
      providers: { get: (id) => byId.get(id) },
      clock: { now: () => Date.now() },
      newId: () => crypto.randomUUID(),
      history: new ChatHistory(new PluginStorage(this.app, this.manifest.dir)),
      defaultModel: () => (this.settingsStore.settings.models.defaultModel) ?? null,
      setDefaultModel: async (model) => {
        if (this.settingsStore.update({ models: { defaultModel: model } }).ok) await this.saveSettings();
      },
      onError: (message, err) => {
        if (err !== undefined) console.error(`Lektor: ${message}`, err);
        new Notice(`Lektor: ${message}`);
      },
    });

    const clearAllChats = async () => {
      const ok = await confirm(this.app, {
        title: 'Clear all chats?',
        body: 'This deletes every saved Lektor chat. It cannot be undone.',
        action: 'Delete all',
      });
      if (ok) await this.chats.clearAll();
    };

    this.registerView(VIEW_TYPE_LEKTOR, (leaf) => new LektorView(leaf, { manager: this.chats, providers, clearAllChats }));
    this.addRibbonIcon('message-square', 'Open Lektor', () => void this.activateView());
    this.addCommand({ id: 'open-sidebar', name: 'Open sidebar', callback: () => void this.activateView() });
    this.addCommand({
      id: 'new-chat',
      name: 'New chat',
      callback: () => {
        this.chats.newChat();
        void this.activateView();
      },
    });
    this.addCommand({ id: 'clear-all-chats', name: 'Clear all chats', callback: () => void clearAllChats() });
    this.addSettingTab(new LektorSettingTab(this.app, this));
  }

  override onunload(): void {
    this.chats?.dispose();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settingsStore.toData());
  }

  /** For the settings tab's connection check. */
  async checkOllama(): Promise<string> {
    const models = await this.ollama.listModels();
    return models.length === 0 ? 'Connected, but no models are installed.' : `Connected: ${models.length} model${models.length === 1 ? '' : 's'} available.`;
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
