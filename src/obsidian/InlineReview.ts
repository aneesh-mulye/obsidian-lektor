// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What inline review shows, and where its clicks go (DESIGN.md § Inline review;
 * INVARIANTS.md B3, B4, G8). Only proposals from the chat open in the sidebar,
 * and only while that chat is in Inline mode. ReviewController draws it.
 *
 * Also keeps staleness current: when a chat opens or gets a new proposal, and
 * when a note with pending proposals changes on disk while no editor has it.
 */

import type { ChatManager } from '../core/chat/manager';
import { displayModeOf } from '../core/chat/types';
import type { ReviewManager } from '../core/review/manager';
import { inlineMarks } from '../core/review/rebase';
import type { EditProposal } from '../core/review/types';
import type { DisplayMode } from '../core/settings';
import type { InlineClicks, InlineSource } from './ReviewController';

export interface InlineDeps {
  chats: ChatManager;
  review: ReviewManager;
  defaultMode: () => DisplayMode;
  /** The note's text in an open editor, if any. */
  editorText: (path: string) => string | null;
  /** The note's text on disk (through ContextBroker). */
  readNote: (path: string) => Promise<string>;
  /** Reveal the sidebar with this proposal's rebase panel open. */
  showProposal: (proposalId: string) => void;
}

const pendingEdits = (deps: InlineDeps): EditProposal[] =>
  Object.values(deps.chats.session.chat.proposals ?? {}).filter((p): p is EditProposal => p.kind === 'edit' && p.hunks.some((h) => h.status === 'pending'));

export function inlineSource(deps: InlineDeps): InlineSource {
  const shown = (path: string): EditProposal[] => {
    const chat = deps.chats.session.chat;
    if (displayModeOf(chat, deps.defaultMode()) !== 'inline') return [];
    return pendingEdits(deps).filter((p) => p.path === path);
  };
  // Every call here is a click on ✓, ✕, Accept all or Reject all in the editor (G8).
  const clicks: InlineClicks = {
    accept: (proposalId, hunkId) => void deps.review.acceptHunk(deps.chats.session, proposalId, hunkId),
    reject: (proposalId, hunkId) => deps.review.rejectHunk(deps.chats.session, proposalId, hunkId),
    acceptAll: (path) => {
      void (async () => {
        for (const p of shown(path)) await deps.review.acceptAll(deps.chats.session, p.id);
      })();
    },
    rejectAll: (path) => {
      for (const p of shown(path)) deps.review.rejectAll(deps.chats.session, p.id);
    },
    showStale: (path) => {
      const p = shown(path).find((q) => deps.review.stale.has(q.id));
      if (p) deps.showProposal(p.id);
    },
  };
  return {
    marks: (path, text) => inlineMarks(text, shown(path)),
    pill: (path) => {
      const ps = shown(path);
      const pending = ps.reduce((n, p) => n + p.hunks.filter((h) => h.status === 'pending').length, 0);
      const stale = ps.reduce((n, p) => n + (deps.review.stale.get(p.id)?.length ?? 0), 0);
      return pending > 0 ? { pending, stale } : null;
    },
    reason: (proposalId, hunkId) => {
      const p = deps.chats.session.chat.proposals?.[proposalId];
      if (p?.kind !== 'edit') return undefined;
      const h = p.hunks.find((x) => x.id === hunkId);
      return h ? p.edits[h.edit]?.reason : undefined;
    },
    subscribe: (listener) => {
      const a = deps.chats.subscribe(listener);
      const b = deps.review.subscribe(listener);
      return () => {
        a();
        b();
      };
    },
    changed: (path, text) => deps.review.noteChanged(deps.chats.session, path, text),
    clicks,
  };
}

/**
 * Re-check proposals whose staleness nobody else will report: when the open chat changes or gets a
 * new proposal, and when a note changes on disk while no editor has it open. Returns the listener
 * for vault modifications.
 */
export function watchStaleness(deps: InlineDeps): { modified: (path: string) => void; dispose: () => void } {
  const checked = new Set<string>();
  const check = async (path: string) => {
    const text = deps.editorText(path) ?? (await deps.readNote(path).catch(() => null));
    if (text !== null) deps.review.noteChanged(deps.chats.session, path, text);
  };
  const onChat = () => {
    for (const p of pendingEdits(deps)) {
      if (checked.has(p.id)) continue;
      checked.add(p.id);
      void check(p.path);
    }
  };
  const unsubscribe = deps.chats.subscribe(onChat);
  onChat();
  return {
    modified: (path) => {
      // An open editor reports its own changes (it may be ahead of the disk).
      if (deps.editorText(path) !== null) return;
      if (pendingEdits(deps).some((p) => p.path === path)) void check(path);
    },
    dispose: unsubscribe,
  };
}
