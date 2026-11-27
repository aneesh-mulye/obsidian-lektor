// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The context chips above the composer (DESIGN.md § Context system, § UI). */

import { Menu } from 'obsidian';
import { type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ContextController } from '../../core/chat/ContextController';
import { toRequestMessages } from '../../core/chat/transcript';
import type { Chat } from '../../core/chat/types';
import { attachmentTokens, planContext, planTokens } from '../../core/context/plan';
import type { Chip, Depth, NoteChip } from '../../core/context/state';
import { ATTACHMENT_MODES, type AttachmentMode } from '../../core/settings';
import { MESSAGE_OVERHEAD, estimateTokens, formatTokens, replyReserve } from '../../core/context/tokens';
import { Icon, IconButton } from './Icon';

export interface SelectionOffer {
  subscribe: (listener: () => void) => () => void;
  get: () => { path: string; length: number } | null;
}

export interface ContextUi {
  controller: ContextController;
  /** Re-render when the vault index changes. */
  index: { subscribe: (listener: () => void) => () => void; version: () => number };
  selection: SelectionOffer;
  /** Open the note picker; `picked` runs after a note is added. */
  pickNote: (picked?: () => void) => void;
  pickFolder: () => void;
  /** Open the attachment picker. */
  pickFile: () => void;
  addSelection: () => void;
  /** Handle notes or folders dropped on the sidebar. */
  drop: () => void;
  maxDepth: () => Depth;
}

const titleOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const isImage = (p: string) => /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(p);

const MODE_TITLES: Record<AttachmentMode, string> = {
  ask: 'Ask: the model asks for each attachment',
  allowed: 'Allowed: attachments linked from notes in context, without asking',
  upfront: 'Upfront: send attachments linked from notes in context',
};
const MODE_SHORT: Record<AttachmentMode, string> = { ask: 'Ask', allowed: 'Allowed', upfront: 'Upfront' };
/** Roughly what the markers around each item add. */
const FRAMING = 60;

function chipLabel(c: Chip): string {
  if (c.kind === 'note') return titleOf(c.path);
  if (c.kind === 'folder') return `${c.path.slice(c.path.lastIndexOf('/') + 1)}/${c.recursive ? '**' : ''}`;
  if (c.kind === 'attachment') return nameOf(c.path);
  return `Selection · ${titleOf(c.path)}`;
}

function chipIcon(c: Chip): string {
  if (c.kind === 'folder') return 'folder';
  if (c.kind === 'selection') return 'text-cursor-input';
  if (c.kind === 'attachment') return isImage(c.path) ? 'image' : 'paperclip';
  return c.current ? 'crosshair' : 'file-text';
}

export function ContextBar(props: { ui: ContextUi; chat: Chat; window: number | null; images: boolean | null; calibration: number }) {
  const { ui, chat, window, images, calibration } = props;
  useSyncExternalStore(ui.index.subscribe, ui.index.version);
  const offer = useSyncExternalStore(ui.selection.subscribe, ui.selection.get);
  const [depthFor, setDepthFor] = useState<string | null>(null);
  const { controller } = ui;
  const index = controller.index;
  const state = chat.context;

  const plan = controller.plan();
  const items = plan.notes.length + plan.selections.length + plan.attachments.length;
  const contextTokens =
    items > 0
      ? planTokens(plan, index) + plan.selections.reduce((t, s) => t + estimateTokens(s.text), 0) + FRAMING * (items + plan.backlinkLists.length + plan.attachmentLists.length)
      : 0;
  const mode = controller.attachmentMode;
  const overridden = state.attachmentMode !== undefined;
  // What can't be sent to this model, as far as is known before reading (DESIGN.md § Embeds and attachments).
  const unsendable = new Map<string, string>();
  for (const a of plan.attachments) {
    const check = index.converters.check(a.path, a.size, { images: images ?? true });
    if (!check.ok) unsendable.set(a.path, check.reason);
  }
  const linked = plan.attachments.filter((a) => a.via === 'linked');
  const transcript = toRequestMessages(chat.messages).reduce((t, m) => t + estimateTokens(m.content) + MESSAGE_OVERHEAD, 0);
  const total = Math.ceil((contextTokens + transcript) * calibration);
  const level = window === null ? '' : total + replyReserve(window) > window ? ' is-over' : total > window * 0.8 ? ' is-warn' : '';
  const lastActual = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.usage?.inputTokens !== undefined);
  const actual = lastActual?.role === 'assistant' ? lastActual.usage?.inputTokens : undefined;

  const openAddMenu = (ev: MouseEvent<HTMLButtonElement>) => {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('Note…').setIcon('file-text').onClick(() => ui.pickNote()));
    menu.addItem((i) => i.setTitle('Folder…').setIcon('folder').onClick(ui.pickFolder));
    menu.addItem((i) => i.setTitle('Attachment…').setIcon('paperclip').onClick(ui.pickFile));
    menu.addItem((i) => i.setTitle('Selection').setIcon('text-cursor-input').setDisabled(offer === null).onClick(ui.addSelection));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Follow the current note').setChecked(state.followActive).onClick(() => controller.setFollow(!state.followActive)));
    menu.showAtMouseEvent(ev.nativeEvent);
  };

  const openModeMenu = (ev: MouseEvent<HTMLButtonElement>) => {
    const menu = new Menu();
    for (const m of ATTACHMENT_MODES) menu.addItem((i) => i.setTitle(MODE_TITLES[m]).setChecked(overridden && mode === m).onClick(() => controller.setAttachmentMode(m)));
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(`Use the default (${MODE_SHORT[controller.defaultAttachmentMode]})`)
        .setChecked(!overridden)
        .onClick(() => controller.setAttachmentMode(undefined)),
    );
    menu.showAtMouseEvent(ev.nativeEvent);
  };

  const chipTokens = (c: Chip) => {
    if (c.kind === 'selection') return c.text === undefined ? 0 : estimateTokens(c.text);
    if (c.kind === 'attachment') {
      const meta = index.attachment(c.path);
      return meta && !unsendable.has(c.path) ? attachmentTokens(index, c.path, meta.size) : 0;
    }
    return planTokens(planContext({ followActive: false, chips: [c] }, index), index);
  };
  const chipTitle = (c: Chip) => {
    if (c.kind === 'note' && c.changed) return `${c.path} — changed since it was last sent`;
    if (c.kind === 'attachment') {
      const why = unsendable.get(c.path);
      return why ? `${c.path} — won’t be sent: ${why}` : c.path + (c.changed ? ' — changed since it was last sent' : '');
    }
    return c.path;
  };

  return (
    <div className="lektor-context">
      <div className="lektor-chips">
        {state.chips.map((c) => (
          <span key={c.id} className={`lektor-chip${c.kind === 'note' && c.current ? ' is-current' : ''}${unsendable.has(c.path) && c.kind === 'attachment' ? ' is-unsendable' : ''}`}>
            <span className="lektor-chip-main" aria-label={chipTitle(c)} data-tooltip-position="top">
              <Icon name={chipIcon(c)} />
              <span className="lektor-chip-name">{chipLabel(c)}</span>
              {(c.kind === 'note' || c.kind === 'attachment') && c.changed && <span className="lektor-chip-changed" />}
              <span className="lektor-chip-tokens">{formatTokens(chipTokens(c))}</span>
            </span>
            {c.kind === 'note' && (
              <button
                type="button"
                className="lektor-chip-depth clickable-icon"
                aria-label={`Link depth ${c.depth}${c.backlinkContents ? ', with backlink contents' : ''}`}
                data-tooltip-position="top"
                onClick={() => setDepthFor(depthFor === c.id ? null : c.id)}
              >
                {`↳${c.depth}${c.backlinkContents ? '+' : ''}`}
              </button>
            )}
            {c.kind === 'folder' && (
              <IconButton
                icon={c.recursive ? 'folder-tree' : 'folder-closed'}
                label={c.recursive ? 'Including subfolders (click for this folder only)' : 'This folder only (click to include subfolders)'}
                onClick={() => controller.setRecursive(c.id, !c.recursive)}
              />
            )}
            {c.kind === 'note' && c.current && <IconButton icon="pin" label="Keep this note when you switch notes" onClick={() => controller.pin(c.id)} />}
            <IconButton icon="x" label={c.kind === 'note' && c.current ? 'Remove (and stop following the current note)' : 'Remove'} onClick={() => controller.remove(c.id)} />
            {depthFor === c.id && c.kind === 'note' && (
              <DepthMenu chip={c} ui={ui} window={window} otherTokens={total - Math.ceil(chipTokens(c) * calibration)} calibration={calibration} onClose={() => setDepthFor(null)} />
            )}
          </span>
        ))}
        {linked.map((a) => {
          const why = unsendable.get(a.path);
          return (
            <span key={`linked:${a.path}`} className={`lektor-chip is-linked${why ? ' is-unsendable' : ''}`}>
              <span
                className="lektor-chip-main"
                aria-label={`${a.path} — sent because ${a.from ?? 'a note in context'} links to it (Upfront)${why ? `; won’t be sent: ${why}` : ''}`}
                data-tooltip-position="top"
              >
                <Icon name={isImage(a.path) ? 'image' : 'paperclip'} />
                <span className="lektor-chip-name">{nameOf(a.path)}</span>
                <span className="lektor-chip-tokens">{formatTokens(why ? 0 : attachmentTokens(index, a.path, a.size))}</span>
              </span>
              <IconButton icon="x" label="Keep this attachment out of this chat" onClick={() => controller.withhold(a.path)} />
            </span>
          );
        })}
        {offer !== null && !state.chips.some((c) => c.kind === 'selection' && c.path === offer.path && c.to - c.from === offer.length) && (
          <button type="button" className="lektor-chip lektor-chip-offer" onClick={ui.addSelection}>
            <Icon name="plus" />
            {`Add selection (${offer.length} chars)`}
          </button>
        )}
        <IconButton icon="plus" label="Add context" onClick={openAddMenu} />
        <button
          type="button"
          className={`lektor-attachment-mode clickable-icon${overridden ? ' is-override' : ''}`}
          aria-label={`Attachments: ${MODE_TITLES[mode]}${overridden ? ' (this chat)' : ' (the default)'}`}
          data-tooltip-position="top"
          onClick={openModeMenu}
        >
          <Icon name="paperclip" />
          {overridden && <span className="lektor-attachment-mode-name">{MODE_SHORT[mode]}</span>}
        </button>
        <span
          className={`lektor-token-total${level}`}
          aria-label={`Estimated tokens for the next message, against the model's context length.${actual !== undefined ? ` Ollama counted ${actual.toLocaleString()} for the last one.` : ''}`}
          data-tooltip-position="top"
        >
          {`≈${formatTokens(total)}${window ? ` / ${formatTokens(window)}` : ''}`}
        </span>
      </div>
      {plan.excluded.size > 0 && <div className="lektor-context-note">{excludedLine(plan.excluded)}</div>}
      {unsendable.size > 0 && (
        <div className="lektor-context-note">
          {`Won’t be sent: ${[...unsendable].map(([p, why]) => `${nameOf(p)} (${why})`).join('; ')}`}
        </div>
      )}
      {index.problem !== null && <div className="lektor-context-warning">{`Lektor is sharing no notes: ${index.problem}`}</div>}
    </div>
  );
}

function excludedLine(excluded: ReadonlySet<string>): string {
  const n = excluded.size;
  const notes = [...excluded].every((p) => p.toLowerCase().endsWith('.md'));
  return `${n} excluded ${notes ? (n === 1 ? 'note' : 'notes') : n === 1 ? 'item' : 'items'} skipped`;
}

function DepthMenu(props: { chip: NoteChip; ui: ContextUi; window: number | null; otherTokens: number; calibration: number; onClose: () => void }) {
  const { chip, ui, window, otherTokens, calibration, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // The document this popover is in (the main window or a popout).
    const doc = ref.current?.ownerDocument ?? activeDocument;
    doc.addEventListener('mousedown', away);
    doc.addEventListener('keydown', esc);
    return () => {
      doc.removeEventListener('mousedown', away);
      doc.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const previews = ui.controller.previews(chip.id);
  const over = (tokens: number) => window !== null && otherTokens + Math.ceil(tokens * calibration) + replyReserve(window) > window;
  return (
    <div className="lektor-depth-menu" ref={ref} role="dialog" aria-label="Link depth">
      <div className="lektor-depth-head">Follow links from this note</div>
      {previews.map((p) => {
        const tokens = p.tokens + (chip.backlinkContents ? p.backlinkContentTokens : 0);
        return (
          <button
            key={p.depth}
            type="button"
            className={`lektor-depth-row${p.depth === chip.depth ? ' is-active' : ''}${over(tokens) ? ' is-over' : ''}`}
            onClick={() => ui.controller.setDepth(chip.id, p.depth)}
          >
            <span className="lektor-depth-level">{p.depth === 0 ? 'This note' : `Depth ${p.depth}`}</span>
            <span>{p.depth === 0 ? '' : `+${p.notes} ${p.notes === 1 ? 'note' : 'notes'}`}</span>
            <span>{`≈${formatTokens(tokens)}`}</span>
            <span>{`${p.backlinksListed} ${p.backlinksListed === 1 ? 'backlink' : 'backlinks'} listed`}</span>
            <span>{`+${formatTokens(p.backlinkContentTokens)} with their contents`}</span>
            {p.excluded > 0 && <span className="lektor-depth-excluded">{`${p.excluded} excluded, not sent`}</span>}
          </button>
        );
      })}
      <label className="lektor-depth-backlinks">
        <input type="checkbox" checked={chip.backlinkContents} onChange={(e) => ui.controller.setBacklinkContents(chip.id, e.target.checked)} />
        Include backlink contents
      </label>
    </div>
  );
}
