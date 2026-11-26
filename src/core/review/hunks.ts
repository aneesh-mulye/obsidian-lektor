// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hunks within one of the model's edits (DESIGN.md § Hunks; INVARIANTS.md W1).
 * `find` and `replace` are split into word, whitespace and single-character
 * tokens, compared with a longest-common-subsequence diff, and changes fewer
 * than three words apart are merged so that a hunk reads as a phrase.
 * Offsets are into `find`.
 */

export interface HunkSpan {
  /** Start and end of the replaced text in the edit's `find`. */
  start: number;
  end: number;
  /** What replaces it. */
  after: string;
}

const TOKEN = /[\p{L}\p{N}\p{M}_'’]+|\s+|[\s\S]/gu;
const IS_WORD = /[\p{L}\p{N}]/u;
/** Changes separated by fewer than this many unchanged words merge into one hunk. */
const MERGE_BELOW = 3;
/** Above this many token pairs, the changed middle becomes a single hunk instead of being diffed. */
const MAX_CELLS = 4_000_000;

const tokenize = (s: string): string[] => s.match(TOKEN) ?? [];

type Op = { kind: 'equal' | 'delete' | 'insert'; text: string };

function diffTokens(a: string[], b: string[]): Op[] {
  // Trim the common prefix and suffix: most edits change a little in the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = a.slice(0, pre).map((text) => ({ kind: 'equal', text }));
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  const n = ma.length;
  const m = mb.length;

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    if (n > 0) ops.push({ kind: 'delete', text: ma.join('') });
    if (m > 0) ops.push({ kind: 'insert', text: mb.join('') });
  } else {
    // lcs[i][j]: length of the LCS of ma[i..] and mb[j..].
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        ops.push({ kind: 'equal', text: ma[i]! });
        i++;
        j++;
      } else if (j < m && (i === n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) ops.push({ kind: 'insert', text: mb[j++]! });
      else ops.push({ kind: 'delete', text: ma[i++]! });
    }
  }
  for (const text of a.slice(a.length - suf)) ops.push({ kind: 'equal', text });
  return ops;
}

export function computeHunks(find: string, replace: string): HunkSpan[] {
  const ops = diffTokens(tokenize(find), tokenize(replace));
  // Collect maximal changed regions, with the unchanged run before each.
  type Region = { start: number; end: number; after: string; gapBefore: string };
  const regions: Region[] = [];
  let pos = 0;
  let gap = '';
  let current: Region | null = null;
  for (const op of ops) {
    if (op.kind === 'equal') {
      if (current) {
        regions.push(current);
        current = null;
        gap = '';
      }
      gap += op.text;
      pos += op.text.length;
      continue;
    }
    current ??= { start: pos, end: pos, after: '', gapBefore: gap };
    if (op.kind === 'delete') {
      pos += op.text.length;
      current.end = pos;
    } else {
      current.after += op.text;
    }
  }
  if (current) regions.push(current);

  // Merge neighbours separated by fewer than MERGE_BELOW unchanged words.
  const out: HunkSpan[] = [];
  for (const r of regions) {
    const prev = out.at(-1);
    const words = tokenize(r.gapBefore).filter((t) => IS_WORD.test(t)).length;
    if (prev && words < MERGE_BELOW) {
      prev.after += r.gapBefore + r.after;
      prev.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end, after: r.after });
    }
  }
  return out.filter((h) => find.slice(h.start, h.end) !== h.after);
}

/** `find` with the given hunks applied (in any order: they are disjoint). */
export function applyHunks(find: string, hunks: readonly HunkSpan[], accepted: Iterable<number>): string {
  const chosen = [...new Set(accepted)].map((i) => hunks[i]!).sort((x, y) => y.start - x.start);
  let text = find;
  for (const h of chosen) text = text.slice(0, h.start) + h.after + text.slice(h.end);
  return text;
}
