// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The punycode stand-in markdown-it gets (src/obsidian/ui/punycode.ts): links to international domains still work. */

import fc from 'fast-check';
import { toASCII as realToASCII } from 'node:punycode';
import { describe, expect, it } from 'vitest';
import stand from '../../src/obsidian/ui/punycode';
import { renderSafeMarkdown } from '../../src/obsidian/ui/markdown';

describe('punycode stand-in', () => {
  // Names whose letters the URL standard maps to themselves. Elsewhere (capitals, Greek final sigma, …)
  // punycode.js skips the standard's mapping and the URL parser is right: it is what the browser opens.
  it('toASCII agrees with punycode.js (the same code ships in Node) wherever the URL standard maps nothing', () => {
    const label = fc.stringMatching(/^[a-z0-9äöüéèñçøåæœ日本語中文한국어русский-]{1,12}$/).filter((l) => !l.startsWith('-') && !l.endsWith('-') && !/^..--/.test(l));
    fc.assert(
      fc.property(fc.array(label, { minLength: 1, maxLength: 3 }), fc.constantFrom('example', 'com', 'org'), (labels, tld) => {
        const host = [...labels, tld].join('.');
        let want: string;
        try {
          want = realToASCII(host).toLowerCase();
        } catch {
          return;
        }
        let parsed: string;
        try {
          parsed = new URL(`http://${want}/`).hostname;
        } catch {
          return; // a name the URL standard itself refuses: no link either way
        }
        expect(stand.toASCII(host)).toBe(parsed);
      }),
    );
  });

  it('markdown-it uses it: a link to an international domain points at its ASCII form; link text stays as written', () => {
    const html = renderSafeMarkdown('See https://bücher.example/a and [shop](https://bücher.example/b) and https://xn--bcher-kva.example/c.');
    expect(html).toContain('href="https://xn--bcher-kva.example/a"');
    expect(html).toContain('href="https://xn--bcher-kva.example/b"');
    expect(html).toContain('>https://bücher.example/a<');
    // An ASCII-form link is not turned into look-alike letters.
    expect(html).toContain('>https://xn--bcher-kva.example/c<');
  });
});
