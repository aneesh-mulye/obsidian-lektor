// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turning a model's `request_context` call into a concrete list of files
 * (DESIGN.md § Model-initiated requests; INVARIANTS.md A3). Everything goes
 * through the filtered index, so excluded notes and files never appear: they
 * are only counted. Nothing is read here; the list is built from metadata.
 */

import type { ModelAccepts } from './attachments';
import type { ContextIndex } from './ContextIndex';
import { type ContextPlan, attachmentTokens } from './plan';
import type { Depth } from './state';
import { tokensForBytes } from './tokens';

export interface ContextRequest {
  /** Notes by vault path or by title. */
  notes?: readonly string[] | undefined;
  /** A note and the notes it links to, to this depth. */
  linked_from?: { note: string; depth: number } | undefined;
  folder?: { path: string; recursive?: boolean | undefined } | undefined;
  /** Words to look for in note titles. */
  search?: string | undefined;
  /** Attachments by vault path or file name. */
  attachments?: readonly string[] | undefined;
  /** Why the model wants them (shown on the card). */
  reason?: string | undefined;
}

export interface RequestItem {
  kind: 'note' | 'attachment';
  path: string;
  /** Estimated tokens (before reading). */
  tokens: number;
  /** Why it can't be sent to this model, if it can't (attachments only). */
  unavailable?: string;
}

export interface Resolution {
  /** What the card would list: allowed, not already in context, in request order. */
  items: RequestItem[];
  /** Requested items that are already in context. */
  already: string[];
  /** Excluded notes and files the request reached (counted for the user, never listed). */
  excluded: number;
}

/** At most this many items on one card (DESIGN.md § Decided, milestone 7). */
export const REQUEST_CAP = 20;

const lower = (s: string) => s.toLowerCase();
const trimSlashes = (p: string) => p.trim().replace(/^\/+|\/+$/g, '');

/** A note named by path (with or without `.md`) or by title (case ignored). Several notes can share a title. */
export function findNotes(index: ContextIndex, name: string): string[] {
  const n = trimSlashes(name).replace(/^\[\[|\]\]$/g, '');
  if (n === '') return [];
  for (const path of [n, `${n}.md`]) if (index.note(path)) return [path];
  const title = lower(n.replace(/\.md$/i, ''));
  return index
    .notes()
    .filter((m) => lower(m.title) === title)
    .map((m) => m.path);
}

/** An attachment named by path or by file name (case ignored). */
export function findAttachments(index: ContextIndex, name: string): string[] {
  const n = trimSlashes(name).replace(/^!?\[\[|\]\]$/g, '');
  if (n === '') return [];
  if (index.attachment(n)) return [n];
  const want = lower(n.slice(n.lastIndexOf('/') + 1));
  return index
    .attachments()
    .filter((a) => lower(a.name) === want)
    .map((a) => a.path);
}

/** Notes whose title contains every word of the query (case ignored). */
export function searchTitles(index: ContextIndex, query: string): string[] {
  const words = lower(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return index
    .notes()
    .filter((m) => words.every((w) => lower(m.title).includes(w)))
    .map((m) => m.path);
}

export function resolveRequest(req: ContextRequest, index: ContextIndex, plan: ContextPlan, accepts: ModelAccepts, maxDepth: Depth): Resolution {
  const excluded = new Set<string>();
  const notes: string[] = [];
  const files: string[] = [];
  const addNote = (p: string) => !notes.includes(p) && notes.push(p);
  const addFile = (p: string) => !files.includes(p) && files.push(p);

  for (const name of req.notes ?? []) findNotes(index, name).forEach(addNote);
  if (req.linked_from) {
    const depth = Math.max(0, Math.min(maxDepth, Math.trunc(req.linked_from.depth))) as Depth;
    for (const root of findNotes(index, req.linked_from.note)) {
      // Breadth-first over outgoing links, never entering an excluded note (as the link-depth chip does).
      const seen = [root];
      let frontier = [root];
      for (let level = 0; level < depth; level++) {
        const next: string[] = [];
        for (const n of frontier) {
          const out = index.outgoing(n);
          for (const e of out.excluded) excluded.add(e);
          for (const t of out.notes) {
            if (!seen.includes(t)) {
              seen.push(t);
              next.push(t);
            }
          }
        }
        frontier = next;
      }
      seen.forEach(addNote);
    }
  }
  if (req.folder) {
    const folder = trimSlashes(req.folder.path);
    if (index.hasFolder(folder)) {
      const inside = index.inFolder(folder, req.folder.recursive ?? false);
      inside.notes.forEach(addNote);
      for (const e of inside.excluded) excluded.add(e);
    }
  }
  if (req.search !== undefined) searchTitles(index, req.search).forEach(addNote);
  for (const name of req.attachments ?? []) findAttachments(index, name).forEach(addFile);

  const inContext = new Set([...plan.notes.map((n) => n.path), ...plan.attachments.map((a) => a.path)]);
  const already = [...notes, ...files].filter((p) => inContext.has(p));
  const items: RequestItem[] = [];
  for (const path of notes) {
    if (inContext.has(path)) continue;
    items.push({ kind: 'note', path, tokens: tokensForBytes(index.note(path)!.size) });
  }
  for (const path of files) {
    if (inContext.has(path)) continue;
    const size = index.attachment(path)!.size;
    const check = index.converters.check(path, size, accepts);
    items.push({ kind: 'attachment', path, tokens: check.ok ? attachmentTokens(index, path, size) : 0, ...(check.ok ? {} : { unavailable: check.reason }) });
  }
  return { items, already, excluded: excluded.size };
}
