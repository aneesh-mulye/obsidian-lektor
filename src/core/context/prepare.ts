// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turning a chat's context into the message sent with a request, the manifest
 * kept in chat history (paths and hashes, never text), and restoring a saved
 * chat's chips (DESIGN.md § Storage, settings and privacy; INVARIANTS.md H4).
 */

import { type AssembleOptions, type AssembledImage, type Skipped, assembleContext } from './assemble';
import type { ContextIndex } from './ContextIndex';
import { sha256, sha256Bytes } from './hash';
import { renderContext } from './render';
import type { Change, Chip, ContextState } from './state';
import { MESSAGE_OVERHEAD, estimateTokens } from './tokens';
import { extractUrls } from '../tools/urls';
import { imagesMessage, messagesTokens } from '../chat/transcript';

export { sha256 };

export interface ContextManifest {
  notes: Array<{ path: string; hash: string }>;
  selections: Array<{ path: string; hash: string }>;
  /** Attachments sent (text or image), with the hash of their bytes. Absent in chats from before milestone 7. */
  attachments?: Array<{ path: string; hash: string }>;
  /** How many backlink lists (paths only) were sent. */
  backlinkLists: number;
  /** Excluded notes left out. */
  excluded: number;
}

export interface PreparedContext {
  /** The context message, or null if there is no context. */
  message: string | null;
  /** Images to send in the message after it, in order. */
  images: AssembledImage[];
  /** Estimated tokens of the message and the images. */
  tokens: number;
  manifest: ContextManifest;
  /** Attachments in context that could not be sent, and why (the reply shows them). */
  skipped: Skipped[];
  /** http(s) URLs written in the attached notes, selections and text attachments (known to fetch_page). */
  urls: string[];
}


export async function prepareContext(state: ContextState, index: ContextIndex, options: AssembleOptions = {}): Promise<PreparedContext> {
  const assembled = await assembleContext(state, index, options);
  const message = renderContext(assembled);
  return {
    message,
    images: assembled.images,
    tokens: (message === null ? 0 : estimateTokens(message) + MESSAGE_OVERHEAD) + (assembled.images.length > 0 ? messagesTokens([imagesMessage(assembled.images)], estimateTokens, MESSAGE_OVERHEAD) : 0),
    manifest: {
      notes: await Promise.all(assembled.notes.map(async (n) => ({ path: n.path, hash: await sha256(n.content) }))),
      selections: await Promise.all(assembled.selections.map(async (s) => ({ path: s.path, hash: await sha256(s.text) }))),
      attachments: [...assembled.texts, ...assembled.images].map((a) => ({ path: a.path, hash: a.hash })),
      backlinkLists: assembled.backlinkLists.filter((l) => l.total > 0).length,
      excluded: assembled.excluded,
    },
    skipped: assembled.skipped,
    urls: [...assembled.notes.map((n) => n.content), ...assembled.selections.map((sel) => sel.text), ...assembled.texts.map((t) => t.text)].flatMap(extractUrls),
  };
}

/** After sending: remember each note chip's hash, and clear "changed" marks. */
export function recordSent(state: ContextState, manifest: ContextManifest): ContextState {
  const hashes = new Map(manifest.notes.map((n) => [n.path, n.hash]));
  const files = new Map((manifest.attachments ?? []).map((a) => [a.path, a.hash]));
  return {
    ...state,
    chips: state.chips.map((c): Chip => {
      if (c.kind === 'attachment' && files.has(c.path)) {
        const { changed: _changed, ...rest } = c;
        return { ...rest, lastHash: files.get(c.path)! };
      }
      if (c.kind !== 'note' || !hashes.has(c.path)) return c;
      const { changed: _changed, ...rest } = c;
      return { ...rest, lastHash: hashes.get(c.path)! };
    }),
  };
}

/**
 * Bring a saved chat's chips back: drop chips for notes that are gone or now
 * excluded, mark notes changed since they were last sent, and restore
 * selections only if the text at their range still has the same hash.
 */
export async function restoreContext(state: ContextState, index: ContextIndex): Promise<Change> {
  const chips: Chip[] = [];
  const dropped: string[] = [];
  const changedSelections: string[] = [];
  for (const c of state.chips) {
    if (c.kind === 'folder') {
      if (index.hasFolder(c.path)) chips.push(c);
      else dropped.push(c.path);
      continue;
    }
    if (c.kind === 'attachment') {
      if (!index.attachment(c.path)) {
        dropped.push(c.path);
        continue;
      }
      const changed = c.lastHash !== undefined && (await sha256Bytes(await index.readAttachment(c.path))) !== c.lastHash;
      chips.push(changed ? { ...c, changed: true } : c);
      continue;
    }
    if (!index.note(c.path)) {
      dropped.push(c.kind === 'selection' ? `a selection from ${c.path}` : c.path);
      continue;
    }
    if (c.kind === 'note') {
      const changed = c.lastHash !== undefined && (await sha256(await index.read(c.path))) !== c.lastHash;
      chips.push(changed ? { ...c, changed: true } : c);
      continue;
    }
    const text = (await index.read(c.path)).slice(c.from, c.to);
    if (text !== '' && (await sha256(text)) === c.hash) chips.push({ ...c, text });
    else changedSelections.push(c.path);
  }
  const notices: string[] = [];
  if (dropped.length > 0) notices.push(`No longer in context (deleted or now excluded): ${dropped.join(', ')}.`);
  if (changedSelections.length > 0) notices.push(`Selections removed because the text changed: ${changedSelections.join(', ')}.`);
  return { state: { ...state, chips }, ...(notices.length > 0 ? { notice: notices.join(' ') } : {}) };
}
