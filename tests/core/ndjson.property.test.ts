// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md N1: NDJSON decoding is exact under any chunking. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type NdjsonItem, decodeNdjson } from '../../src/core/providers/ndjson';

const enc = new TextEncoder();

/** Cut bytes at the given offsets (sorted, deduplicated, clamped). */
function cut(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const points = [...new Set(offsets.map((o) => o % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let last = 0;
  for (const p of [...points, bytes.length]) {
    chunks.push(bytes.slice(last, p)); // includes empty chunks on purpose
    last = p;
  }
  return chunks;
}

async function* from(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) {
    await Promise.resolve();
    yield c;
  }
}

async function collect(it: AsyncIterable<NdjsonItem>): Promise<NdjsonItem[]> {
  const out: NdjsonItem[] = [];
  for await (const x of it) out.push(x);
  return out;
}

type Line = { kind: 'value'; value: unknown } | { kind: 'bad'; text: string };

const text = fc.oneof(fc.string(), fc.string({ unit: 'grapheme' }), fc.constantFrom('héllo', '日本語', '𝄞 music', '🙂🙃', 'a b'));
const value = fc.oneof(
  fc.jsonValue(),
  fc.record({ message: fc.record({ role: fc.constant('assistant'), content: text }), done: fc.boolean() }),
);
const badLine = fc.constantFrom('{', '{"a":', 'not json', '}{', '[1,2', '"unterminated', '{"a":1}x', 'NaN');
const line: fc.Arbitrary<Line> = fc.oneof(
  { weight: 5, arbitrary: value.map((v): Line => ({ kind: 'value', value: v })) },
  { weight: 1, arbitrary: badLine.map((t): Line => ({ kind: 'bad', text: t })) },
);

describe('decodeNdjson (INVARIANTS.md N1)', () => {
  it('N1: yields exactly the lines, in order, for any byte chunking', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(line, { maxLength: 12 }),
        fc.array(fc.constantFrom('\n', '\r\n'), { minLength: 12, maxLength: 12 }),
        fc.array(fc.nat({ max: 3 }), { minLength: 12, maxLength: 12 }),
        fc.boolean(),
        fc.array(fc.nat(), { maxLength: 30 }),
        async (lines, endings, blanks, finalNewline, offsets) => {
          let body = '';
          lines.forEach((l, i) => {
            body += '\n'.repeat(blanks[i]!); // blank lines are skipped
            body += l.kind === 'value' ? JSON.stringify(l.value) : l.text;
            if (i < lines.length - 1 || finalNewline) body += endings[i]!;
          });
          const items = await collect(decodeNdjson(from(cut(enc.encode(body), offsets))));
          // The model is what is on the wire: a value after a JSON round trip (-0 is written as 0).
          const expected = lines.map((l) =>
            l.kind === 'value' ? { ok: true, value: JSON.parse(JSON.stringify(l.value)) as unknown } : { ok: false, line: l.text },
          );
          expect(items).toEqual(expected);
        },
      ),
    );
  });

  // Regression: N1 seed 316671435 (CI run) generated -0, which JSON writes as 0; the test model was wrong,
  // not the decoder. Pin what the decoder must do: return exactly JSON.parse of each line.
  it('returns exactly JSON.parse of each line, -0 included', async () => {
    const items = await collect(decodeNdjson(from([enc.encode('0\n-0\n')])));
    expect(items).toEqual([{ ok: true, value: 0 }, { ok: true, value: -0 }]);
    expect(Object.is((items[1] as { value: unknown }).value, -0)).toBe(true);
  });

  it('decodes a character split across chunks', async () => {
    const bytes = enc.encode('{"t":"𝄞"}\n');
    const items = await collect(decodeNdjson(from([bytes.slice(0, 7), bytes.slice(7, 8), bytes.slice(8)])));
    expect(items).toEqual([{ ok: true, value: { t: '𝄞' } }]);
  });
});
