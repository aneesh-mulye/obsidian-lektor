// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The core's view of HTTP. Implemented by src/obsidian/Http.ts, the only file
 * allowed to touch the network (INVARIANTS.md G7). Tests use in-memory fakes.
 */

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Response headers, names lower-cased (may be absent in fakes). */
  headers?: Record<string, string>;
  /** The response body as it arrives. */
  body: AsyncIterable<Uint8Array>;
}

export interface HttpClient {
  /** Rejects on network failure or abort; any HTTP status resolves. */
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Read a whole body as UTF-8 text, up to `limit` bytes (the rest is dropped). */
export async function readText(body: AsyncIterable<Uint8Array>, limit = 4 * 1024 * 1024): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  let seen = 0;
  for await (const chunk of body) {
    if (seen >= limit) break;
    const part = chunk.length + seen > limit ? chunk.subarray(0, limit - seen) : chunk;
    seen += part.length;
    out += decoder.decode(part, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * Streaming through `primary` (fetch), except for servers that refuse it before answering (CORS):
 * those get the request once through `fallback` (Obsidian's requestUrl, which doesn't stream), and
 * every later request goes there directly (INVARIANTS.md E4). Nothing is ever sent twice once a
 * response has started, and an abort is never retried.
 */
export class FallbackHttpClient implements HttpClient {
  #fallen = false;

  constructor(
    private readonly primary: HttpClient,
    private readonly fallback: HttpClient,
    /** Called once, the first time the fallback is used. */
    private readonly onFallback: () => void,
  ) {}

  /** Whether requests go to the fallback client now. */
  get fallen(): boolean {
    return this.#fallen;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    if (this.#fallen) return this.fallback.request(req);
    try {
      return await this.primary.request(req);
    } catch (err) {
      // An abort, or a failure we were told about after the user stopped, is final.
      if (req.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      const res = await this.fallback.request(req);
      this.#fallen = true;
      this.onFallback();
      return res;
    }
  }
}
