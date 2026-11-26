// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only file allowed to touch the network (eslint/gates.mjs, INVARIANTS.md G7).
 * Requests go exactly where the core asks, which is always a URL the user
 * configured (O2). Redirects are refused, so a server cannot bounce a request
 * somewhere else; no cookies or referrer are sent.
 */

import { requestUrl } from 'obsidian';
import type { HttpClient, HttpRequest, HttpResponse } from '../core/http';

export class FetchHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: res.status, headers, body: chunks(res) };
  }
}

/**
 * Tool HTTP (search providers, fetch_page) through Obsidian's requestUrl, as
 * DESIGN.md § Network asks: no CORS limits, one place for it all. It does not
 * stream, which tools don't need. It has no abort, so an aborted request is
 * abandoned: the caller is released at once and the late response discarded.
 */
export class RequestUrlHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const contentType = req.headers?.['Content-Type'];
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).filter(([k]) => k !== 'Content-Type'));
    const pending = requestUrl({
      url: req.url,
      method: req.method,
      headers,
      ...(contentType ? { contentType } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
      throw: false,
    });
    const aborted = new Promise<never>((_, reject) => {
      req.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const res = await Promise.race([pending, aborted]);
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) lower[k.toLowerCase()] = v;
    const bytes = new Uint8Array(res.arrayBuffer);
    return {
      status: res.status,
      headers: lower,
      body: (async function* () {
        await Promise.resolve();
        yield bytes;
      })(),
    };
  }
}

async function* chunks(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Cancels the request if the consumer stops early (e.g. Stop was pressed).
    await reader.cancel().catch(() => undefined);
  }
}
