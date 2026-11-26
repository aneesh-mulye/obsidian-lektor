// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md T4: search providers return clean results or a clear error. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest } from '../../src/core/http';
import { ProviderError } from '../../src/core/providers/stream';
import { type SearchProvider, brave, duckduckgo, exa, parseDuckDuckGo, searxng, tavily } from '../../src/core/tools/search';
import { normaliseUrl } from '../../src/core/tools/urls';

const KEY = 'sk-SECRET-KEY-123';
const enc = new TextEncoder();

const ENDPOINT: Record<string, string> = {
  tavily: 'https://api.tavily.com/search',
  exa: 'https://api.exa.ai/search',
  brave: 'https://api.search.brave.com/res/v1/web/search?',
  searxng: 'https://searx.example/search?',
  duckduckgo: 'https://html.duckduckgo.com/html/',
};
const KEY_HEADER: Record<string, [string, string] | null> = {
  tavily: ['Authorization', `Bearer ${KEY}`],
  exa: ['x-api-key', KEY],
  brave: ['X-Subscription-Token', KEY],
  searxng: null,
  duckduckgo: null,
};

const url = fc.oneof(
  fc.webUrl(),
  fc.constantFrom('javascript:alert(1)', '/relative/path', 'data:text/html,x', 'https://u:p@x.example/', 'mailto:a@b.c', '', 'https://ok.example/a?b=1#f'),
);
const text = fc.oneof(fc.string(), fc.constantFrom('<b>bold</b> &amp; &lt;script&gt;', '<img src=x onerror=alert(1)>', 'x'.repeat(5000), '&#x1F600; &#0; &bogus;'));
const item = fc.record({ title: text, url, snippet: text });

function bodyFor(id: string, items: Array<{ title: string; url: string; snippet: string }>): string {
  switch (id) {
    case 'tavily':
      return JSON.stringify({ query: 'q', results: items.map((i) => ({ title: i.title, url: i.url, content: i.snippet, score: 0.5 })) });
    case 'exa':
      return JSON.stringify({ results: items.map((i) => ({ title: i.title, url: i.url, highlights: [i.snippet] })) });
    case 'brave':
      return JSON.stringify({ web: { results: items.map((i) => ({ title: i.title, url: i.url, description: i.snippet })) } });
    case 'searxng':
      return JSON.stringify({ results: items.map((i) => ({ title: i.title, url: i.url, content: i.snippet })) });
    default:
      return items
        .map((i) => `<div class="result results_links web-result "><h2><a rel="nofollow" class="result__a" href="${i.url.replace(/"/g, '&quot;')}">${i.title}</a></h2><a class="result__snippet" href="x">${i.snippet}</a></div>`)
        .join('\n');
  }
}

const response = (id: string) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.array(item, { maxLength: 30 }).map((items) => ({ status: 200, body: bodyFor(id, items) })) },
    { weight: 1, arbitrary: fc.record({ status: fc.constantFrom(200, 400, 401, 403, 429, 432, 500), body: fc.oneof(fc.string(), fc.jsonValue().map((v) => JSON.stringify(v)), fc.constant('{"detail":{"error":"<b>bad key</b>"}}'), fc.constant('{"error":"out of credits"}')) }) },
  );

class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly reply: { status: number; body: string } | 'throw') {}
  request(req: HttpRequest) {
    this.requests.push(req);
    if (this.reply === 'throw') return Promise.reject(new Error('ECONNREFUSED'));
    const { status, body } = this.reply;
    return Promise.resolve({ status, body: (async function* () { await Promise.resolve(); yield enc.encode(body); })() });
  }
}

const PROVIDERS: SearchProvider[] = [tavily, exa, brave, searxng, duckduckgo];

describe('search providers (INVARIANTS.md T4)', () => {
  it('T4: clean results or a ProviderError; only the documented endpoint; key only in its header', async () => {
    const options = fc.record({ count: fc.integer({ min: 1, max: 20 }), safe: fc.constantFrom('off' as const, 'moderate' as const, 'strict' as const), region: fc.constantFrom('', 'us', 'de-de', 'wt-wt') });
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROVIDERS).chain((p) => fc.tuple(fc.constant(p), fc.oneof({ weight: 9, arbitrary: response(p.id) }, { weight: 1, arbitrary: fc.constant('throw' as const) }))),
        fc.string({ minLength: 1, maxLength: 50 }),
        options,
        async ([provider, reply], query, o) => {
          const http = new FakeHttp(reply);
          let results;
          try {
            results = await provider.search(query, o, http, new AbortController().signal, { key: KEY, baseUrl: 'https://searx.example' });
          } catch (err) {
            expect(err).toBeInstanceOf(ProviderError);
          }
          if (results) {
            expect(results.length).toBeLessThanOrEqual(o.count);
            for (const r of results) {
              expect(normaliseUrl(r.url)).toBe(r.url);
              // Markup from the source never survives. (Entity-encoded text such as "&lt;script&gt;" legitimately
              // decodes to the characters "<script>": it is plain text, rendered only as escaped text.)
              expect(r.title).not.toMatch(/<\/?(b|img)\b[^>]*>/i);
              expect(r.snippet).not.toMatch(/<\/?(b|img)\b[^>]*>/i);
              expect(r.title.length).toBeLessThanOrEqual(300);
              expect(r.snippet.length).toBeLessThanOrEqual(1000);
            }
          }
          expect(http.requests).toHaveLength(1);
          const req = http.requests[0]!;
          expect(req.url.startsWith(ENDPOINT[provider.id]!)).toBe(true);
          expect(req.url).not.toContain(KEY);
          expect(req.body ?? '').not.toContain(KEY);
          const header = KEY_HEADER[provider.id];
          if (header) expect(req.headers?.[header[0]]).toBe(header[1]);
          else expect(JSON.stringify(req.headers ?? {})).not.toContain(KEY);
        },
      ),
    );
  });

  // Regression (T4, CI run): an error status with the JSON body `null` crashed the error-message lookup.
  it('reports an error status whose body is JSON null as a ProviderError', async () => {
    for (const p of [tavily, exa, brave]) {
      const http = new FakeHttp({ status: 401, body: 'null' });
      await expect(p.search('q', { count: 5, safe: 'moderate', region: '' }, http, new AbortController().signal, { key: KEY })).rejects.toBeInstanceOf(ProviderError);
    }
  });

  it('refuses to search without a key, without making a request', async () => {
    for (const p of [tavily, exa, brave]) {
      const http = new FakeHttp({ status: 200, body: '{}' });
      await expect(p.search('q', { count: 5, safe: 'moderate', region: '' }, http, new AbortController().signal, {})).rejects.toBeInstanceOf(ProviderError);
      expect(http.requests).toEqual([]);
    }
  });

  it('parses DuckDuckGo results, skipping ads and unwrapping redirect links', () => {
    const html = `
      <div class="result results_links results_links_deep result--ad "><a rel="nofollow" class="result__a" href="https://ads.example/">Ad</a></div>
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://en.wikipedia.org/wiki/Skerryvore">Skerryvore - Wikipedia</a></h2>
        <a class="result__snippet" href="https://en.wikipedia.org/wiki/Skerryvore"><b>Skerryvore</b> is a remote reef &amp; lighthouse.</a>
      </div>
      <div class="result results_links web-result ">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nlb.org.uk%2Flighthouses%2Fskerryvore%2F&amp;rut=abc">NLB</a>
      </div>`;
    expect(parseDuckDuckGo(html).map((r) => r.url)).toEqual(['https://en.wikipedia.org/wiki/Skerryvore', 'https://www.nlb.org.uk/lighthouses/skerryvore/']);
  });

  it('explains a SearXNG server without JSON output', async () => {
    const http = new FakeHttp({ status: 403, body: 'Forbidden' });
    await expect(searxng.search('q', { count: 5, safe: 'moderate', region: '' }, http, new AbortController().signal, { baseUrl: 'https://searx.example' })).rejects.toThrow('search.formats');
  });
});
