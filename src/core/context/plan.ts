// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a context state sends, worked out from metadata alone (no note is
 * read). Assembly reads exactly the planned notes, and the link-depth preview
 * is a plan of a single chip, so the two agree (INVARIANTS.md X4).
 */

import type { ContextIndex } from './ContextIndex';
import type { ContextState, Depth, NoteChip } from './state';
import { tokensForBytes } from './tokens';

export const BACKLINK_LIST_CAP = 50;

export type Via = 'chip' | 'link' | 'folder' | 'backlink';

export interface PlannedNote {
  path: string;
  via: Via;
  size: number;
}

export interface BacklinkList {
  /** The note in context. */
  of: string;
  /** Up to BACKLINK_LIST_CAP notes linking to it (paths only). */
  paths: string[];
  /** How many there are in all. */
  total: number;
}

export interface ContextPlan {
  notes: PlannedNote[];
  backlinkLists: BacklinkList[];
  selections: Array<{ id: string; path: string; text: string }>;
  /** Excluded notes the plan would otherwise have reached (counted for the user, never sent). */
  excluded: Set<string>;
}

/** Breadth-first over outgoing links, never entering an excluded note. Root first. */
function walk(index: ContextIndex, root: string, depth: Depth, excluded: Set<string>): string[] {
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
  return seen;
}

export function planContext(state: ContextState, index: ContextIndex): ContextPlan {
  const notes = new Map<string, PlannedNote>();
  const excluded = new Set<string>();
  const selections: ContextPlan['selections'] = [];
  const add = (path: string, via: Via) => {
    const meta = index.note(path);
    if (meta && !notes.has(path)) notes.set(path, { path, via, size: meta.size });
  };

  for (const chip of state.chips) {
    if (chip.kind === 'note') {
      if (!index.note(chip.path)) continue;
      const reached = walk(index, chip.path, chip.depth, excluded);
      reached.forEach((p, i) => add(p, i === 0 ? 'chip' : 'link'));
      if (chip.backlinkContents) {
        for (const n of reached) {
          const back = index.backlinks(n);
          for (const e of back.excluded) excluded.add(e);
          for (const b of back.notes) add(b, 'backlink');
        }
      }
    } else if (chip.kind === 'folder') {
      if (!index.hasFolder(chip.path)) continue;
      const inside = index.inFolder(chip.path, chip.recursive);
      for (const e of inside.excluded) excluded.add(e);
      for (const p of inside.notes) add(p, 'folder');
    } else if (chip.text !== undefined && index.note(chip.path)) {
      selections.push({ id: chip.id, path: chip.path, text: chip.text });
    }
  }

  const backlinkLists: BacklinkList[] = [];
  for (const n of notes.values()) {
    const back = index.backlinks(n.path);
    for (const e of back.excluded) excluded.add(e);
    backlinkLists.push({ of: n.path, paths: back.notes.slice(0, BACKLINK_LIST_CAP), total: back.notes.length });
  }
  return { notes: [...notes.values()], backlinkLists, selections, excluded };
}

export function planTokens(plan: ContextPlan): number {
  return plan.notes.reduce((t, n) => t + tokensForBytes(n.size), 0);
}

export interface DepthPreview {
  depth: Depth;
  /** Notes added beyond the chip's own. */
  notes: number;
  /** Estimated tokens of all notes' text at this depth. */
  tokens: number;
  /** Backlink entries listed (paths only). */
  backlinksListed: number;
  /** Extra tokens if "Include backlink contents" were on. */
  backlinkContentTokens: number;
  /** Excluded notes left out. */
  excluded: number;
}

/** What each depth would send for this chip, from metadata alone (DESIGN.md § Link-depth preview). */
export function previewDepths(chip: NoteChip, index: ContextIndex, maxDepth: Depth): DepthPreview[] {
  const out: DepthPreview[] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const depth = d as Depth;
    const base = planContext({ followActive: false, chips: [{ ...chip, depth, backlinkContents: false }] }, index);
    const withBacklinks = planContext({ followActive: false, chips: [{ ...chip, depth, backlinkContents: true }] }, index);
    out.push({
      depth,
      notes: Math.max(0, base.notes.length - 1),
      tokens: planTokens(base),
      backlinksListed: base.backlinkLists.reduce((t, l) => t + l.paths.length, 0),
      backlinkContentTokens: planTokens(withBacklinks) - planTokens(base),
      excluded: base.excluded.size,
    });
  }
  return out;
}
