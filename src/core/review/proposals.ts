// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Validating proposals and finding a hunk in a note's current text (INVARIANTS.md W2, W3). */

import { z } from 'zod';
import type { ModelRef } from '../providers/types';
import { fingerprint } from './fingerprint';
import { applyHunks, computeHunks } from './hunks';
import type { EditProposal, EditSpec, HunkRecord, NoteProposal, Splice } from './types';

export const ProposeEditArgs = z.object({
  path: z.string().min(1).max(1024).describe('Vault path of the note, exactly as given in the context'),
  edits: z
    .array(
      z.object({
        find: z.string().min(1).max(20000).describe('Text copied exactly from the note; must occur exactly once'),
        replace: z.string().max(40000).describe('What should replace it'),
        reason: z.string().max(500).optional().describe('A short reason, shown to the user'),
      }),
    )
    .min(1)
    .max(50),
});
export type ProposeEditArgs = z.infer<typeof ProposeEditArgs>;

export const ProposeNoteArgs = z.object({
  path: z.string().min(1).max(1024).describe('Vault path for the new note, ending in .md'),
  content: z.string().max(200000).describe('The full text of the new note'),
});
export type ProposeNoteArgs = z.infer<typeof ProposeNoteArgs>;

/** Every start index of `needle` in `haystack`, overlapping included, stopping after `limit`. */
function occurrences(haystack: string, needle: string, limit = 2): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  let i = haystack.indexOf(needle);
  while (i !== -1 && out.length < limit) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

const preview = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}…` : s);

export type Validated<T> = { ok: true; proposal: T } | { ok: false; error: string };

/**
 * A proposal from the model's edits, if every `find` occurs exactly once in the
 * note's current text, no two edits overlap, and something actually changes.
 */
export function proposeEdit(
  args: ProposeEditArgs,
  input: { text: string; id: string; hunkId: () => string; createdAt: number; model: ModelRef },
): Validated<EditProposal> {
  const spans: Array<{ start: number; end: number; edit: number }> = [];
  for (const [i, e] of args.edits.entries()) {
    const at = occurrences(input.text, e.find);
    if (at.length === 0) return { ok: false, error: `Edit ${i + 1}: the text ${preview(e.find)} is not in the note. Copy it exactly from the note, including spaces and punctuation.` };
    if (at.length > 1) return { ok: false, error: `Edit ${i + 1}: the text ${preview(e.find)} occurs more than once in the note. Include more surrounding text so it occurs exactly once.` };
    spans.push({ start: at[0]!, end: at[0]! + e.find.length, edit: i });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let k = 1; k < spans.length; k++) {
    if (spans[k]!.start < spans[k - 1]!.end) return { ok: false, error: `Edits ${spans[k - 1]!.edit + 1} and ${spans[k]!.edit + 1} overlap. Merge them into one edit.` };
  }
  const hunks: HunkRecord[] = [];
  const edits: EditSpec[] = args.edits.map((e) => ({ find: e.find, replace: e.replace, ...(e.reason ? { reason: e.reason } : {}) }));
  edits.forEach((e, i) => {
    for (const h of computeHunks(e.find, e.replace)) hunks.push({ id: input.hunkId(), edit: i, start: h.start, end: h.end, after: h.after, status: 'pending' });
  });
  if (hunks.length === 0) return { ok: false, error: 'These edits change nothing.' };
  const anchors = edits.map((_, i) => spans.find((sp) => sp.edit === i)!.start);
  return {
    ok: true,
    proposal: { kind: 'edit', id: input.id, path: args.path, edits, anchors, expect: fingerprint(input.text), hunks, createdAt: input.createdAt, model: input.model },
  };
}

/** The text an edit's region should have now: its `find` with the edit's accepted hunks applied. */
export function editTextNow(p: EditProposal, edit: number): string {
  const own = p.hunks.filter((h) => h.edit === edit);
  return applyHunks(p.edits[edit]!.find, own, own.flatMap((h, i) => (h.status === 'accepted' ? [i] : [])));
}

const delta = (k: { start: number; end: number; after: string }) => k.after.length - (k.end - k.start);

/**
 * Where to apply a pending hunk in the note's current text. If the note is
 * exactly as this review left it, the edit's region is where it was proposed
 * (shifted by hunks accepted before it). Otherwise the region, as it should
 * be now, must occur exactly once, or the hunk is a conflict.
 */
export function locateHunk(text: string, p: EditProposal, hunkId: string): Splice | null {
  const h = p.hunks.find((x) => x.id === hunkId);
  if (!h || h.status !== 'pending') return null;
  const region = editTextNow(p, h.edit);
  if (region === '') return null;
  let regionAt: number;
  if (fingerprint(text) === p.expect) {
    const anchor = p.anchors[h.edit]!;
    regionAt = anchor + p.hunks.filter((k) => k.status === 'accepted' && p.anchors[k.edit]! < anchor).reduce((s, k) => s + delta(k), 0);
    if (text.slice(regionAt, regionAt + region.length) !== region) return null;
  } else {
    const at = occurrences(text, region);
    if (at.length !== 1) return null;
    regionAt = at[0]!;
  }
  const shift = p.hunks.filter((k) => k.edit === h.edit && k.status === 'accepted' && k.start < h.start).reduce((s, k) => s + delta(k), 0);
  const from = regionAt + h.start + shift;
  const before = p.edits[h.edit]!.find.slice(h.start, h.end);
  if (text.slice(from, from + before.length) !== before) return null;
  return { from, to: from + before.length, insert: h.after };
}

/** Why a proposed new-note path is not allowed, or null if it is. */
export function newNotePathProblem(path: string, isExcluded: (p: string) => boolean, exists: (p: string) => boolean): string | null {
  const segments = path.split('/');
  if (!path.toLowerCase().endsWith('.md')) return 'The path must end in .md.';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (path.length > 512 || segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || s.length > 200 || /[\\:*?"<>|\u0000-\u001f]/.test(s))) {
    return 'That is not a valid note path. Use folder/name.md, without leading slashes, dots or special characters.';
  }
  if (isExcluded(path)) return 'That path is in an excluded folder.';
  if (exists(path)) return 'A note already exists at that path. Use propose_edit to change it.';
  return null;
}

export function proposeNote(args: ProposeNoteArgs, input: { id: string; createdAt: number; model: ModelRef }): NoteProposal {
  return { kind: 'note', id: input.id, path: args.path, content: args.content, status: 'pending', createdAt: input.createdAt, model: input.model };
}
