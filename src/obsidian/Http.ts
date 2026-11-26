// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only file allowed to touch the network (eslint/gates.mjs, INVARIANTS.md G7).
 * Requests go exactly where the core asks, which is always a URL the user
 * configured (O2). Redirects are refused, so a server cannot bounce a request
 * somewhere else; no cookies or referrer are sent.
 */

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
    return { status: res.status, body: chunks(res) };
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
