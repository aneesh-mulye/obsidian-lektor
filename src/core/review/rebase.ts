// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Staleness, rebase and inline marks (DESIGN.md § Staleness and rebase;
 * INVARIANTS.md B1–B4).
 *
 * A pending hunk is stale when it can no longer be located in the note's
 * current text. A rebase re-anchors each pending hunk on its own (so editing
 * one word inside a long edit loses only the hunks that word touched), drops
 * the ones it cannot place, and rewrites the kept ones as small,
 * non-overlapping edits against the current text.
 *
 * When the caller knows the text the review last saw (`previous`, kept in
 * memory only) and the review's positions were exact in it, every hunk's
 * position is carried through the change exactly; a hunk the change touched is
 * dropped. Otherwise each hunk is searched for by its surrounding text, which
 * must then occur exactly once.
 */

import { fingerprint } from './fingerprint';
import { editTextNow, locateHunk, occurrences } from './proposals';
import type { EditProposal, EditSpec, HunkRecord } from './types';

export interface Staleness {
  locatable: string[];
  stale: string[];
}

export function staleness(text: string, p: EditProposal): Staleness {
  const out: Staleness = { locatable: [], stale: [] };
  for (const h of p.hunks) {
    if (h.status !== 'pending') continue;
    (locateHunk(text, p, h.id) ? out.locatable : out.stale).push(h.id);
  }
  return out;
}

export interface Mark {
  proposalId: string;
  hunkId: string;
  from: number;
  to: number;
  insert: string;
}

/** Inline marks: exactly the locatable pending hunks (INVARIANTS.md B4). */
export function inlineMarks(text: string, proposals: readonly EditProposal[]): Mark[] {
  const out: Mark[] = [];
  for (const p of proposals) {
    for (const h of p.hunks) {
      if (h.status !== 'pending') continue;
      const s = locateHunk(text, p, h.id);
      if (s) out.push({ proposalId: p.id, hunkId: h.id, from: s.from, to: s.to, insert: s.insert });
    }
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

export interface RebaseResult {
  proposal: EditProposal;
  kept: string[];
  dropped: Array<{ hunkId: string; reason: string }>;
}

/** Context kept on each side when a hunk becomes its own edit. */
const CONTEXT = 40;
const TRIES = [Number.POSITIVE_INFINITY, 40, 20, 10, 0];

/**
 * Where the hunk's `before` text starts in `text` now, and how much of the edit's own text
 * (the model's words, with accepted hunks applied) surrounds it there; or why it can't be placed.
 */
function anchor(text: string, p: EditProposal, h: HunkRecord, change: Change | null): { at: number; lead: number; trail: number } | { reason: string } {
  const region = editTextNow(p, h.edit);
  const shift = p.hunks.filter((k) => k.edit === h.edit && k.status === 'accepted' && k.start < h.start).reduce((s, k) => s + k.after.length - (k.end - k.start), 0);
  const before = p.edits[h.edit]!.find.slice(h.start, h.end);
  const hs = h.start + shift;
  const he = hs + before.length;
  if (change) {
    const old = locateHunk(change.previous, p, h.id);
    if (old) {
      const at = mapThrough(change, old.from, old.to);
      if (at === null || text.slice(at, at + before.length) !== before) return { reason: 'you changed the passage it would change' };
      let lead = 0;
      while (lead < hs && at - lead > 0 && text[at - lead - 1] === region[hs - lead - 1]) lead++;
      let trail = 0;
      const end = at + before.length;
      while (he + trail < region.length && end + trail < text.length && text[end + trail] === region[he + trail]) trail++;
      return { at, lead, trail };
    }
  }
  const located = locateHunk(text, p, h.id);
  if (located) return { at: located.from, lead: hs, trail: region.length - he };
  for (const k of TRIES) {
    const lead = region.slice(Math.max(0, hs - k), hs);
    const trail = region.slice(he, he + k);
    const needle = lead + before + trail;
    if (needle === '') return { reason: 'nothing is left to anchor it on' };
    const at = occurrences(text, needle, 2);
    if (at.length === 1) return { at: at[0]! + lead.length, lead: lead.length, trail: trail.length };
    if (at.length > 1) return { reason: 'the passage now appears more than once' };
  }
  return { reason: 'the passage was changed or removed' };
}

/** One contiguous change between two texts: common prefix and suffix (never overlapping). */
interface Change {
  previous: string;
  prefix: number;
  oldEnd: number;
  newEnd: number;
}

function changeBetween(previous: string, text: string): Change {
  const max = Math.min(previous.length, text.length);
  let prefix = 0;
  while (prefix < max && previous.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && previous.charCodeAt(previous.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)) suffix++;
  return { previous, prefix, oldEnd: previous.length - suffix, newEnd: text.length - suffix };
}

/** Where [from, to) of the previous text is now, or null if the change touched it. */
function mapThrough(c: Change, from: number, to: number): number | null {
  if (to <= c.prefix && !(from === to && from === c.prefix && c.oldEnd > c.prefix)) return from;
  if (from >= c.oldEnd) return from + (c.newEnd - c.oldEnd);
  return null;
}

/**
 * Re-anchor every pending hunk against `text` (INVARIANTS.md B1). If the note is exactly as the
 * review left it, nothing changes. Otherwise every pending hunk is placed afresh, even ones that
 * still fit, so that positions are exact again: accepting one hunk can then never make another
 * ambiguous (say, by duplicating its text).
 *
 * Each kept hunk becomes its own small edit whose text is the model's own (the part of its edit
 * that matched around the hunk), so a rebase adds none of the user's newer note text to chat
 * history (H5).
 */
export function rebase(text: string, p: EditProposal, previous?: string): RebaseResult {
  const pending = p.hunks.filter((h) => h.status === 'pending');
  if (pending.length === 0 || fingerprint(text) === p.expect) return { proposal: p, kept: pending.map((h) => h.id), dropped: [] };
  const change = previous !== undefined && fingerprint(previous) === p.expect ? changeBetween(previous, text) : null;

  const dropped: RebaseResult['dropped'] = [];
  const placed: Array<{ h: HunkRecord; at: number; lead: number; trail: number; before: string }> = [];
  for (const h of pending) {
    const a = anchor(text, p, h, change);
    if ('reason' in a) dropped.push({ hunkId: h.id, reason: a.reason });
    else placed.push({ h, ...a, before: p.edits[h.edit]!.find.slice(h.start, h.end) });
  }
  // Two hunks can't share text: keep the first, drop the other.
  placed.sort((x, y) => x.at - y.at);
  const kept: typeof placed = [];
  for (const c of placed) {
    const prev = kept.at(-1);
    if (prev && (c.at < prev.at + prev.before.length || (c.at === prev.at + prev.before.length && c.before === '' && prev.before === ''))) {
      dropped.push({ hunkId: c.h.id, reason: 'it now overlaps another proposed change' });
    } else {
      kept.push(c);
    }
  }

  // Each kept hunk becomes its own small edit, with non-overlapping context.
  const edits: EditSpec[] = [...p.edits];
  const anchors = [...p.anchors];
  const moved = new Map<string, HunkRecord>();
  let prevEnd = 0;
  kept.forEach((c, i) => {
    const end = c.at + c.before.length;
    const nextAt = kept[i + 1]?.at ?? text.length;
    const lead = Math.min(CONTEXT, c.lead, c.at - prevEnd);
    const trail = Math.min(CONTEXT, c.trail, Math.floor((nextAt - end) / 2));
    const from = c.at - lead;
    const find = text.slice(from, end + trail);
    const reason = p.edits[c.h.edit]!.reason;
    edits.push({ find, replace: text.slice(from, c.at) + c.h.after + text.slice(end, end + trail), ...(reason ? { reason } : {}) });
    anchors.push(from);
    moved.set(c.h.id, { ...c.h, edit: edits.length - 1, start: lead, end: lead + c.before.length });
    prevEnd = end + trail;
  });

  const reasons = new Map(dropped.map((d) => [d.hunkId, d.reason]));
  const hunks = p.hunks.map((h): HunkRecord => {
    const m = moved.get(h.id);
    if (m) return m;
    const r = reasons.get(h.id);
    return r !== undefined ? { ...h, status: 'dropped', dropReason: r } : h;
  });

  // Keep only the edits some hunk still belongs to, so repeated rebases don't pile up.
  const used = [...new Set(hunks.map((h) => h.edit))].sort((a, b) => a - b);
  const index = new Map(used.map((e, i) => [e, i]));
  // Anchors are now positions in `text`, which already includes every accepted hunk.
  const settled = hunks.filter((h) => h.status === 'accepted').map((h) => h.id);
  const proposal: EditProposal = {
    ...p,
    edits: used.map((e) => edits[e]!),
    anchors: used.map((e) => anchors[e]!),
    hunks: hunks.map((h) => ({ ...h, edit: index.get(h.edit)! })),
    settled,
    expect: fingerprint(text),
  };
  return { proposal, kept: kept.map((c) => c.h.id), dropped };
}
