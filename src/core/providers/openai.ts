// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * OpenAI-compatible servers through `/chat/completions` (LM Studio, vLLM,
 * llama.cpp, Ollama's /v1, LiteLLM and other gateways; DESIGN.md § Backends;
 * INVARIANTS.md E1, E2). Checked against Ollama 0.40.17 on 2026-11-26:
 * reasoning arrives in `delta.reasoning` (vLLM and LM Studio use
 * `reasoning_content`), tool calls arrive whole in one chunk with an `index`,
 * `finish_reason` comes in its own chunk, then a usage chunk, then `[DONE]`.
 */

import { z } from 'zod';
import { type HttpRequest, readText } from '../http';
import { type EndpointAccess, EndpointHttp, parseArguments, rootOf, scrub, tryJson } from './compat';
import { decodeSse } from './sse';
import { ProviderError, guardStream } from './stream';
import type { Capabilities, ChatEvent, ChatMessage, ChatProvider, ChatRequest, ModelInfo } from './types';

const Models = z.object({ data: z.array(z.object({ id: z.string().min(1), max_model_len: z.number().int().positive().optional() })) });
/** LM Studio's model list (`/api/v0/models`). */
const LmStudio = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      type: z.string().optional(),
      loaded_context_length: z.number().int().positive().optional(),
      capabilities: z.array(z.string()).optional(),
    }),
  ),
});
/** llama.cpp's server properties (`/props`). */
const LlamaCpp = z.object({
  default_generation_settings: z.object({ n_ctx: z.number().int().positive() }).optional(),
  modalities: z.object({ vision: z.boolean().optional() }).optional(),
});

const Chunk = z.object({
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().optional(),
                  id: z.string().nullish(),
                  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).partial().optional(),
                }),
              )
              .nullish(),
          })
          .partial()
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).nullish(),
});

interface Detected {
  contextWindow?: number;
  images?: boolean;
  tools?: boolean;
}

/** The request body for a ChatRequest (INVARIANTS.md E2). Exported for the tests. */
export function openAIBody(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages.map(toOpenAIMessage),
    ...(req.tools && req.tools.length > 0
      ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content };
    case 'user':
      if (!m.images || m.images.length === 0) return { role: 'user', content: m.content };
      return {
        role: 'user',
        content: [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))],
      };
    case 'assistant':
      if (!m.toolCalls || m.toolCalls.length === 0) return { role: 'assistant', content: m.content };
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        })),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}

export class OpenAICompatProvider implements ChatProvider {
  readonly id: string;
  readonly #http: EndpointHttp;
  readonly #detected = new Map<string, Promise<Detected>>();
  #calls = 0;

  constructor(private readonly access: EndpointAccess) {
    this.id = `openai-compat:${access.settings().id}`;
    this.#http = new EndpointHttp(access, () => this.label);
  }

  get label(): string {
    return this.access.settings().name;
  }

  private headers(key: string, json = false): Record<string, string> {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }

  private async getJson<T>(url: string, schema: z.ZodType<T>, key: string): Promise<T | null> {
    const res = await this.#http.send({ url, method: 'GET', headers: this.headers(key) });
    const text = await readText(res.body);
    if (res.status !== 200) return null;
    const parsed = schema.safeParse(tryJson(text));
    return parsed.success ? parsed.data : null;
  }

  async listModels(): Promise<ModelInfo[]> {
    const s = this.access.settings();
    const key = this.access.key();
    const res = await this.#http.send({ url: `${s.baseUrl}/models`, method: 'GET', headers: this.headers(key) });
    const text = await readText(res.body);
    const listed = res.status === 200 ? Models.safeParse(tryJson(text)) : null;
    if (!listed?.success && s.models.length === 0) {
      throw res.status === 200 ? new ProviderError(`${s.name} sent an unexpected model list.`) : await this.#http.error({ ...res, body: once(text) }, key);
    }
    const models: ModelInfo[] = (listed?.success ? listed.data.data : []).map((m) => ({
      id: m.id,
      name: m.id,
      ...(m.max_model_len !== undefined ? { contextWindow: m.max_model_len } : {}),
    }));
    for (const id of s.models) if (!models.some((m) => m.id === id)) models.push({ id, name: id });
    return models;
  }

  /** What the server says about a model (vLLM, LM Studio, llama.cpp); nothing if it says nothing. Never rejects. */
  private detect(model: string): Promise<Detected> {
    const s = this.access.settings();
    const cacheKey = `${s.baseUrl}\n${model}`;
    let pending = this.#detected.get(cacheKey);
    if (!pending) {
      pending = (async (): Promise<Detected> => {
        const key = this.access.key();
        const root = rootOf(s.baseUrl);
        const vllm = await this.getJson(`${s.baseUrl}/models`, Models, key).catch(() => null);
        const len = vllm?.data.find((m) => m.id === model)?.max_model_len;
        if (len !== undefined) return { contextWindow: len };
        const lm = await this.getJson(`${root}/api/v0/models`, LmStudio, key).catch(() => null);
        const entry = lm?.data.find((m) => m.id === model);
        if (entry) {
          return {
            ...(entry.loaded_context_length !== undefined ? { contextWindow: entry.loaded_context_length } : {}),
            ...(entry.type ? { images: entry.type === 'vlm' } : {}),
            ...(entry.capabilities ? { tools: entry.capabilities.includes('tool_use') } : {}),
          };
        }
        const props = await this.getJson(`${root}/props`, LlamaCpp, key).catch(() => null);
        if (props?.default_generation_settings) {
          return {
            contextWindow: props.default_generation_settings.n_ctx,
            ...(props.modalities?.vision !== undefined ? { images: props.modalities.vision } : {}),
          };
        }
        return {};
      })().catch(() => ({}));
      this.#detected.set(cacheKey, pending);
    }
    return pending;
  }

  async capabilities(model: string): Promise<Capabilities> {
    const s = this.access.settings();
    const d = await this.detect(model);
    return {
      toolCalling: (d.tools ?? s.tools) ? 'native' : 'none',
      nativeWebSearch: false,
      images: d.images ?? s.images,
      contextWindow: d.contextWindow ?? s.contextLength,
    };
  }

  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return guardStream(() => this.rawStream(req, signal), signal);
  }

  private async *rawStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const s = this.access.settings();
    const key = this.access.key();
    const request: HttpRequest = { url: `${s.baseUrl}/chat/completions`, method: 'POST', headers: this.headers(key, true), body: JSON.stringify(openAIBody(req)), signal };
    const res = await this.#http.send(request);
    if (res.status !== 200) throw await this.#http.error(res, key);
    const notice = this.#http.takeNotice();
    if (notice) yield { type: 'notice', message: notice };

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    const finishCalls = function* (this: OpenAICompatProvider): Generator<ChatEvent> {
      for (const [, c] of [...calls].sort(([a], [b]) => a - b)) {
        yield { type: 'tool_call', call: { id: c.id || `call_${++this.#calls}`, name: c.name, arguments: parseArguments(c.args) } };
      }
      calls.clear();
    }.bind(this);

    for await (const ev of decodeSse(res.body)) {
      if (ev.data.trim() === '[DONE]') {
        yield* finishCalls();
        yield { type: 'done', reason: finish === 'length' ? 'length' : 'stop' };
        return;
      }
      const parsed = Chunk.safeParse(tryJson(ev.data));
      if (!parsed.success) throw new ProviderError(`${s.name} sent something Lektor could not read.`);
      const chunk = parsed.data;
      if (chunk.error !== undefined && chunk.error !== null) {
        const e = chunk.error;
        const message = typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : 'an error';
        throw new ProviderError(scrub(`${s.name}: ${message}`, key));
      }
      for (const choice of chunk.choices ?? []) {
        const d = choice.delta;
        const reasoning = d?.reasoning_content ?? d?.reasoning;
        if (reasoning) yield { type: 'reasoning', text: reasoning };
        if (d?.content) yield { type: 'text', text: d.content };
        (d?.tool_calls ?? []).forEach((t, i) => {
          const index = t.index ?? i;
          const c = calls.get(index) ?? { id: '', name: '', args: '' };
          if (t.id && !c.id) c.id = t.id;
          // The name arrives once (some servers repeat it in every chunk); the arguments arrive in pieces.
          if (t.function?.name && !c.name) c.name = t.function.name;
          if (t.function?.arguments) c.args += t.function.arguments;
          calls.set(index, c);
        });
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      if (chunk.usage) {
        const { prompt_tokens: input, completion_tokens: output } = chunk.usage;
        if (input !== undefined || output !== undefined) yield { type: 'usage', ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}) };
      }
    }
    // No [DONE]: a reply that finished is accepted (some servers omit it); one that didn't is an error.
    if (finish === null) throw new ProviderError(`${s.name}: the reply ended before it finished.`);
    yield* finishCalls();
    yield { type: 'done', reason: finish === 'length' ? 'length' : 'stop' };
  }
}

/** A body already read, as a stream again. */
function once(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    await Promise.resolve();
    yield new TextEncoder().encode(text);
  })();
}
