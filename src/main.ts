// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Notice, Plugin, debounce } from 'obsidian';
import { ChatHistory } from './core/chat/history';
import { ChatManager } from './core/chat/manager';
import type { Depth } from './core/context/state';
import { OllamaProvider } from './core/providers/ollama';
import type { ChatProvider } from './core/providers/types';
import { SettingsStore } from './core/settings';
import { confirm } from './obsidian/ConfirmModal';
import { ContextBroker } from './obsidian/ContextBroker';
import { FetchHttpClient, RequestUrlHttpClient } from './obsidian/Http';
import { readabilityExtractor } from './obsidian/HtmlExtractor';
import { ToolRegistry } from './core/tools/registry';
import { toolRuns } from './core/tools/run';
import { searchProvider } from './core/tools/search';
import { type SearchSetup, fetchPageTool, webSearchTool } from './core/tools/web';
import { EditLog } from './core/review/log';
import { ReviewManager } from './core/review/manager';
import { fencedEdits, proposeEditTool, proposeNoteTool } from './core/review/tools';
import { EditHistoryModal } from './obsidian/EditHistoryModal';
import { ReviewController } from './obsidian/ReviewController';
import { inlineSource, watchStaleness } from './obsidian/InlineReview';
import { focusProposal } from './obsidian/ui/Review';
import { LektorView, VIEW_TYPE_LEKTOR } from './obsidian/LektorView';
import { FolderPicker, NotePicker } from './obsidian/Pickers';
import { PluginStorage } from './obsidian/PluginStorage';
import { LektorSettingTab } from './obsidian/SettingsTab';
import type { ContextUi } from './obsidian/ui/ContextBar';

export default class LektorPlugin extends Plugin {
  editLog!: EditLog;
  private review!: ReviewManager;
  // Not `settings`: Obsidian 1.13+ declares Plugin.settings for raw loaded data.
  settingsStore: SettingsStore = SettingsStore.load(null);
  ollama!: OllamaProvider;
  private chats!: ChatManager;
  private broker!: ContextBroker;

  override async onload(): Promise<void> {
    this.settingsStore = SettingsStore.load(await this.loadData());
    if (this.settingsStore.problems.length > 0) {
      new Notice('Lektor: some saved settings could not be read. Open Settings → Lektor to review them.');
    }
    const settings = () => this.settingsStore.settings;
    const notice = (message: string) => new Notice(`Lektor: ${message}`);

    const http = new FetchHttpClient();
    this.ollama = new OllamaProvider(http, () => settings().models.ollama.baseUrl, () => settings().models.ollama.contextLength);
    const providers: ChatProvider[] = [this.ollama];
    const byId = new Map(providers.map((p) => [p.id, p]));

    this.broker = new ContextBroker(this.app, {
      patterns: () => settings().context.excludedFolders,
      respectObsidian: () => settings().context.respectObsidianExclusions,
    });

    // Tools (DESIGN.md § Tools framework). Keys are read from SecretStorage by name, only when a search runs.
    const toolHttp = new RequestUrlHttpClient();
    const searchSetup = (): SearchSetup | null => {
      const t = settings().tools;
      const provider = searchProvider(t.searchProvider);
      if (!provider) return null;
      const secretName = provider.id === 'tavily' || provider.id === 'exa' || provider.id === 'brave' ? t.secrets[provider.id] : '';
      const key = secretName ? (this.app.secretStorage.getSecret(secretName) ?? '') : '';
      return {
        provider,
        options: { count: t.resultCount, safe: t.safeSearch, region: t.region },
        auth: { ...(key ? { key } : {}), ...(t.searxngUrl ? { baseUrl: t.searxngUrl } : {}) },
      };
    };
    const storage = new PluginStorage(this.app, this.manifest.dir);
    const history = new ChatHistory(storage);
    const newId = () => crypto.randomUUID();

    // Review (DESIGN.md § Edits and diff review): models propose; only a click applies, through ReviewController.
    const editLog = new EditLog(storage, newId);
    this.editLog = editLog;
    const controller = new ReviewController(this.app);
    const review = new ReviewManager({
      applier: controller,
      log: editLog,
      readNote: (path) => this.broker.index.read(path),
      editorText: (path) => controller.editorText(path),
      clock: { now: () => Date.now() },
    });
    this.review = review;
    const reviewDeps = {
      readNote: (path: string) => this.broker.index.read(path),
      isExcluded: (path: string) => this.broker.index.isExcluded(path),
      exists: (path: string) => this.broker.exists(path),
      newId,
      now: () => Date.now(),
    };

    const registry = new ToolRegistry();
    registry.register(webSearchTool(searchSetup, toolHttp));
    registry.register(fetchPageTool(toolHttp, readabilityExtractor, () => settings().tools.fetchMaxTokens));
    registry.register(proposeEditTool(reviewDeps));
    registry.register(proposeNoteTool(reviewDeps));
    const tools = toolRuns(registry, {
      webNames: () => [...(settings().tools.searchProvider !== 'none' ? ['web_search'] : []), 'fetch_page'],
      // Prose mode chats get no edit tools (DESIGN.md § Display modes; toolRuns checks the chat's mode).
      reviewNames: () => ['propose_edit', 'propose_note'],
      displayMode: () => settings().review.defaultDisplayMode,
      limits: () => ({ searches: settings().tools.searchesPerMessage, fetches: settings().tools.fetchesPerMessage }),
      fenced: (editable, model) => fencedEdits(reviewDeps, editable, model),
    });

    this.chats = new ChatManager({
      providers: { get: (id) => byId.get(id) },
      clock: { now: () => Date.now() },
      newId: () => crypto.randomUUID(),
      history,
      tools,
      defaultModel: () => settings().models.defaultModel ?? null,
      setDefaultModel: async (model) => {
        if (this.settingsStore.update({ models: { defaultModel: model } }).ok) await this.saveSettings();
      },
      onError: (message, err) => {
        if (err !== undefined) console.error(`Lektor: ${message}`, err);
        notice(message);
      },
      context: {
        index: this.broker.index,
        activeNote: () => this.broker.activeNote(),
        newId: () => crypto.randomUUID(),
        maxDepth: () => settings().context.maxLinkDepth as Depth,
        onNotice: notice,
      },
      storeFullTranscripts: () => settings().privacy.storeFullTranscripts,
      defaultDisplayMode: () => settings().review.defaultDisplayMode,
    });
    const context = this.chats.context!;

    // Inline review and staleness (DESIGN.md § Staleness and rebase): only the chat open in the sidebar.
    const inlineDeps = {
      chats: this.chats,
      review,
      defaultMode: () => settings().review.defaultDisplayMode,
      editorText: (path: string) => controller.editorText(path),
      readNote: (path: string) => this.broker.index.read(path),
      showProposal: (id: string) => {
        focusProposal(id);
        void this.activateView();
      },
    };
    controller.registerInline(this, inlineSource(inlineDeps));
    const staleness = watchStaleness(inlineDeps);
    this.register(staleness.dispose);

    // Keep the index and the chips in step with the vault.
    this.broker.watch(
      this,
      () => context.vaultChanged(),
      (from, to) => {
        this.broker.refresh();
        context.renamed(from, to);
        review.renamed(this.chats.session, from, to);
        void editLog.renamed(from, to);
      },
      (path) => void this.offerCleanup(history, editLog, path),
      (path) => staleness.modified(path),
    );
    this.app.workspace.onLayoutReady(() => {
      this.broker.refresh();
      context.vaultChanged();
    });

    // The current-note chip and the "Add selection" offer.
    let offer: { path: string; length: number } | null = null;
    const offerListeners = new Set<() => void>();
    const updateOffer = () => {
      const next = this.broker.selectionInfo();
      if (next?.path !== offer?.path || next?.length !== offer?.length) {
        offer = next;
        for (const l of offerListeners) l();
      }
    };
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        context.activeChanged();
        updateOffer();
      }),
    );
    this.registerDomEvent(document, 'selectionchange', debounce(updateOffer, 150, true));

    const addSelection = async () => {
      const selection = await this.broker.selection();
      if (selection) context.addSelection(selection);
      else notice('Select some text in a note first. (Notes in excluded folders cannot be added.)');
    };
    const pickNote = (picked?: () => void) =>
      new NotePicker(this.app, this.broker.index.notes(), (n) => {
        context.addNote(n.path);
        picked?.();
      }).open();
    const pickFolder = () => new FolderPicker(this.app, this.broker.index.folders(), (f) => context.addFolder(f, false)).open();

    const contextUi: ContextUi = {
      controller: context,
      index: { subscribe: this.broker.subscribe, version: this.broker.version },
      selection: {
        subscribe: (l) => {
          offerListeners.add(l);
          return () => offerListeners.delete(l);
        },
        get: () => offer,
      },
      pickNote,
      pickFolder,
      addSelection: () => void addSelection(),
      drop: () => {
        const dropped = this.broker.dropped();
        for (const n of dropped.notes) context.addNote(n);
        for (const f of dropped.folders) context.addFolder(f, false);
        if (dropped.excluded > 0) notice(`${dropped.excluded} excluded item${dropped.excluded === 1 ? ' was' : 's were'} not added.`);
      },
      maxDepth: () => settings().context.maxLinkDepth as Depth,
    };

    const clearAllChats = async () => {
      const ok = await confirm(this.app, {
        title: 'Clear all chats?',
        body: 'This deletes every saved Lektor chat. It cannot be undone.',
        action: 'Delete all',
      });
      if (ok) await this.chats.clearAll();
    };

    this.registerView(
      VIEW_TYPE_LEKTOR,
      (leaf) =>
        new LektorView(leaf, {
          manager: this.chats,
          providers,
          clearAllChats,
          context: contextUi,
          searchConfigured: () => settings().tools.searchProvider !== 'none',
          review: {
            manager: review,
            openNote: (path) => void this.app.workspace.openLinkText(path, '', false),
            defaultMode: () => settings().review.defaultDisplayMode,
          },
        }),
    );
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
    this.addCommand({
      id: 'add-selection',
      name: 'Add selection to context',
      checkCallback: (checking) => {
        if (this.broker.selectionInfo() === null) return false;
        if (!checking) void addSelection().then(() => this.activateView());
        return true;
      },
    });
    this.addCommand({ id: 'add-current-note', name: 'Add current note to context', callback: () => context.addActiveNote() });
    this.addCommand({ id: 'add-note', name: 'Add note to context…', callback: () => pickNote() });
    this.addCommand({ id: 'add-folder', name: 'Add folder to context…', callback: pickFolder });
    const showHistory = (path: string | null) => {
      if (path === null) notice('Open a note first.');
      else new EditHistoryModal(this.app, path, editLog, review).open();
    };
    this.addCommand({ id: 'show-ai-history', name: 'Show AI edit history for this note', callback: () => showHistory(this.broker.activeNote()) });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!file.path.toLowerCase().endsWith('.md')) return;
        menu.addItem((item) => item.setTitle('Lektor: AI edit history').setIcon('history').onClick(() => showHistory(file.path)));
      }),
    );
    this.addSettingTab(new LektorSettingTab(this.app, this));
  }

  override onunload(): void {
    this.chats?.dispose();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settingsStore.toData());
  }

  /** Exclusion or link-depth settings changed: rebuild the index and re-check every chip. */
  contextSettingsChanged(): void {
    this.broker.refresh();
    this.chats.context?.vaultChanged();
    this.chats.context?.settingsChanged();
  }

  /**
   * A note was deleted. Replies may have quoted it, and the AI edit history holds text from it,
   * so offer to delete the chats that sent it and to clear its edit history (DESIGN.md § Decided).
   */
  private async offerCleanup(history: ChatHistory, editLog: EditLog, path: string): Promise<void> {
    const ids = await history.chatsSending(path);
    const hasLog = await editLog.hasHistory(path);
    if (ids.length === 0 && !hasLog) return;
    const chats = ids.length === 1 ? '1 chat' : `${ids.length} chats`;
    const fragment = createFragment((f) => {
      f.appendText(`Lektor: ${path} was deleted. `);
      if (ids.length > 0) {
        f.appendText(`${chats} sent it to a model, and replies may quote it. `);
        const button = f.createEl('button', { text: `Delete ${chats}…` });
        button.onclick = () => {
          void confirm(this.app, {
            title: `Delete ${chats}?`,
            body: `These chats sent ${path} to a model. Deleting them removes any quotes of it from Lektor's chat history.`,
            action: 'Delete',
          }).then(async (ok) => {
            if (!ok) return;
            for (const id of ids) await this.chats.delete(id);
            new Notice(`Lektor: deleted ${chats}.`);
          });
        };
      }
      if (hasLog) {
        f.appendText(' Its AI edit history holds text from it. ');
        const button = f.createEl('button', { text: 'Clear its edit history…' });
        button.onclick = () => {
          void confirm(this.app, {
            title: 'Clear AI edit history?',
            body: `This deletes the record of every change Lektor made to ${path}.`,
            action: 'Clear',
          }).then(async (ok) => {
            if (!ok) return;
            await editLog.clear(path);
            new Notice('Lektor: edit history cleared.');
          });
        };
      }
    });
    new Notice(fragment, 20000);
  }

  /** Clear all AI edit history (settings button, after confirmation). */
  async clearEditHistory(): Promise<void> {
    await this.editLog.clearAll();
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
