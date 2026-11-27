// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md F1, B4: fenced lektor-edit / lektor-findings blocks are read whole, whatever their JSON contains. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fencedEdits } from '../../src/core/review/tools';
import { fencedBlocks } from '../../src/core/tools/fence';
import { MODEL } from './review.fixtures';

/** Strings that like backticks: fences, half-fences, and backticks at line-like places. */
const ticky = fc.oneof(fc.string(), fc.constantFrom('```', '```js', 'a ```b``` c', '\n```\n', '````', '`', '``', 'x\n```lektor-edit\ny'));
const value = fc.letrec((tie) => ({
  v: fc.oneof({ depthSize: 'small' }, ticky, fc.integer(), fc.boolean(), fc.constant(null), fc.array(tie('v'), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 5 }), tie('v'), { maxKeys: 3 })),
})).v;
const prose = fc.oneof(fc.constantFrom('', 'Here you are.', 'Some `code` and ``` inline fences ```.', '```js\nconst a = 1;\n```', '```\nplain block\n```'), fc.string({ maxLength: 20 }).filter((s) => !s.includes('```lektor')));

describe('fenced blocks (INVARIANTS.md F1, B4)', () => {
  it('every block comes back whole, in order, as the JSON that was written; other code blocks are not blocks', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(prose, value, fc.boolean()), { minLength: 1, maxLength: 4 }), prose, fc.constantFrom('lektor-edit', 'lektor-findings'), (parts, tail, lang) => {
        const reply = parts.map(([before, v, pretty]) => `${before}\n\`\`\`${lang}\n${JSON.stringify(v, null, pretty ? 2 : 0)}\n\`\`\``).join('\n') + `\n${tail}`;
        const blocks = fencedBlocks(reply, lang);
        expect(blocks.map((b) => JSON.parse(b) as unknown)).toEqual(parts.map(([, v]) => JSON.parse(JSON.stringify(v)) as unknown));
        expect(fencedBlocks(reply, lang === 'lektor-edit' ? 'lektor-findings' : 'lektor-edit')).toEqual([]);
      }),
    );
  });

  it('fences count only at the start of a line; an unclosed block is not a block; an empty block is an empty body', () => {
    expect(fencedBlocks('```lektor-edit\n{"path": "a.md"} ```', 'lektor-edit')).toEqual([]);
    expect(fencedBlocks('```lektor-edit\n{"x": "```"}', 'lektor-edit')).toEqual([]);
    expect(fencedBlocks('```lektor-edit\n```', 'lektor-edit')).toEqual(['']);
    expect(fencedBlocks('Text\n  ```lektor-edit\n{"a": 1}\n   ```  \nmore', 'lektor-edit')).toEqual(['{"a": 1}']);
    // Only at the start of a line: inside another block's JSON, or mid-sentence, it doesn't open one.
    expect(fencedBlocks('Text ```lektor-edit\n{"a": 1}\n```', 'lektor-edit')).toEqual([]);
  });

  it('B4 regression: an edit whose text contains a code block is read whole (a note with code)', async () => {
    const note = 'Intro.\n\n```js\nconst a = 1\n```\n';
    const fenced = fencedEdits(
      { readNote: () => Promise.resolve(note), isExcluded: () => false, exists: () => true, newId: () => 'p1', now: () => 0 },
      new Set(['a.md']),
      MODEL,
    );
    const args = { path: 'a.md', edits: [{ find: '```js\nconst a = 1\n```', replace: '```js\nconst a = 1;\n```', reason: 'semicolon' }] };
    const r = await fenced.extract(`Fixed it:\n\`\`\`lektor-edit\n${JSON.stringify(args)}\n\`\`\`\nDone.`);
    expect(r.problems).toEqual([]);
    expect(r.proposals).toHaveLength(1);
  });
});
