// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md R1: rendered model output cannot load anything or run anything. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderSafeMarkdown } from '../../src/obsidian/ui/markdown';

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g;
const ATTR = /\s+([^\s=>/]+)(?:="([^"]*)")?/g;

function decode(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function attrOk(tag: string, name: string, raw: string | undefined): boolean {
  const value = decode(raw ?? '');
  if (/^on/i.test(name)) return false;
  switch (`${tag}.${name}`) {
    case 'a.href':
      // eslint-disable-next-line no-control-regex -- control characters in a URL are exactly what must be rejected
      return /^(https?:|mailto:)/i.test(value) && !/[\s\u0000-\u001f]/.test(value);
    case 'a.rel':
      return value === 'noopener noreferrer';
    case 'a.target':
      return value === '_blank';
    case 'a.class':
      return value === 'external-link';
    case 'code.class':
      return /^language-/.test(value);
    case 'th.style':
    case 'td.style':
      return /^text-align:(left|right|center)$/.test(value);
    case 'ol.start':
      return /^\d+$/.test(value);
    default:
      return false;
  }
}

/** Throws with a description of the first unsafe construct in `html`. */
function assertSafe(html: string): void {
  for (const m of html.matchAll(TAG)) {
    const tag = m[1]!.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) throw new Error(`tag <${tag}> in ${html}`);
    for (const a of (m[2] ?? '').matchAll(ATTR)) {
      if (!attrOk(tag, a[1]!.toLowerCase(), a[2])) throw new Error(`attribute ${a[1]}="${a[2]}" on <${tag}> in ${html}`);
    }
  }
  // Text is escaped, so any '<' left once the tags are removed means markup we did not recognise.
  const rest = html.replace(TAG, '');
  if (rest.includes('<')) throw new Error(`unrecognised markup in ${html}`);
}

const SCHEMES = [
  'javascript:', 'JaVaScRiPt:', ' javascript:', 'java\tscript:', 'java&#x09;script:', '&#106;avascript:',
  'javascript&#58;', 'data:text/html,', 'data:image/svg+xml,', 'vbscript:', 'file:', 'obsidian:', 'app:',
  'blob:', 'about:', '//evil.example', '\\\\evil', 'http:', 'https:', 'mailto:',
];
const url = fc.tuple(fc.constantFrom(...SCHEMES), fc.constantFrom('', 'alert(1)', '//x.example/a?b=c', 'open?vault=v&file=f', 'x@y.z'))
  .map(([s, rest]) => s + rest);

const PARTS: fc.Arbitrary<string> = fc.oneof(
  url.map((u) => `![alt](${u})`),
  url.map((u) => `![alt][r]\n\n[r]: ${u}`),
  url.map((u) => `[text](${u})`),
  fc.constantFrom('https://example.com', 'mailto:a@b.c').map((u) => `[t](${u} "title")`),
  url.map((u) => `[text][r]\n\n[r]: ${u} "title"`),
  url.map((u) => `[![img](${u})](${u})`),
  url.map((u) => `<${u}>`),
  url,
  fc.constantFrom(
    '<img src=x onerror=alert(1)>', '<iframe src="https://evil.example"></iframe>', '<script>alert(1)</script>',
    '<svg onload=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<style>@import url(https://evil.example)</style>',
    '<video src=x>', '<link rel=stylesheet href=//evil.example>', '<details open ontoggle=alert(1)>',
    '<!-- comment -->', '<div style="background:url(https://evil.example)">', '&lt;img src=x&gt;',
    '| a | b |\n|:-|-:|\n| <img src=x> | ![i](https://e.example/i.png) |',
    '```js" onmouseover="alert(1)\ncode\n```', '`<img src=x>`', '    <img src=x>', '> quote <b>x</b>',
    '1. one\n2. two', '5) five', '# H\n## H2', '**bold** _em_ ~~s~~', '---', 'line\nbreak', 'https://example.com/bare',
    'www.example.com', 'mailto:a@b.c', '![[Embedded note]]', '[[Wiki link]]',
  ),
  fc.string({ maxLength: 40 }),
);

const adversarial = fc.array(PARTS, { minLength: 1, maxLength: 6 }).chain((parts) =>
  fc.array(fc.constantFrom(' ', '\n', '\n\n', '', ' | '), { minLength: parts.length, maxLength: parts.length })
    .map((seps) => parts.map((p, i) => p + seps[i]).join('')),
);

describe('renderSafeMarkdown (INVARIANTS.md R1)', () => {
  it('R1: output is only allow-listed tags and attributes, with safe links', () => {
    fc.assert(
      fc.property(fc.oneof(adversarial, fc.string(), fc.string({ unit: 'binary' })), (md) => {
        assertSafe(renderSafeMarkdown(md));
      }),
    );
  });

  it('renders ordinary Markdown', () => {
    expect(renderSafeMarkdown('**Hi** there')).toBe('<p><strong>Hi</strong> there</p>\n');
    expect(renderSafeMarkdown('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" class="external-link" target="_blank" rel="noopener noreferrer">site</a></p>\n',
    );
    expect(renderSafeMarkdown('```ts\nconst x = 1;\n```')).toContain('<code class="language-ts">');
  });

  it('shows images and unsafe links as inert text', () => {
    expect(renderSafeMarkdown('![x](https://evil.example/p.png)')).not.toContain('<img');
    expect(renderSafeMarkdown('![x](https://evil.example/p.png)')).toBe('<p>[image: x — https://evil.example/p.png]</p>\n');
    expect(renderSafeMarkdown('[![x](https://e.example/i.png)](https://e.example)')).not.toContain('<img');
    expect(renderSafeMarkdown('[x](javascript:alert(1))')).not.toContain('href');
    expect(renderSafeMarkdown('[x](obsidian://open?file=a)')).not.toContain('href');
    expect(renderSafeMarkdown('<b>x</b>')).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>\n');
  });

  it('the checker itself rejects unsafe markup', () => {
    expect(() => assertSafe('<img src="x">')).toThrow();
    expect(() => assertSafe('<a href="javascript:alert(1)">x</a>')).toThrow();
    expect(() => assertSafe('<p onclick="x">x</p>')).toThrow();
    expect(() => assertSafe('<p>x</p><scr<script>ipt>')).toThrow();
  });
});
