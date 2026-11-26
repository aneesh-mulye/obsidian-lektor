// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only file allowed to change notes (hard rule 1; eslint/gates.mjs G3,
 * INVARIANTS.md G8). It implements the core's EditApplier, and the core calls
 * it only from accept, create and revert actions the user clicked.
 *
 * If the note is open, the change goes through its editor, so Obsidian's own
 * undo (Ctrl+Z) works; otherwise through vault.process, which reads and
 * writes atomically.
 *
 * It also draws inline review in the editor (DESIGN.md § Inline review): marks,
 * ✓ / ✕ and the pill, all CodeMirror decorations that never change the text.
 * It reads the open editor's text only to place those marks and to tell the
 * review manager when the note changed; that text goes nowhere else. Every
 * transaction it dispatches carries effects only, never changes (G8).
 */

import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { type App, type Editor, MarkdownView, type Plugin, editorInfoField, setIcon } from 'obsidian';
import type { Mark } from '../core/review/rebase';
import type { EditApplier, Splice } from '../core/review/types';

/** What the user clicked in the editor. The implementation calls the review manager (G8). */
export interface InlineClicks {
  accept(proposalId: string, hunkId: string): void;
  reject(proposalId: string, hunkId: string): void;
  acceptAll(path: string): void;
  rejectAll(path: string): void;
  /** The amber dot: show the proposal's rebase panel. */
  showStale(path: string): void;
}

export interface InlinePill {
  pending: number;
  stale: number;
}

/** What inline review shows, from the chat open in the sidebar. */
export interface InlineSource {
  /** Marks for this note's text (none unless the open chat is in Inline mode). */
  marks(path: string, text: string): readonly Mark[];
  pill(path: string): InlinePill | null;
  /** A reason to show for a hunk (the model's), if any. */
  reason(proposalId: string, hunkId: string): string | undefined;
  subscribe(listener: () => void): () => void;
  /** The note's text in the editor changed (debounced; every undo and redo step at once), or the note was opened. */
  changed(path: string, text: string): void;
  clicks: InlineClicks;
}

const refresh = StateEffect.define<null>();
/** Debounce for telling the review manager about typing. */
const SETTLE_MS = 400;

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

  /** The note's text in an open editor, if it is open (it may be ahead of the disk). */
  editorText(path: string): string | null {
    return this.openEditor(path)?.getValue() ?? null;
  }

  /** Register inline review in every Markdown editor. */
  registerInline(plugin: Plugin, source: InlineSource): void {
    let views: EditorView[] = [];
    const pathOf = (view: EditorView) => view.state.field(editorInfoField, false)?.file?.path ?? null;

    const build = (view: EditorView): DecorationSet => {
      const path = pathOf(view);
      if (path === null) return Decoration.none;
      const ranges = [];
      for (const m of source.marks(path, view.state.doc.toString())) {
        if (m.from < m.to) ranges.push(Decoration.mark({ class: 'lektor-inline-del' }).range(m.from, m.to));
        ranges.push(Decoration.widget({ widget: new HunkWidget(m, source.reason(m.proposalId, m.hunkId), source.clicks), side: 1 }).range(m.to));
      }
      return Decoration.set(ranges, true);
    };

    // The marks: rebuilt from the source on `setDeco`, carried through typing in between.
    const setDeco = StateEffect.define<{ path: string | null; deco: DecorationSet }>();
    const marks = StateField.define<{ path: string | null; deco: DecorationSet }>({
      create: () => ({ path: null, deco: Decoration.none }),
      update(value, tr) {
        for (const e of tr.effects) if (e.is(setDeco)) return e.value;
        const path = tr.state.field(editorInfoField, false)?.file?.path ?? null;
        // Another note in the same editor: nothing carries over until the rebuild.
        if (path !== value.path) return { path, deco: Decoration.none };
        return tr.docChanged ? { path, deco: value.deco.map(tr.changes) } : value;
      },
      provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
    });

    /** Recompute the marks and pill for one editor. Effects only, and never inside another update. */
    const redraw = (view: EditorView) => {
      view.dispatch({ effects: [setDeco.of({ path: pathOf(view), deco: build(view) }), refresh.of(null)] });
    };

    const plugin_ = ViewPlugin.fromClass(
      class {
        readonly pill: HTMLElement;
        timer: number | null = null;
        path: string | null = null;
        constructor(readonly view: EditorView) {
          views = [...views, view];
          this.pill = view.dom.createDiv({ cls: 'lektor-inline-pill' });
          this.settle(0);
        }
        update(u: ViewUpdate) {
          const path = pathOf(this.view);
          if (path !== this.path) {
            this.path = path;
            this.settle(0);
          } else if (u.docChanged) {
            // Each undo and redo step is reported at once, with the text it left, so an accepted change that
            // Ctrl+Z took out goes back to pending (INVARIANTS.md B6). Typing is reported once it settles.
            const steps = u.transactions.filter((t) => t.docChanged && (t.isUserEvent('undo') || t.isUserEvent('redo'))).map((t) => t.state.doc.toString());
            if (path !== null && steps.length > 0) {
              // Never inside the update: the review may change cards, which redraws the editors.
              window.setTimeout(() => {
                for (const text of steps) source.changed(path, text);
              }, 0);
            }
            this.settle(SETTLE_MS);
          }
          if (u.transactions.some((t) => t.effects.some((e) => e.is(refresh)))) this.render();
        }
        /** Tell the manager (it may rebase), then redraw from the source. */
        settle(ms: number) {
          if (this.timer !== null) window.clearTimeout(this.timer);
          this.timer = window.setTimeout(() => {
            this.timer = null;
            const path = pathOf(this.view);
            if (path !== null) source.changed(path, this.view.state.doc.toString());
            redraw(this.view);
          }, ms);
        }
        render() {
          const path = pathOf(this.view);
          const pill = path === null ? null : source.pill(path);
          renderPill(this.pill, pill, path, source.clicks);
        }
        destroy() {
          if (this.timer !== null) window.clearTimeout(this.timer);
          this.pill.detach();
          views = views.filter((v) => v !== this.view);
        }
      },
    );

    const extension: Extension = [marks, plugin_];
    plugin.registerEditorExtension(extension);
    const unsubscribe = source.subscribe(() => {
      // Never inside another update: the source can change because of an editor transaction.
      window.setTimeout(() => {
        for (const v of views) redraw(v);
      }, 0);
    });
    plugin.register(unsubscribe);
  }

  private openEditor(path: string): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) return leaf.view.editor;
    }
    return null;
  }
}

/** The inserted text and ✓ / ✕, at the end of a hunk. */
class HunkWidget extends WidgetType {
  constructor(
    readonly mark: Mark,
    readonly reason: string | undefined,
    readonly clicks: InlineClicks,
  ) {
    super();
  }

  override eq(other: HunkWidget): boolean {
    return other.mark.hunkId === this.mark.hunkId && other.mark.insert === this.mark.insert && other.reason === this.reason;
  }

  toDOM(): HTMLElement {
    const wrap = createSpan({ cls: 'lektor-inline-hunk' });
    if (this.mark.insert !== '') wrap.createEl('ins', { cls: 'lektor-inline-ins', text: this.mark.insert });
    const { proposalId, hunkId } = this.mark;
    const button = (icon: string, label: string, onClick: () => void) => {
      const b = wrap.createEl('button', { cls: 'lektor-inline-button clickable-icon', attr: { 'aria-label': label, type: 'button' } });
      setIcon(b, icon);
      b.onmousedown = (ev) => ev.preventDefault(); // keep the cursor where it is
      b.onclick = (ev) => {
        ev.preventDefault();
        onClick();
      };
    };
    button('check', this.reason ? `Accept: ${this.reason}` : 'Accept this change', () => this.clicks.accept(proposalId, hunkId));
    button('x', 'Reject this change', () => this.clicks.reject(proposalId, hunkId));
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** "3 pending · Accept all · Reject all" and the staleness dot, at the top right of the editor. */
function renderPill(el: HTMLElement, pill: InlinePill | null, path: string | null, clicks: InlineClicks): void {
  el.empty();
  el.toggleClass('is-hidden', pill === null || path === null);
  if (pill === null || path === null) return;
  const dot = el.createEl('button', {
    cls: `lektor-dot clickable-icon${pill.stale > 0 ? ' is-stale' : ''}`,
    attr: { type: 'button', 'aria-label': pill.stale > 0 ? `${pill.stale} change${pill.stale === 1 ? '' : 's'} no longer fit the note. Click to review.` : 'All proposed changes still fit the note' },
  });
  if (pill.stale > 0) dot.onclick = () => clicks.showStale(path);
  el.createSpan({ cls: 'lektor-inline-count', text: `${pill.pending} pending` });
  const all = el.createEl('button', { cls: 'lektor-inline-all', text: 'Accept all', attr: { type: 'button' } });
  all.onclick = () => clicks.acceptAll(path);
  const none = el.createEl('button', { cls: 'lektor-inline-all', text: 'Reject all', attr: { type: 'button' } });
  none.onclick = () => clicks.rejectAll(path);
}
