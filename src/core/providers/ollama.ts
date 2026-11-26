// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ollama via its native API (`/api/tags`, `/api/show`, `/api/chat`).
 * Checked against Ollama 0.40.17 on 2026-11-26: thinking arrives in
 * `message.thinking`, the last line has `done: true` with `done_reason`,
 * `prompt_eval_count` and `eval_count`, and errors are `{"error": "…"}`.
 */

import { z } from 'zod';
import { type HttpClient, type HttpRequest, type HttpResponse, readText } from '../http';
import { decodeNdjson } from './ndjson';
import { ProviderError, guardStream } from './stream';
import type { Capabilities, ChatEvent, ChatProvider, ChatRequest, ModelInfo } from './types';

const Tags = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      details: z.object({ context_length: z.number().int().positive().optional() }).optional(),
    }),
  ),
});

const Show = z.object({
  capabilities: z.array(z.string()),
  model_info: z.record(z.string(), z.unknown()).optional(),
});

const Line = z.object({
  error: z.unknown().optional(),
  message: z.object({ content: z.string().optional(), thinking: z.string().optional() }).optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

interface ShowInfo {
  capabilities: string[];
  contextWindow: number | undefined;
}

function httpError(status: number, body: string): ProviderError {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return new ProviderError(`Ollama: ${parsed.error}`);
  } catch {
    // not JSON
  }
  return new ProviderError(`Ollama returned HTTP ${status}.`);
}

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderError(`Ollama sent an unreadable ${what} response.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderError(`Ollama sent an unexpected ${what} response.`);
  return parsed.data;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class OllamaProvider implements ChatProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama';
  readonly #show = new Map<string, Promise<ShowInfo>>();

  /** `baseUrl` is read on every call, so a settings change applies at once. */
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: () => string,
  ) {}

  private url(endpoint: 'tags' | 'show' | 'chat'): string {
    return `${this.baseUrl()}/api/${endpoint}`;
  }

  /** Send a request; a connection failure (not an abort) names the server it could not reach. */
  private async send(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.http.request(req);
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw new ProviderError(`Could not reach Ollama at ${this.baseUrl()}. Is it running?`);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.send({ url: this.url('tags'), method: 'GET' });
    const text = await readText(res.body);
    if (res.status !== 200) throw httpError(res.status, text);
    return parseJson(Tags, text, 'model list').models.map((m) => ({
      id: m.name,
      name: m.name,
      ...(m.details?.context_length !== undefined ? { contextWindow: m.details.context_length } : {}),
    }));
  }

  async capabilities(model: string): Promise<Capabilities> {
    const info = await this.show(model);
    if (info.contextWindow === undefined) throw new ProviderError(`Ollama did not report a context length for ${model}.`);
    return {
      toolCalling: info.capabilities.includes('tools') ? 'native' : 'none',
      nativeWebSearch: false,
      images: info.capabilities.includes('vision'),
      contextWindow: info.contextWindow,
    };
  }

  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return guardStream(() => this.rawStream(req, signal), signal);
  }

  private show(model: string, signal?: AbortSignal): Promise<ShowInfo> {
    const key = `${this.baseUrl()}\n${model}`;
    let pending = this.#show.get(key);
    if (!pending) {
      pending = (async () => {
        const res = await this.send({
          url: this.url('show'),
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ model }),
          ...(signal ? { signal } : {}),
        });
        const text = await readText(res.body);
        if (res.status !== 200) throw httpError(res.status, text);
        const show = parseJson(Show, text, 'model details');
        const ctx = Object.entries(show.model_info ?? {}).find(([k, v]) => k.endsWith('.context_length') && typeof v === 'number');
        return { capabilities: show.capabilities, contextWindow: ctx ? (ctx[1] as number) : undefined };
      })();
      this.#show.set(key, pending);
      pending.catch(() => this.#show.delete(key));
    }
    return pending;
  }

  private async *rawStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const info = await this.show(req.model, signal);
    const body = {
      model: req.model,
      messages: req.messages.map(({ role, content }) => ({ role, content })),
      stream: true,
      ...(info.capabilities.includes('thinking') ? { think: true } : {}),
    };
    const res = await this.send({
      url: this.url('chat'),
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal,
    });
    if (res.status !== 200) throw httpError(res.status, await readText(res.body).catch(() => ''));

    for await (const item of decodeNdjson(res.body)) {
      if (!item.ok) throw new ProviderError('Ollama sent a line Lektor could not read.');
      const parsed = Line.safeParse(item.value);
      if (!parsed.success) throw new ProviderError('Ollama sent an unexpected line.');
      const line = parsed.data;
      if (line.error !== undefined) {
        throw new ProviderError(typeof line.error === 'string' && line.error ? `Ollama: ${line.error}` : 'Ollama reported an error.');
      }
      if (line.message?.thinking) yield { type: 'reasoning', text: line.message.thinking };
      if (line.message?.content) yield { type: 'text', text: line.message.content };
      if (line.done) {
        const input = line.prompt_eval_count;
        const output = line.eval_count;
        if (input !== undefined || output !== undefined) {
          yield { type: 'usage', ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}) };
        }
        yield { type: 'done', reason: line.done_reason === 'length' ? 'length' : 'stop' };
        return;
      }
    }
  }
}
