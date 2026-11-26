// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md W1: hunk algebra (design invariant 4). */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyHunks, computeHunks } from '../../src/core/review/hunks';

const WORD = /[\p{L}\p{N}]/u;
const word = fc.constantFrom('the', 'The', 'teh', 'cat', 'sat', 'on', 'a', 'mat', "it's", 'its', 'keeper', 'lighthouse', '1844', '日本', '😀', 'naïve');
const sep = fc.constantFrom(' ', ' ', ' ', '  ', ', ', '. ', '\n', '\n\n', '—', '');
const prose = fc.array(fc.tuple(word, sep), { maxLength: 30 }).map((ws) => ws.map(([w, s]) => w + s).join(''));
/** A text and a lightly edited copy (the common case), or two unrelated texts. */
const pair = fc.oneof(
  fc.tuple(prose, fc.array(fc.tuple(fc.nat(), fc.oneof(word, fc.constant(''), sep)), { maxLength: 6 })).map(([a, changes]) => {
    const tokens = a.split(/(\s+)/);
    for (const [i, w] of changes) if (tokens.length > 0) tokens[i % tokens.length] = w;
    return [a, tokens.join('')] as [string, string];
  }),
  fc.tuple(prose, prose),
  fc.tuple(fc.string(), fc.string()),
);

const subsets = (n: number) => fc.array(fc.boolean(), { minLength: n, maxLength: n }).map((bs) => bs.flatMap((b, i) => (b ? [i] : [])));

describe('computeHunks (INVARIANTS.md W1, design invariant 4)', () => {
  it('W1: sorted, disjoint, real changes, and no unchanged run of three or more words inside a hunk', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const hunks = computeHunks(a, b);
        for (let i = 0; i < hunks.length; i++) {
          const h = hunks[i]!;
          expect(h.start).toBeLessThanOrEqual(h.end);
          expect(a.slice(h.start, h.end)).not.toBe(h.after);
          if (i > 0) expect(hunks[i - 1]!.end).toBeLessThan(h.start); // disjoint, and something unchanged between
          if (i > 0) {
            const gap = a.slice(hunks[i - 1]!.end, h.start);
            const words = (gap.match(/[\p{L}\p{N}_'’]+/gu) ?? []).filter((t) => WORD.test(t)).length;
            expect(words).toBeGreaterThanOrEqual(3); // otherwise they would have merged into one phrase
          }
        }
      }),
    );
  });

  it('W1: all → replace; none → find; a subset then the rest → all; any order → same', () => {
    fc.assert(
      fc.property(pair.chain(([a, b]) => {
        const n = computeHunks(a, b).length;
        return fc.tuple(fc.constant([a, b] as const), subsets(n), fc.shuffledSubarray([...Array(n).keys()], { minLength: n, maxLength: n }));
      }), ([[a, b], subset, order]) => {
        const hunks = computeHunks(a, b);
        const all = hunks.map((_, i) => i);
        expect(applyHunks(a, hunks, all)).toBe(b);
        expect(applyHunks(a, hunks, [])).toBe(a);
        expect(applyHunks(a, hunks, order)).toBe(b);
        const rest = all.filter((i) => !subset.includes(i));
        // Applying a subset, then the rest on top of the result (with offsets shifted), equals applying all.
        const partial = applyHunks(a, hunks, subset);
        let shift = 0;
        const shifted = hunks.map((h, i) => {
          const s = { ...h, start: h.start + shift, end: h.end + shift };
          if (subset.includes(i)) shift += h.after.length - (h.end - h.start);
          return s;
        });
        expect(applyHunks(partial, shifted.map((h, i) => (subset.includes(i) ? { ...h, start: h.start, end: h.start + hunks[i]!.after.length, after: hunks[i]!.after } : h)), rest)).toBe(b);
      }),
    );
  });

  it('reads as phrases', () => {
    expect(computeHunks('The the lighthouse was finished in 1844.', 'The lighthouse was finished in 1844.')).toEqual([{ start: 4, end: 8, after: '' }]);
    const h = computeHunks("its keepers lived their for months", "its keepers lived there for months");
    expect(h).toEqual([{ start: 18, end: 23, after: 'there' }]);
    // Two fixes one word apart become one hunk.
    expect(computeHunks('teh cat sat on teh mat', 'the cat sat on the mat')).toHaveLength(2);
    expect(computeHunks('teh cat teh mat', 'the cat the mat')).toEqual([{ start: 0, end: 11, after: 'the cat the' }]);
  });
});
