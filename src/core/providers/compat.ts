// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the OpenAI- and Anthropic-compatible adapters share (DESIGN.md §
 * Backends; INVARIANTS.md E2–E4): the endpoint's settings and key, requests
 * that go only to that endpoint, error messages that never carry the key, and
 * the notice when a server can't stream to Obsidian.
 */

import { FallbackHttpClient, type HttpClient, type HttpRequest, type HttpResponse, readText } from '../http';
import type { ReadonlyEndpoint } from '../settings';
import { ProviderError } from './stream';

export interface EndpointAccess {
  /** The endpoint's current settings (read on every call, so edits apply at once). */
  settings: () => ReadonlyEndpoint;
  /** The API key from SecretStorage ('' for none). Throws if the named secret is missing. */
  key: () => string;
  /** Streams through fetch; `fallback` is Obsidian's requestUrl. */
  http: HttpClient;
  fallback: HttpClient;
}

export const NO_STREAMING =
  'This server doesn’t allow Obsidian to stream replies (CORS), so replies arrive all at once. Allowing the origin app://obsidian.md on the server fixes that.';

/** One endpoint's HTTP: fetch first, requestUrl after a CORS refusal (INVARIANTS.md E4). */
export class EndpointHttp {
  readonly #client: FallbackHttpClient;
  #told = false;
  #fellBack = false;

  constructor(
    readonly access: EndpointAccess,
    private readonly label: () => string,
  ) {
    this.#client = new FallbackHttpClient(access.http, access.fallback, () => (this.#fellBack = true));
  }

  /** The notice for this reply, once: the first reply that had to fall back. */
  takeNotice(): string | null {
    if (!this.#fellBack || this.#told) return null;
    this.#told = true;
    return NO_STREAMING;
  }

  /** Send a request; a connection failure (not an abort) names the server it could not reach. */
  async send(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.#client.request(req);
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw new ProviderError(`Could not reach ${this.label()} at ${this.access.settings().baseUrl}. Is it running?`);
    }
  }

  /** The text of an error response, as a message that never contains the key (INVARIANTS.md E3). */
  async error(res: HttpResponse, key: string): Promise<ProviderError> {
    const body = await readText(res.body, 64 * 1024).catch(() => '');
    return new ProviderError(scrub(`${this.label()}: ${serverMessage(body) ?? `HTTP ${res.status}`}`, key));
  }
}

/** The message in a JSON error body ({"error": "…"} or {"error": {"message": "…"}}), if any. */
export function serverMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = parsed.error;
    if (typeof e === 'string' && e) return e.slice(0, 500);
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return ((e as { message: string }).message || '').slice(0, 500) || null;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message.slice(0, 500);
  } catch {
    // not JSON
  }
  return null;
}

/** Remove a key (and any long run of it) from text that will be shown or stored. */
export function scrub(text: string, key: string): string {
  if (key.length < 4) return text;
  return text.split(key).join('[key]');
}

/** The server's root: the base URL without a trailing `/v1`. */
export function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/, '');
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Tool-call arguments as the model sent them: parsed if they are JSON, else the raw text for the registry to reject. */
export function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  const parsed = tryJson(raw);
  return parsed === undefined ? raw : parsed;
}
