// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type App, Notice, type Plugin, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import { confirm } from './ConfirmModal';
import { renderPresetSettings } from './PresetSettings';
import { renderEndpointSettings } from './EndpointSettings';
import { renderClaudeCodeSettings } from './ClaudeCodeSettings';
import { renderCodexSettings } from './CodexSettings';
import type { ClaudeCodeProvider } from '../core/cli/claude/provider';
import type { CodexProvider } from '../core/cli/codex/provider';
import type { PresetLibrary } from '../core/presets/library';
import {
  type AttachmentMode,
  type DisplayMode,
  type SafeSearch,
  type SearchProviderId,
  type SettingsPatch,
  type SettingsStore,
  type Endpoint,
  normaliseBaseUrl,
} from '../core/settings';

const PROVIDER_LABELS: Record<SearchProviderId, string> = {
  none: 'None',
  tavily: 'Tavily',
  exa: 'Exa',
  brave: 'Brave Search',
  searxng: 'SearXNG',
  duckduckgo: 'DuckDuckGo (no key)',
};

export interface SettingsHost extends Plugin {
  settingsStore: SettingsStore;
  saveSettings(): Promise<void>;
  /** Contact the configured Ollama server and describe what it has. */
  checkOllama(): Promise<string>;
  /** Exclusion or link-depth settings changed. */
  contextSettingsChanged(): void;
  /** Delete all AI edit history. */
  clearEditHistory(): Promise<void>;
  presets: PresetLibrary;
  /** Contact an OpenAI- or Anthropic-compatible server and describe what it has. */
  checkEndpoint(endpoint: Endpoint): Promise<string>;
  claudeCode: ClaudeCodeProvider | null;
  codex: CodexProvider | null;
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

    // Models
    new Setting(containerEl).setName('Models').setHeading();

    let urlDraft = s.models.ollama.baseUrl;
    new Setting(containerEl)
      .setName('Ollama server')
      .setDesc('Where your Ollama server listens. Chats with Ollama models are sent only to this address.')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:11434')
          .setValue(urlDraft)
          .onChange((value) => {
            urlDraft = value;
          }),
      )
      .addButton((button) => button.setButtonText('Save and check').onClick(() => void this.saveOllamaUrl(urlDraft)));

    new Setting(containerEl)
      .setName('Ollama context length')
      .setDesc(
        'Tokens of context Ollama gives each request (sent as num_ctx), and the budget Lektor checks messages against. ' +
          "To avoid reloading the model when other apps use it too, match your server's OLLAMA_CONTEXT_LENGTH. Larger values need more memory.",
      )
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '2048';
        text.inputEl.max = '1048576';
        text
          .setPlaceholder('32768')
          .setValue(String(s.models.ollama.contextLength))
          .onChange((value) => {
            const n = Number(value);
            if (Number.isInteger(n) && n >= 2048 && n <= 1048576) {
              void this.apply({ models: { ollama: { ...this.host.settingsStore.settings.models.ollama, contextLength: n } } }, false);
            }
          });
      });

    renderEndpointSettings(
      this.app,
      containerEl,
      {
        endpoints: () => this.host.settingsStore.settings.models.endpoints,
        save: async (endpoints) => {
          const result = this.host.settingsStore.update({ models: { endpoints } });
          if (!result.ok) {
            new Notice(`Lektor: ${result.problems[0]?.message ?? 'that endpoint is not allowed.'}`);
            return false;
          }
          return this.save();
        },
        check: (e) => this.host.checkEndpoint(e),
      },
      () => this.display(),
    );

    renderClaudeCodeSettings(
      this.app,
      containerEl,
      { settings: () => this.host.settingsStore.settings, apply: (patch) => this.apply(patch), provider: this.host.claudeCode },
      () => this.display(),
    );

    renderCodexSettings(
      this.app,
      containerEl,
      { settings: () => this.host.settingsStore.settings, apply: (patch) => this.apply(patch), provider: this.host.codex },
      () => this.display(),
    );

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
      .setDesc(
        'One pattern per line. A name such as Private excludes every folder or note with that name, and everything in it; ' +
          'a path such as Work/Clients is matched from the top of the vault; * and ** work as in .gitignore. ' +
          'Matching ignores case. Excluded notes are never sent to a model and never appear in pickers.',
      )
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
      .setName("Also respect Obsidian's excluded files")
      .setDesc('Treat everything in Settings → Files and links → Excluded files as excluded too.')
      .addToggle((toggle) =>
        toggle.setValue(s.context.respectObsidianExclusions).onChange((value) => {
          void this.apply({ context: { respectObsidianExclusions: value } }).then(() => this.host.contextSettingsChanged());
        }),
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
          .onChange((value) => void this.apply({ context: { maxLinkDepth: value } }).then(() => this.host.contextSettingsChanged())),
      );

    // Tools
    new Setting(containerEl).setName('Tools').setHeading();

    const t = s.tools;
    new Setting(containerEl)
      .setName('Web search provider')
      .setDesc('Where web_search sends queries. None means no search traffic at all; models can still fetch pages you mention.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(PROVIDER_LABELS)
          .setValue(t.searchProvider)
          .onChange((value) => void this.apply({ tools: { searchProvider: value as SearchProviderId } }).then(() => this.display())),
      );

    if (t.searchProvider === 'tavily' || t.searchProvider === 'exa' || t.searchProvider === 'brave') {
      const id = t.searchProvider;
      new Setting(containerEl)
        .setName(`${PROVIDER_LABELS[id]} API key`)
        .setDesc("Kept in Obsidian's secret storage; Lektor's settings store only the secret's name.")
        .addComponent((el) =>
          new SecretComponent(this.app, el)
            .setValue(t.secrets[id])
            .onChange((value) => void this.apply({ tools: { secrets: { ...this.host.settingsStore.settings.tools.secrets, [id]: value ?? '' } } })),
        );
    }

    if (t.searchProvider === 'searxng') {
      let searxDraft = t.searxngUrl;
      new Setting(containerEl)
        .setName('SearXNG address')
        .setDesc('Your SearXNG server. It must allow JSON results ("json" in search.formats).')
        .addText((text) =>
          text
            .setPlaceholder('https://searx.example')
            .setValue(searxDraft)
            .onChange((value) => {
              searxDraft = value;
            }),
        )
        .addButton((button) =>
          button.setButtonText('Save').onClick(() => {
            const url = searxDraft.trim() === '' ? '' : normaliseBaseUrl(searxDraft);
            if (url === null) new Notice('Lektor: enter an http:// or https:// address.');
            else void this.apply({ tools: { searxngUrl: url } }).then(() => this.display());
          }),
        );
    }

    if (t.searchProvider !== 'none') {
      new Setting(containerEl)
        .setName('Results per search')
        .addSlider((slider) =>
          slider
            .setLimits(1, 20, 1)
            .setValue(t.resultCount)
            .setDynamicTooltip()
            .onChange((value) => void this.apply({ tools: { resultCount: value } })),
        );
      new Setting(containerEl).setName('Safe search').addDropdown((dropdown) =>
        dropdown
          .addOptions({ off: 'Off', moderate: 'Moderate', strict: 'Strict' })
          .setValue(t.safeSearch)
          .onChange((value) => void this.apply({ tools: { safeSearch: value as SafeSearch } })),
      );
      new Setting(containerEl)
        .setName('Region')
        .setDesc('Passed to the provider as-is, e.g. "us" or "de" (Brave, Exa), "de-de" (DuckDuckGo), "en" (SearXNG). Leave empty for the default.')
        .addText((text) =>
          text
            .setPlaceholder('')
            .setValue(t.region)
            .onChange((value) => void this.apply({ tools: { region: value.trim() } }, false)),
        );
    }

    new Setting(containerEl)
      .setName('Page size limit')
      .setDesc('Fetched pages are cut to about this many tokens before the model sees them.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text
          .setValue(String(t.fetchMaxTokens))
          .onChange((value) => {
            const n = Number(value);
            if (Number.isInteger(n) && n >= 500 && n <= 32000) void this.apply({ tools: { fetchMaxTokens: n } }, false);
          });
      });

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

    new Setting(containerEl)
      .setName('AI edit history')
      .setDesc('Every change you accept is logged per note (Lektor: AI edit history, in a note’s menu), so you can revert it later. The log keeps the changed text.')
      .addButton((button) =>
        button
          .setButtonText('Clear all…')
          .setWarning()
          .onClick(() => {
            void confirm(this.app, {
              title: 'Clear all AI edit history?',
              body: 'This deletes the record of every change Lektor made to any note. Your notes are not changed. It cannot be undone.',
              action: 'Clear all',
            }).then(async (ok) => {
              if (!ok) return;
              await this.host.clearEditHistory();
              new Notice('Lektor: AI edit history cleared.');
            });
          }),
      );

    // Presets
    renderPresetSettings(
      this.app,
      containerEl,
      {
        presets: this.host.presets,
        folder: `${this.host.manifest.dir ?? '<plugin folder>'}/presets`,
        hidden: () => this.host.settingsStore.settings.presets.hidden,
        setHidden: async (ids) => {
          await this.apply({ presets: { hidden: [...ids] } });
          this.host.presets.refresh();
        },
      },
      () => this.display(),
    );

    // Privacy
    new Setting(containerEl).setName('Privacy').setHeading();

    new Setting(containerEl)
      .setName('Store full transcripts')
      .setDesc(
        'Chat history records which notes were sent (paths and fingerprints), not their text. Turn this on to also keep the context text sent with each reply. ' +
          "Either way, your messages, the model's replies and its thinking are kept, and replies may quote your notes. " +
          'When you delete a note, Lektor offers to delete the chats that sent it.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(s.privacy.storeFullTranscripts)
          .onChange((value) => void this.apply({ privacy: { storeFullTranscripts: value } })),
      );
  }

  private async apply(patch: SettingsPatch, redisplayOnError = true): Promise<void> {
    const result = this.host.settingsStore.update(patch);
    if (!result.ok) {
      new Notice(`Lektor: ${result.problems[0]?.message ?? 'that value is not allowed.'}`);
      if (redisplayOnError) this.display();
      return;
    }
    await this.save();
  }

  private async saveOllamaUrl(text: string): Promise<void> {
    const url = normaliseBaseUrl(text);
    if (url === null) {
      new Notice('Lektor: enter an http:// or https:// address, such as http://127.0.0.1:11434.');
      return;
    }
    await this.apply({ models: { ollama: { ...this.host.settingsStore.settings.models.ollama, baseUrl: url } } });
    this.display();
    try {
      new Notice(`Lektor: ${await this.host.checkOllama()}`);
    } catch (err) {
      new Notice(`Lektor: could not reach Ollama at ${url}. ${err instanceof Error ? err.message : ''}`);
    }
  }

  private async saveExclusions(text: string): Promise<void> {
    const result = this.host.settingsStore.setExcludedFolders(text.split(/\r?\n/));
    if (!result.ok) {
      new Notice(`Lektor: ${result.problems[0]?.message ?? 'that list is not allowed.'}`);
      return;
    }
    if (await this.save()) {
      this.host.contextSettingsChanged();
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
