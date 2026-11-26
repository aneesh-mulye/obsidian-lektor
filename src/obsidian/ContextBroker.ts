// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only file allowed to read the vault (hard rule 2; eslint/gates.mjs G2).
 *
 * It supplies the raw vault to the core's ContextIndex and hands out only
 * that filtered index, so excluded notes are gone before anything else sees
 * the vault (DESIGN.md § Excluded folders). It also reads the editor
 * selection and works out what was dropped on the sidebar, always through
 * the same exclusion rules. It never writes.
 */

import { type App, type Component, MarkdownView, TFile, TFolder, debounce } from 'obsidian';
import { ContextIndex } from '../core/context/ContextIndex';
import { type Exclusions, compileExclusions } from '../core/context/exclusions';
import { sha256 } from '../core/context/prepare';
import type { CapturedSelection } from '../core/context/state';
import type { RawVault } from '../core/context/vault';

export interface BrokerSettings {
  patterns(): readonly string[];
  respectObsidian(): boolean;
}

interface DragManager {
  draggable?: { type?: string; file?: unknown; files?: unknown[] } | null;
}

export class ContextBroker {
  readonly index: ContextIndex;
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(
    private readonly app: App,
    private readonly settings: BrokerSettings,
  ) {
    const vault = app.vault;
    const raw: RawVault = {
      notes: () => vault.getMarkdownFiles().map((f) => ({ path: f.path, size: f.stat.size })),
      folders: () => vault.getAllFolders(false).map((f) => f.path),
      resolvedLinks: () => app.metadataCache.resolvedLinks,
      read: async (path) => {
        const file = vault.getFileByPath(path);
        if (!file) throw new Error(`${path} no longer exists.`);
        return vault.cachedRead(file);
      },
    };
    this.index = new ContextIndex(raw, () => this.exclusions());
    this.index.refresh();
  }

  /** Bumped whenever the index is rebuilt; for React. */
  readonly version = (): number => this.#version;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Rebuild the index (after a vault, link or exclusion-setting change) and tell listeners. */
  refresh(): void {
    this.index.refresh();
    this.#version += 1;
    for (const l of this.#listeners) l();
  }

  /** Keep the index up to date with the vault. `onRename` gets old and new paths. */
  watch(owner: Component, onChange: () => void, onRename: (from: string, to: string) => void): void {
    const changed = debounce(
      () => {
        this.refresh();
        onChange();
      },
      300,
      true,
    );
    owner.registerEvent(this.app.metadataCache.on('resolved', changed));
    owner.registerEvent(this.app.vault.on('create', changed));
    owner.registerEvent(this.app.vault.on('delete', changed));
    owner.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        onRename(oldPath, file.path);
        changed();
      }),
    );
  }

  /** The note open in the editor, or the most recently open one when the sidebar has focus. */
  activeNote(): string | null {
    return this.app.workspace.getActiveFile()?.path ?? null;
  }

  /** The selected text in the most recent editor, if its note may be shared. */
  async selection(): Promise<CapturedSelection | null> {
    const view = this.recentMarkdownView();
    if (!view?.file || !this.index.note(view.file.path)) return null;
    const editor = view.editor;
    const text = editor.getSelection();
    if (text === '') return null;
    return {
      path: view.file.path,
      text,
      from: editor.posToOffset(editor.getCursor('from')),
      to: editor.posToOffset(editor.getCursor('to')),
      hash: await sha256(text),
    };
  }

  /** Whether there is a shareable selection, and how long it is (for the "Add selection" offer). */
  selectionInfo(): { path: string; length: number } | null {
    const view = this.recentMarkdownView();
    if (!view?.file || !this.index.note(view.file.path)) return null;
    const length = view.editor.getSelection().length;
    return length > 0 ? { path: view.file.path, length } : null;
  }

  /** Notes and folders dragged from the file explorer. Excluded ones are left out (and counted). */
  dropped(): { notes: string[]; folders: string[]; excluded: number } {
    const drag = (this.app as unknown as { dragManager?: DragManager }).dragManager?.draggable;
    const items = drag?.files ?? (drag?.file ? [drag.file] : []);
    const out = { notes: [] as string[], folders: [] as string[], excluded: 0 };
    for (const item of items) {
      if (item instanceof TFile && item.extension === 'md') {
        if (this.index.note(item.path)) out.notes.push(item.path);
        else out.excluded += 1;
      } else if (item instanceof TFolder) {
        if (this.index.hasFolder(item.path)) out.folders.push(item.path);
        else out.excluded += 1;
      }
    }
    return out;
  }

  private recentMarkdownView(): MarkdownView | null {
    const { workspace } = this.app;
    const active = workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const leaf = workspace.getMostRecentLeaf(workspace.rootSplit);
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  private exclusions(): Exclusions {
    return compileExclusions({
      patterns: this.settings.patterns(),
      obsidianFilters: this.settings.respectObsidian() ? this.obsidianFilters() : null,
      configDir: this.app.vault.configDir,
    });
  }

  /** Obsidian's "Excluded files" (Settings → Files and links). Not in the public API, so read defensively. */
  private obsidianFilters(): readonly string[] | 'unreadable' {
    const getConfig = (this.app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig;
    if (typeof getConfig !== 'function') return 'unreadable';
    const value = getConfig.call(this.app.vault, 'userIgnoreFilters');
    if (value === undefined || value === null) return [];
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : 'unreadable';
  }
}
