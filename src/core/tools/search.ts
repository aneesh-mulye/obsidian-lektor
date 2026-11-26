// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Web search providers (DESIGN.md § Search providers; INVARIANTS.md T4).
 * Request formats checked against each provider's documentation on 2026-11-26:
 * Tavily (POST /search, Bearer key, results[].content), Exa (POST /search,
 * x-api-key, contents.highlights), Brave (GET /res/v1/web/search,
 * X-Subscription-Token, web.results[].description), SearXNG (GET /search,
 * format=json — must be enabled on the server), DuckDuckGo (POST to its HTML
 * endpoint, no key; results parsed from the page).
 *
 * Results are reduced to plain text with bounded lengths and absolute
 * http(s) URLs only. Keys travel only in the documented header.
 */

import { z } from 'zod';
import { type HttpClient, type HttpRequest, readText } from '../http';
import { ProviderError } from '../providers/stream';
import type { SafeSearch, SearchProviderId } from '../settings';
import { normaliseUrl } from './urls';

export interface SearchOptions {
  count: number;
  safe: SafeSearch;
  /** Region or language hint ('' = provider default). */
  region: string;
}

export interface SearchAuth {
  key?: string;
  /** SearXNG's address. */
  baseUrl?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  id: Exclude<SearchProviderId, 'none'>;
  label: string;
  needsKey: boolean;
  search(query: string, options: SearchOptions, http: HttpClient, signal: AbortSignal, auth: SearchAuth): Promise<SearchResult[]>;
}

// ---------------------------------------------------------------------------
// Cleaning

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Markup to plain text: tags removed, entities decoded, whitespace collapsed, length bounded. */
export function plainText(s: string, max: number): string {
  const text = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    // eslint-disable-next-line no-control-regex -- control characters are exactly what we remove
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clean(raw: Array<{ title: string; url: string; snippet: string }>, count: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of raw) {
    const url = normaliseUrl(r.url);
    if (url === null) continue;
    out.push({ title: plainText(r.title, 300) || url, url, snippet: plainText(r.snippet, 1000) });
    if (out.length >= count) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared request handling

async function call<T>(http: HttpClient, req: HttpRequest, schema: z.ZodType<T>, label: string, errorOf: (body: unknown, status: number) => string | undefined): Promise<T> {
  const res = await http.request(req).catch((err: unknown) => {
    if (req.signal?.aborted) throw err;
    throw new ProviderError(`Could not reach ${label}.`);
  });
  const text = await readText(res.body, 8 * 1024 * 1024);
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (res.status !== 200) {
    // Only look inside object bodies: a provider may send `null`, a number or an array.
    const detail = typeof body === 'object' && body !== null ? errorOf(body, res.status) : undefined;
    throw new ProviderError(`${label} returned HTTP ${res.status}${detail ? `: ${plainText(detail, 200)}` : '.'}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ProviderError(`${label} sent a response Lektor could not read.`);
  return parsed.data;
}

function requireKey(auth: SearchAuth, label: string): string {
  if (!auth.key) throw new ProviderError(`No ${label} API key is set. Add one in Lektor's settings.`);
  return auth.key;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

// ---------------------------------------------------------------------------
// Providers

const Tavily = z.object({ results: z.array(z.object({ title: z.string().catch(''), url: z.string(), content: z.string().catch('') })) });

export const tavily: SearchProvider = {
  id: 'tavily',
  label: 'Tavily',
  needsKey: true,
  async search(query, o, http, signal, auth) {
    const key = requireKey(auth, 'Tavily');
    const data = await call(
      http,
      {
        url: 'https://api.tavily.com/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          query,
          max_results: Math.min(o.count, 20),
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          safe_search: o.safe !== 'off',
        }),
        signal,
      },
      Tavily,
      'Tavily',
      (b) => str((b as { detail?: { error?: unknown } }).detail?.error),
    );
    return clean(data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })), o.count);
  },
};

const Exa = z.object({
  results: z.array(z.object({ title: z.string().nullish(), url: z.string(), highlights: z.array(z.string()).nullish(), text: z.string().nullish() })),
});

export const exa: SearchProvider = {
  id: 'exa',
  label: 'Exa',
  needsKey: true,
  async search(query, o, http, signal, auth) {
    const key = requireKey(auth, 'Exa');
    const data = await call(
      http,
      {
        url: 'https://api.exa.ai/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          query,
          numResults: Math.min(o.count, 20),
          contents: { highlights: { maxCharacters: 500 } },
          moderation: o.safe !== 'off',
          ...(/^[a-z]{2}$/i.test(o.region) ? { userLocation: o.region.toUpperCase() } : {}),
        }),
        signal,
      },
      Exa,
      'Exa',
      (b) => str((b as { error?: unknown }).error),
    );
    return clean(data.results.map((r) => ({ title: r.title ?? '', url: r.url, snippet: (r.highlights ?? []).join(' … ') || (r.text ?? '') })), o.count);
  },
};

const Brave = z.object({
  web: z.object({ results: z.array(z.object({ title: z.string().catch(''), url: z.string(), description: z.string().catch('') })) }).optional(),
});

export const brave: SearchProvider = {
  id: 'brave',
  label: 'Brave Search',
  needsKey: true,
  async search(query, o, http, signal, auth) {
    const key = requireKey(auth, 'Brave Search');
    const params = new URLSearchParams({ q: query, count: String(Math.min(o.count, 20)), safesearch: o.safe });
    if (/^[a-z]{2}$/i.test(o.region)) params.set('country', o.region.toUpperCase());
    const data = await call(
      http,
      {
        url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
        signal,
      },
      Brave,
      'Brave Search',
      (b) => str((b as { error?: { detail?: unknown } }).error?.detail),
    );
    return clean((data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description })), o.count);
  },
};

const Searx = z.object({ results: z.array(z.object({ title: z.string().catch(''), url: z.string(), content: z.string().catch('') })) });

export const searxng: SearchProvider = {
  id: 'searxng',
  label: 'SearXNG',
  needsKey: false,
  async search(query, o, http, signal, auth) {
    if (!auth.baseUrl) throw new ProviderError("No SearXNG address is set. Add one in Lektor's settings.");
    const params = new URLSearchParams({ q: query, format: 'json', safesearch: String(o.safe === 'off' ? 0 : o.safe === 'moderate' ? 1 : 2) });
    if (o.region) params.set('language', o.region);
    try {
      const data = await call(http, { url: `${auth.baseUrl}/search?${params.toString()}`, method: 'GET', headers: { Accept: 'application/json' }, signal }, Searx, 'SearXNG', () => undefined);
      return clean(data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })), o.count);
    } catch (err) {
      if (err instanceof ProviderError && err.message.includes('HTTP 403')) {
        throw new ProviderError('This SearXNG server does not allow JSON results; "json" must be listed in search.formats in its settings.yml.');
      }
      throw err;
    }
  },
};

/** Parse DuckDuckGo's HTML results page (ads skipped; redirect links unwrapped). */
export function parseDuckDuckGo(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div class="result /).slice(1);
  for (const block of blocks) {
    if (/^[^"]*result--ad/.test(block)) continue;
    const link = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block) ?? /<a[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let href = plainText(link[1]!, 4000);
    if (href.startsWith('//')) href = `https:${href}`;
    try {
      const u = new URL(href, 'https://duckduckgo.com/');
      const target = u.hostname.endsWith('duckduckgo.com') ? u.searchParams.get('uddg') : null;
      href = target ?? u.href;
    } catch {
      continue;
    }
    const snippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
    out.push({ title: link[2]!, url: href, snippet });
  }
  return out;
}

export const duckduckgo: SearchProvider = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  needsKey: false,
  async search(query, o, http, signal) {
    const form = new URLSearchParams({ q: query, kp: o.safe === 'off' ? '-2' : o.safe === 'moderate' ? '-1' : '1' });
    if (o.region) form.set('kl', o.region);
    const res = await http
      .request({ url: 'https://html.duckduckgo.com/html/', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal })
      .catch((err: unknown) => {
        if (signal.aborted) throw err;
        throw new ProviderError('Could not reach DuckDuckGo.');
      });
    const html = await readText(res.body, 4 * 1024 * 1024);
    if (res.status !== 200) throw new ProviderError(`DuckDuckGo returned HTTP ${res.status}.`);
    return clean(parseDuckDuckGo(html), o.count);
  },
};

export const SEARCH_PROVIDER_LIST: readonly SearchProvider[] = [tavily, exa, brave, searxng, duckduckgo];

export function searchProvider(id: SearchProviderId): SearchProvider | null {
  return SEARCH_PROVIDER_LIST.find((p) => p.id === id) ?? null;
}
