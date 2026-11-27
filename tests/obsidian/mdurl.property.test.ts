// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Lektor's copy of mdurl's parse (src/obsidian/ui/mdurl-parse.ts) gives exactly what mdurl's own
 * gives, for every input; only the way it checks host labels differs (no split and join).
 */

import fc from 'fast-check';
import realParse from 'mdurl/lib/parse.mjs';
import { describe, expect, it } from 'vitest';
import parse from '../../src/obsidian/ui/mdurl-parse';
import { renderSafeMarkdown } from '../../src/obsidian/ui/markdown';

const fields = (u: object) => {
  const r = u as Record<string, unknown>;
  return { protocol: r['protocol'], slashes: r['slashes'], auth: r['auth'], port: r['port'], hostname: r['hostname'], hash: r['hash'], search: r['search'], pathname: r['pathname'] };
};

/** Label characters, weighted towards the edge cases mdurl's host check handles. */
const ch = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...'abcxyzABZ0189-_+') },
  { weight: 2, arbitrary: fc.constantFrom('ü', 'é', '日', 'ж', '😀') },
  { weight: 2, arbitrary: fc.constantFrom('%', '!', '*', '~', "'", ' ', ' ', ' ', '$', '&', '=', ',', '(', ')', ':', '@', '\\', '|', '^', '{', '<', '"', '`') },
);
const label = fc.oneof({ weight: 8, arbitrary: fc.array(ch, { maxLength: 10 }).map((a) => a.join('')) }, { weight: 1, arbitrary: fc.integer({ min: 60, max: 70 }).map((n) => 'a'.repeat(n)) });
const host = fc.oneof(
  { weight: 8, arbitrary: fc.array(label, { minLength: 1, maxLength: 4 }).map((ls) => ls.join('.')) },
  { weight: 1, arbitrary: fc.constantFrom('[::1]', '[2001:db8::1]', '[bad', '', '.', '..', 'a..b', 'x'.repeat(260)) },
);
const url = fc.oneof(
  {
    weight: 8,
    arbitrary: fc
      .record({
        proto: fc.constantFrom('', 'http:', 'https:', 'HTTPS:', 'mailto:', 'javascript:', 'ftp:', 'file:', 'foo+bar:', 'x:'),
        slashes: fc.constantFrom('', '//', '///', '\\\\', '/'),
        auth: fc.constantFrom('', 'u@', 'u:p@', 'a@b@', '@'),
        host,
        port: fc.constantFrom('', ':80', ':', ':8x', ':0'),
        path: fc.constantFrom('', '/', '/a/b', '/ä ö', ':foo', '/x.y.z'),
        query: fc.constantFrom('', '?', '?a=1&b=2', '?x#y'),
        hash: fc.constantFrom('', '#', '#frag', '#a#b'),
        pad: fc.constantFrom('', ' ', '\t'),
      })
      .map((p) => `${p.pad}${p.proto}${p.slashes}${p.auth}${p.host}${p.port}${p.path}${p.query}${p.hash}${p.pad}`),
  },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.webUrl({ withQueryParameters: true, withFragments: true }) },
);

describe("Lektor's copy of mdurl's parse", () => {
  it('gives exactly the fields mdurl gives, for any input, with and without slashesDenoteHost', () => {
    fc.assert(
      fc.property(url, fc.constantFrom(undefined, true, false), (u, s) => {
        expect(fields(parse(u, s))).toEqual(fields(realParse(u, s)));
      }),
    );
  });

  it('markdown-it uses it: links in replies are still tidied and made safe as before', () => {
    expect(renderSafeMarkdown('[a](https://Example.com/a%20b?x=1#y)')).toContain('href="https://example.com/a%20b?x=1#y"');
    expect(renderSafeMarkdown('[a](<https://example.com/a b>)')).toContain('href="https://example.com/a%20b"');
    expect(renderSafeMarkdown('<https://bad host.example/x>')).not.toContain('href="https://bad host');
    expect(renderSafeMarkdown('[x](javascript:alert(1))')).not.toContain('href');
  });
});
