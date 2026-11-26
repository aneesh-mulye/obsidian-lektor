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
