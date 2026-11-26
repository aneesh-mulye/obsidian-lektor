// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md T1–T3: validated tool calls, caps, and fetch provenance. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { HttpClient, HttpRequest } from '../../src/core/http';
import { ToolBudget } from '../../src/core/tools/budget';
import { ToolRegistry } from '../../src/core/tools/registry';
import type { SearchProvider } from '../../src/core/tools/search';
import type { Tool, ToolContext } from '../../src/core/tools/types';
import { KnownUrls, extractUrls, normaliseUrl } from '../../src/core/tools/urls';
import { fetchPageTool, webSearchTool } from '../../src/core/tools/web';
import { PROSE, toolRuns } from '../../src/core/tools/run';
import type { Chat } from '../../src/core/chat/types';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import type { Capabilities } from '../../src/core/providers/types';
import { DISPLAY_MODES } from '../../src/core/settings';

const enc = new TextEncoder();

/** Records every request; answers with a small HTML page. */
class RecordingHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  request(req: HttpRequest) {
    this.requests.push(req);
    async function* body() {
      await Promise.resolve();
      yield enc.encode('<html><title>T</title><body>hello</body></html>');
    }
    return Promise.resolve({ status: 200, headers: { 'content-type': 'text/html' }, body: body() });
  }
}

const extractor = { extract: (html: string) => ({ title: 'T', text: html.replace(/<[^>]+>/g, ' ') }) };

/** A search provider that returns fixed results without the network. */
const fakeSearch = (urls: string[]): SearchProvider => ({
  id: 'tavily',
  label: 'Fake',
  needsKey: false,
  search: () => Promise.resolve(urls.map((url, i) => ({ title: `r${i}`, url, snippet: 's' }))),
});

function context(approvals: boolean[] = [], known = new KnownUrls()): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    signal: new AbortController().signal,
    knownUrls: known,
    editable: new Set<string>(),
    model: null,
    asked,
    approve: (req) => {
      asked.push(req.detail);
      return Promise.resolve(approvals.shift() ?? false);
    },
  };
}

// ---------------------------------------------------------------------------

describe('ToolRegistry (INVARIANTS.md T1)', () => {
  it('T1: run is called only for enabled tools with schema-valid arguments', async () => {
    let runs: unknown[] = [];
    const echo: Tool<{ n: number; s?: string | undefined }> = {
      name: 'echo',
      description: 'd',
      schema: z.object({ n: z.int().min(0).max(9), s: z.string().optional() }),
      approval: 'never',
      touchesVault: false,
      run: (args) => {
        runs.push(args);
        return Promise.resolve({ content: 'ok', summary: 'ok' });
      },
    };
    const registry = new ToolRegistry();
    registry.register(echo);
    const args = fc.oneof(
      fc.jsonValue(),
      fc.record({ n: fc.integer({ min: -3, max: 12 }) }),
      fc.record({ n: fc.nat({ max: 9 }), s: fc.string(), extra: fc.jsonValue() }),
      fc.nat({ max: 9 }).map((n) => JSON.stringify({ n })),
      fc.constant('{bad json'),
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('echo', 'missing', 'Echo'), args, fc.boolean(), async (name, a, enabled) => {
        runs = [];
        const result = await registry.execute({ id: 'c', name, arguments: a }, new Set(enabled ? ['echo'] : []), new ToolBudget({ searches: 5, fetches: 5 }), context());
        const parsed = typeof a === 'string' ? (() => { try { return JSON.parse(a) as unknown; } catch { return a; } })() : a;
        const valid = name === 'echo' && enabled && echo.schema.safeParse(parsed).success;
        expect(result.ok).toBe(valid);
        expect(runs.length).toBe(valid ? 1 : 0);
        if (!valid) expect(result.content.length).toBeGreaterThan(0);
      }),
    );
  });

  it('describes enabled tools as JSON Schema', () => {
    const registry = new ToolRegistry();
    registry.register(webSearchTool(() => null, new RecordingHttp()));
    const [def] = registry.definitions(['web_search']);
    expect(def).toMatchObject({ name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } });
    expect(registry.definitions(['nope'])).toEqual([]);
  });
});

describe('caps (INVARIANTS.md T2, design invariant 9)', () => {
  it('T2: executed searches and fetches never exceed their caps within a message', async () => {
    const call = fc.oneof(
      fc.constantFrom('a', 'b', '').map((q) => ({ name: 'web_search', arguments: { query: q } })),
      fc.constantFrom('https://known.example/a', 'https://other.example/x', 'ftp://x').map((u) => ({ name: 'fetch_page', arguments: { url: u } })),
    );
    const step = fc.oneof({ weight: 8, arbitrary: call.map((c) => ({ kind: 'call' as const, ...c })) }, { weight: 1, arbitrary: fc.constant({ kind: 'newMessage' as const }) });
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 6 }), fc.nat({ max: 6 }), fc.array(step, { maxLength: 40, size: 'large' }), fc.array(fc.boolean(), { maxLength: 40 }), async (searchCap, fetchCap, steps, approvals) => {
        const http = new RecordingHttp();
        let searches = 0;
        const provider: SearchProvider = { ...fakeSearch(['https://known.example/a']), search: () => { searches += 1; return Promise.resolve([{ title: 't', url: 'https://known.example/a', snippet: 's' }]); } };
        const registry = new ToolRegistry();
        registry.register(webSearchTool(() => ({ provider, options: { count: 5, safe: 'moderate', region: '' }, auth: {} }), http));
        registry.register(fetchPageTool(http, extractor, () => 4000));
        const enabled = new Set(['web_search', 'fetch_page']);
        const ctx = context([...approvals], new KnownUrls());
        let budget = new ToolBudget({ searches: searchCap, fetches: fetchCap });
        let s0 = 0;
        let f0 = 0;
        for (const st of steps) {
          if (st.kind === 'newMessage') {
            budget = new ToolBudget({ searches: searchCap, fetches: fetchCap });
            s0 = searches;
            f0 = http.requests.length;
            continue;
          }
          const before = { s: searches, f: http.requests.length };
          const result = await registry.execute({ id: 'c', name: st.name, arguments: st.arguments }, enabled, budget, ctx);
          if (result.limit) {
            expect(searches).toBe(before.s); // no request made over the cap
            expect(http.requests.length).toBe(before.f);
          }
          expect(searches - s0).toBeLessThanOrEqual(searchCap);
          expect(http.requests.length - f0).toBeLessThanOrEqual(fetchCap);
        }
      }),
    );
  });
});

describe('fetch provenance (INVARIANTS.md T3)', () => {
  const KNOWN = ['https://known.example/page?a=1', 'http://plain.example/x', 'https://en.wikipedia.org/wiki/Skerryvore_(island)'];
  const variants = (u: string): string[] => [
    u,
    u.replace('https://known.example', 'https://KNOWN.example'),
    `${u}#section`,
    `${u}&q=SECRET`,
    `${u}/../evil`,
    u.replace('https://', 'http://').replace('http://plain', 'https://plain'),
    u.replace(/^(https?:\/\/)/, '$1known.example@evil.example/'),
    u.replace('.example', '.example:8443'),
    u.replace('known', 'knоwn'), // Cyrillic о
    `javascript:fetch('${u}')`,
    `file:///etc/passwd`,
    `${u} `,
  ];

  it('T3: unknown URLs are asked about first; denied or non-http(s) URLs make no request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...KNOWN).chain((k) => fc.constantFrom(...variants(k))), fc.boolean(), async (url, approve) => {
        const http = new RecordingHttp();
        const known = new KnownUrls();
        for (const k of KNOWN) known.add(k);
        const ctx = context([approve], known);
        const registry = new ToolRegistry();
        registry.register(fetchPageTool(http, extractor, () => 4000));
        const result = await registry.execute({ id: 'c', name: 'fetch_page', arguments: { url } }, new Set(['fetch_page']), new ToolBudget({ searches: 5, fetches: 5 }), ctx);

        const normal = normaliseUrl(url);
        const isKnown = normal !== null && KNOWN.some((k) => normaliseUrl(k) === normal);
        if (normal === null) {
          expect(http.requests).toEqual([]);
          expect(ctx.asked).toEqual([]);
          expect(result.ok).toBe(false);
        } else if (isKnown) {
          expect(ctx.asked).toEqual([]);
          expect(http.requests.map((r) => r.url)).toEqual([normal]);
        } else {
          expect(ctx.asked).toEqual([normal]);
          expect(http.requests.map((r) => r.url)).toEqual(approve ? [normal] : []);
          expect(result.ok).toBe(approve);
        }
      }),
    );
  });

  it('normalisation only lower-cases the host and drops the fragment', () => {
    expect(normaliseUrl('https://Known.Example/Page?A=1#x')).toBe('https://known.example/Page?A=1');
    expect(normaliseUrl('https://user:pw@known.example/')).toBeNull();
    expect(normaliseUrl('ftp://known.example/')).toBeNull();
    expect(normaliseUrl('not a url')).toBeNull();
  });

  it('search results, the user’s messages and attached notes make URLs known', async () => {
    expect(extractUrls('See https://a.example/x, and (https://b.example/y). Also [c](https://c.example/z_(1)) and <https://d.example/>.')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
      'https://c.example/z_(1)',
      'https://d.example/',
    ]);
    const http = new RecordingHttp();
    const registry = new ToolRegistry();
    registry.register(webSearchTool(() => ({ provider: fakeSearch(['https://found.example/r']), options: { count: 5, safe: 'moderate', region: '' }, auth: {} }), http));
    const result = await registry.execute({ id: 'c', name: 'web_search', arguments: { query: 'q' } }, new Set(['web_search']), new ToolBudget({ searches: 5, fetches: 5 }), context());
    expect(result.urls).toEqual(['https://found.example/r']);
  });

  it('fetched pages are framed as untrusted and cut to the token limit', async () => {
    const big = 'word '.repeat(20000);
    const http: HttpClient = {
      request: () => Promise.resolve({ status: 200, headers: { 'content-type': 'text/plain' }, body: (async function* () { await Promise.resolve(); yield enc.encode(big); })() }),
    };
    const known = new KnownUrls();
    known.add('https://a.example/');
    const registry = new ToolRegistry();
    registry.register(fetchPageTool(http, extractor, () => 1000));
    const r = await registry.execute({ id: 'c', name: 'fetch_page', arguments: { url: 'https://a.example/' } }, new Set(['fetch_page']), new ToolBudget({ searches: 5, fetches: 5 }), context([], known));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('untrusted');
    expect(r.content).toContain('[The page was cut off here.]');
    expect(new TextEncoder().encode(r.content).length).toBeLessThan(3000 + 600);
  });
});

// ---------------------------------------------------------------------------
// INVARIANTS.md B5: Prose mode proposes nothing.

describe('display modes (INVARIANTS.md B5)', () => {
  const stub = (name: string): Tool => ({
    name,
    description: name,
    schema: z.object({}),
    approval: 'never',
    touchesVault: false,
    run: () => Promise.resolve({ content: '', summary: '' }),
  });
  const registry = new ToolRegistry();
  for (const n of ['web_search', 'fetch_page', 'propose_edit', 'propose_note']) registry.register(stub(n));
  const fenced = { instructions: 'FENCED', extract: () => Promise.resolve({ proposals: [], problems: [] }) };

  it('B5: a Prose chat is never offered edit tools or fenced instructions, and is told to describe changes', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...DISPLAY_MODES), { nil: undefined }),
        fc.constantFrom(...DISPLAY_MODES),
        fc.constantFrom<Capabilities['toolCalling'][]>('native', 'mcp', 'fenced', 'none'),
        fc.array(fc.constantFrom('a.md', 'b.md'), { maxLength: 2 }),
        fc.boolean(),
        fc.subarray(['web_search', 'fetch_page']),
        (mode, fallback, toolCalling, editable, toolsDisabled, web) => {
          const runs = toolRuns(registry, {
            webNames: () => web,
            reviewNames: () => ['propose_edit', 'propose_note'],
            displayMode: () => fallback,
            limits: () => ({ searches: 3, fetches: 3 }),
            fenced: () => fenced,
          });
          const chat: Chat = {
            id: 'c', title: '', createdAt: 0, updatedAt: 0, model: null, messages: [], context: EMPTY_CONTEXT,
            ...(mode ? { displayMode: mode } : {}),
            ...(toolsDisabled ? { toolsDisabled } : {}),
          };
          const run = runs.forReply({ chat, capabilities: { toolCalling, nativeWebSearch: false, images: false, contextWindow: 8192 }, contextUrls: [], editable });
          const names = (run?.definitions ?? []).map((d) => d.name);
          if ((mode ?? fallback) === 'prose') {
            expect(names).not.toContain('propose_edit');
            expect(names).not.toContain('propose_note');
            expect(run?.fenced).toBeUndefined();
            expect(run?.instructions).toBe(PROSE);
          } else {
            expect(run?.instructions).toBeUndefined();
            if (toolCalling === 'native') {
              expect(names.includes('propose_edit')).toBe(editable.length > 0);
              expect(names).toContain('propose_note');
            } else {
              expect(run?.fenced !== undefined).toBe(editable.length > 0);
            }
          }
        },
      ),
    );
  });
});
