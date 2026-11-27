// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Anthropic-compatible servers through `/v1/messages` (Anthropic's API,
 * gateways, Ollama's /v1/messages; DESIGN.md § Backends; INVARIANTS.md E1,
 * E2). Raw HTTP, no SDK (decided before milestone 9). Checked against
 * Ollama 0.40.17 on 2026-11-26 and Anthropic's documented SSE format:
 * message_start, content_block_start/delta/stop (text_delta, thinking_delta,
 * signature_delta, input_json_delta), message_delta with stop_reason and
 * usage, message_stop; `ping` and `error` events.
 *
 * Claude's signed thinking blocks that come with a tool call are handed to
 * the session as `replay` data and sent back unchanged in that turn for the
 * rest of the reply (in memory only).
 */

import { z } from 'zod';
import { readText } from '../http';
import { type EndpointAccess, EndpointHttp, parseArguments, scrub, serverMessage, tryJson } from './compat';
import { decodeSse } from './sse';
import { ProviderError, guardStream } from './stream';
import type { Capabilities, ChatEvent, ChatMessage, ChatProvider, ChatRequest, ModelInfo } from './types';

/** The API version sent with every request. Lektor sends none of the fields it changed (sampling parameters). */
export const ANTHROPIC_VERSION = '2026-10-21';

const ModelList = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().optional(),
      max_input_tokens: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
      capabilities: z.object({ image_input: z.object({ supported: z.boolean() }).optional() }).loose().optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});
type ModelEntry = z.infer<typeof ModelList>['data'][number];

const Usage = z
  .object({
    input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
  })
  .partial();

const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), message: z.object({ usage: Usage.optional() }).loose() }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number().int().nonnegative(),
    content_block: z.object({ type: z.string(), text: z.string().optional(), thinking: z.string().optional(), signature: z.string().optional(), data: z.string().optional(), id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional() }).loose(),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: z.object({ type: z.string(), text: z.string().optional(), thinking: z.string().optional(), signature: z.string().optional(), partial_json: z.string().optional() }).loose(),
  }),
  z.object({ type: z.literal('content_block_stop'), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal('message_delta'), delta: z.object({ stop_reason: z.string().nullish() }).loose(), usage: Usage.nullish() }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string().optional(), type: z.string().optional() }).loose().optional() }),
]);

type Block = Record<string, unknown>;

/** Anthropic's request body for a ChatRequest (INVARIANTS.md E2). Exported for the tests. */
export function anthropicBody(req: ChatRequest, maxTokens: number, thinking: boolean): Record<string, unknown> {
  const system = req.messages.flatMap((m) => (m.role === 'system' ? [{ type: 'text', text: m.content }] : []));
  const messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    // Consecutive same-role turns become one: tool results, then the round's images, in one user turn.
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages) push(...toBlocks(m));
  return {
    model: req.model,
    max_tokens: maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages,
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    ...(thinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    stream: true,
  };
}

function toBlocks(m: ChatMessage): ['user' | 'assistant', Block[]] {
  switch (m.role) {
    case 'system':
      return ['user', []]; // in the top-level `system`
    case 'user': {
      const images = (m.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }));
      return ['user', [...images, ...(m.content !== '' || images.length === 0 ? [{ type: 'text', text: m.content }] : [])]];
    }
    case 'assistant': {
      const replay = Array.isArray(m.replay) ? (m.replay as Block[]) : [];
      const calls = (m.toolCalls ?? []).map((c) => ({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.arguments !== null && typeof c.arguments === 'object' && !Array.isArray(c.arguments) ? c.arguments : {},
      }));
      // Signed thinking first, as the model produced it; then text; then the tool calls.
      return ['assistant', [...(calls.length > 0 ? replay : []), ...(m.content !== '' ? [{ type: 'text', text: m.content }] : []), ...calls]];
    }
    case 'tool':
      return ['user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]];
  }
}

export class AnthropicCompatProvider implements ChatProvider {
  readonly id: string;
  readonly #http: EndpointHttp;
  #models: Promise<Map<string, ModelEntry>> | null = null;

  constructor(private readonly access: EndpointAccess) {
    this.id = `anthropic-compat:${access.settings().id}`;
    this.#http = new EndpointHttp(access, () => this.label);
  }

  get label(): string {
    return this.access.settings().name;
  }

  private headers(key: string, json = false): Record<string, string> {
    const host = (() => {
      try {
        return new URL(this.access.settings().baseUrl).hostname;
      } catch {
        return '';
      }
    })();
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      'anthropic-version': ANTHROPIC_VERSION,
      ...(key ? { 'x-api-key': key } : {}),
      // Anthropic's own API answers a browser (Obsidian's renderer) only with this header.
      ...(host === 'api.anthropic.com' || host.endsWith('.anthropic.com') ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
    };
  }

  /** The server's model list, by id (up to five pages). Rejects if it can't be read. */
  private fetchModels(): Promise<Map<string, ModelEntry>> {
    if (!this.#models) {
      this.#models = (async () => {
        const s = this.access.settings();
        const key = this.access.key();
        const out = new Map<string, ModelEntry>();
        let after: string | null = null;
        for (let page = 0; page < 5; page++) {
          const url: string = `${s.baseUrl}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
          const res = await this.#http.send({ url, method: 'GET', headers: this.headers(key) });
          const text = await readText(res.body);
          if (res.status !== 200) throw new ProviderError(scrub(`${s.name}: ${serverMessage(text) ?? `HTTP ${res.status}`}`, key));
          const parsed = ModelList.safeParse(tryJson(text));
          if (!parsed.success) throw new ProviderError(`${s.name} sent an unexpected model list.`);
          for (const m of parsed.data.data) out.set(m.id, m);
          if (!parsed.data.has_more || !parsed.data.last_id) break;
          after = parsed.data.last_id;
        }
        return out;
      })();
      this.#models.catch(() => (this.#models = null));
    }
    return this.#models;
  }

  async listModels(): Promise<ModelInfo[]> {
    const s = this.access.settings();
    let listed: ModelEntry[] = [];
    try {
      listed = [...(await this.fetchModels()).values()];
    } catch (err) {
      if (s.models.length === 0) throw err;
    }
    const models: ModelInfo[] = listed.map((m) => ({ id: m.id, name: m.display_name ?? m.id, ...(m.max_input_tokens ? { contextWindow: m.max_input_tokens } : {}) }));
    for (const id of s.models) if (!models.some((m) => m.id === id)) models.push({ id, name: id });
    return models;
  }

  private async entry(model: string): Promise<ModelEntry | undefined> {
    return (await this.fetchModels().catch(() => null))?.get(model);
  }

  async capabilities(model: string): Promise<Capabilities> {
    const s = this.access.settings();
    const m = await this.entry(model);
    return {
      toolCalling: s.tools ? 'native' : 'none',
      nativeWebSearch: false,
      images: m?.capabilities?.image_input?.supported ?? s.images,
      contextWindow: m?.max_input_tokens ?? s.contextLength,
    };
  }

  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return guardStream(() => this.rawStream(req, signal), signal);
  }

  private async *rawStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const s = this.access.settings();
    const key = this.access.key();
    const cap = (await this.entry(req.model))?.max_tokens;
    const maxTokens = Math.min(s.maxOutput, cap ?? Number.POSITIVE_INFINITY);
    const res = await this.#http.send({
      url: `${s.baseUrl}/v1/messages`,
      method: 'POST',
      headers: this.headers(key, true),
      body: JSON.stringify(anthropicBody(req, maxTokens, s.thinking)),
      signal,
    });
    if (res.status !== 200) throw await this.#http.error(res, key);
    const notice = this.#http.takeNotice();
    if (notice) yield { type: 'notice', message: notice };

    const blocks = new Map<number, { type: string; thinking: string; signature: string; data: string; id: string; name: string; json: string; input: unknown }>();
    const replay: Block[] = [];
    const calls: ChatEvent[] = [];
    const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: undefined as number | undefined, seen: false };
    let stop: string | null = null;
    let finished = false;

    for await (const sse of decodeSse(res.body)) {
      const parsed = Event.safeParse(tryJson(sse.data));
      if (!parsed.success) {
        // Unknown event types are skipped (the API adds new ones); unreadable data is an error.
        const t = tryJson(sse.data);
        if (t && typeof t === 'object' && typeof (t as { type?: unknown }).type === 'string') continue;
        throw new ProviderError(`${s.name} sent something Lektor could not read.`);
      }
      const ev = parsed.data;
      switch (ev.type) {
        case 'message_start':
          if (ev.message.usage) take(ev.message.usage);
          break;
        case 'content_block_start': {
          const b = ev.content_block;
          blocks.set(ev.index, { type: b.type, thinking: b.thinking ?? '', signature: b.signature ?? '', data: b.data ?? '', id: b.id ?? '', name: b.name ?? '', json: '', input: b.input });
          if (b.type === 'text' && b.text) yield { type: 'text', text: b.text };
          if (b.type === 'thinking' && b.thinking) yield { type: 'reasoning', text: b.thinking };
          break;
        }
        case 'content_block_delta': {
          const b = blocks.get(ev.index);
          const d = ev.delta;
          if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
          else if (d.type === 'thinking_delta' && d.thinking) {
            if (b) b.thinking += d.thinking;
            yield { type: 'reasoning', text: d.thinking };
          } else if (d.type === 'signature_delta' && d.signature && b) b.signature += d.signature;
          else if (d.type === 'input_json_delta' && d.partial_json && b) b.json += d.partial_json;
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(ev.index);
          if (!b) break;
          if (b.type === 'tool_use') {
            const input = b.json !== '' ? parseArguments(b.json) : b.input && typeof b.input === 'object' ? b.input : {};
            calls.push({ type: 'tool_call', call: { id: b.id, name: b.name, arguments: input } });
          } else if (b.type === 'thinking' && b.signature) {
            replay.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
          } else if (b.type === 'redacted_thinking' && b.data) {
            replay.push({ type: 'redacted_thinking', data: b.data });
          }
          break;
        }
        case 'message_delta':
          if (ev.delta.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage) take(ev.usage);
          break;
        case 'message_stop':
          finished = true;
          break;
        case 'ping':
          break;
        case 'error':
          throw new ProviderError(scrub(`${s.name}: ${ev.error?.message || 'the server reported an error.'}`, key));
      }
      if (finished) break;
    }
    if (!finished) throw new ProviderError(`${s.name}: the reply ended before it finished.`);
    if (stop === 'refusal') throw new ProviderError(`${s.name}: the model declined to answer this request.`);
    if (calls.length > 0 && replay.length > 0) yield { type: 'replay', data: replay };
    for (const c of calls) yield c;
    if (usage.seen) yield { type: 'usage', inputTokens: usage.input + usage.cacheWrite + usage.cacheRead, ...(usage.output !== undefined ? { outputTokens: usage.output } : {}) };
    yield { type: 'done', reason: stop === 'max_tokens' || stop === 'model_context_window_exceeded' ? 'length' : 'stop' };

    /** Later usage reports replace earlier ones, field by field. */
    function take(u: z.infer<typeof Usage>): void {
      if (typeof u.input_tokens === 'number') usage.input = u.input_tokens;
      if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWrite = u.cache_creation_input_tokens;
      if (typeof u.cache_read_input_tokens === 'number') usage.cacheRead = u.cache_read_input_tokens;
      if (typeof u.output_tokens === 'number') usage.output = u.output_tokens;
      usage.seen = true;
    }
  }
}
