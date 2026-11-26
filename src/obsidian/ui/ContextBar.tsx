// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The context chips above the composer (DESIGN.md § Context system, § UI). */

import { Menu } from 'obsidian';
import { type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ContextController } from '../../core/chat/ContextController';
import { toRequestMessages } from '../../core/chat/transcript';
import type { Chat } from '../../core/chat/types';
import { planContext, planTokens } from '../../core/context/plan';
import type { Chip, Depth, NoteChip } from '../../core/context/state';
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
  addSelection: () => void;
  /** Handle notes or folders dropped on the sidebar. */
  drop: () => void;
  maxDepth: () => Depth;
}

const titleOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
/** Roughly what the markers around each item add. */
const FRAMING = 60;

function chipLabel(c: Chip): string {
  if (c.kind === 'note') return titleOf(c.path);
  if (c.kind === 'folder') return `${c.path.slice(c.path.lastIndexOf('/') + 1)}/${c.recursive ? '**' : ''}`;
  return `Selection · ${titleOf(c.path)}`;
}

function chipIcon(c: Chip): string {
  if (c.kind === 'folder') return 'folder';
  if (c.kind === 'selection') return 'text-cursor-input';
  return c.current ? 'crosshair' : 'file-text';
}

export function ContextBar(props: { ui: ContextUi; chat: Chat; window: number | null; calibration: number }) {
  const { ui, chat, window, calibration } = props;
  useSyncExternalStore(ui.index.subscribe, ui.index.version);
  const offer = useSyncExternalStore(ui.selection.subscribe, ui.selection.get);
  const [depthFor, setDepthFor] = useState<string | null>(null);
  const { controller } = ui;
  const index = controller.index;
  const state = chat.context;

  const plan = planContext(state, index);
  const contextTokens = plan.notes.length + plan.selections.length > 0
    ? planTokens(plan) + plan.selections.reduce((t, s) => t + estimateTokens(s.text), 0) + FRAMING * (plan.notes.length + plan.backlinkLists.length + plan.selections.length)
    : 0;
  const transcript = toRequestMessages(chat.messages).reduce((t, m) => t + estimateTokens(m.content) + MESSAGE_OVERHEAD, 0);
  const total = Math.ceil((contextTokens + transcript) * calibration);
  const level = window === null ? '' : total + replyReserve(window) > window ? ' is-over' : total > window * 0.8 ? ' is-warn' : '';
  const lastActual = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.usage?.inputTokens !== undefined);
  const actual = lastActual?.role === 'assistant' ? lastActual.usage?.inputTokens : undefined;

  const openAddMenu = (ev: MouseEvent<HTMLButtonElement>) => {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('Note…').setIcon('file-text').onClick(() => ui.pickNote()));
    menu.addItem((i) => i.setTitle('Folder…').setIcon('folder').onClick(ui.pickFolder));
    menu.addItem((i) => i.setTitle('Selection').setIcon('text-cursor-input').setDisabled(offer === null).onClick(ui.addSelection));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Follow the current note').setChecked(state.followActive).onClick(() => controller.setFollow(!state.followActive)));
    menu.showAtMouseEvent(ev.nativeEvent);
  };

  const chipTokens = (c: Chip) => {
    if (c.kind === 'selection') return c.text === undefined ? 0 : estimateTokens(c.text);
    return planTokens(planContext({ followActive: false, chips: [c] }, index));
  };

  return (
    <div className="lektor-context">
      <div className="lektor-chips">
        {state.chips.map((c) => (
          <span key={c.id} className={`lektor-chip${c.kind === 'note' && c.current ? ' is-current' : ''}`}>
            <span className="lektor-chip-main" aria-label={c.path + (c.kind === 'note' && c.changed ? ' — changed since it was last sent' : '')} data-tooltip-position="top">
              <Icon name={chipIcon(c)} />
              <span className="lektor-chip-name">{chipLabel(c)}</span>
              {c.kind === 'note' && c.changed && <span className="lektor-chip-changed" />}
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
        {offer !== null && !state.chips.some((c) => c.kind === 'selection' && c.path === offer.path && c.to - c.from === offer.length) && (
          <button type="button" className="lektor-chip lektor-chip-offer" onClick={ui.addSelection}>
            <Icon name="plus" />
            {`Add selection (${offer.length} chars)`}
          </button>
        )}
        <IconButton icon="plus" label="Add context" onClick={openAddMenu} />
        <span
          className={`lektor-token-total${level}`}
          aria-label={`Estimated tokens for the next message, against the model's context length.${actual !== undefined ? ` Ollama counted ${actual.toLocaleString()} for the last one.` : ''}`}
          data-tooltip-position="top"
        >
          {`≈${formatTokens(total)}${window ? ` / ${formatTokens(window)}` : ''}`}
        </span>
      </div>
      {plan.excluded.size > 0 && (
        <div className="lektor-context-note">{plan.excluded.size === 1 ? '1 excluded note skipped' : `${plan.excluded.size} excluded notes skipped`}</div>
      )}
      {index.problem !== null && <div className="lektor-context-warning">{`Lektor is sharing no notes: ${index.problem}`}</div>}
    </div>
  );
}

function DepthMenu(props: { chip: NoteChip; ui: ContextUi; window: number | null; otherTokens: number; calibration: number; onClose: () => void }) {
  const { chip, ui, window, otherTokens, calibration, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
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
