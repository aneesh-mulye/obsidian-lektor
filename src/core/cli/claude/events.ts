// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Claude Code's stream-json output as Lektor's chat events (INVARIANTS.md L5).
 * Checked against Claude Code 2.1.332 on 2026-11-27:
 * - a `system`/`init` line lists the tools, MCP servers and permission mode;
 * - `stream_event` lines carry the API's SSE events (text and thinking deltas);
 * - `assistant` lines repeat each turn whole (their tool_use blocks name the tools);
 * - `user` lines carry tool results (Claude Code's own WebSearch and WebFetch);
 * - one `result` line ends the run, with its subtype, error flag and usage.
 *
 * Text comes only from the deltas (the `assistant` lines repeat it). Lektor's
 * own tools, called over MCP, are recorded by the session's tool host, so their
 * tool_use blocks are skipped here.
 */

import { extractUrls } from '../../tools/urls';
import type { ChatEvent } from '../../providers/types';
import { MCP_SERVER_NAME } from './args';

/** What the init line said (for the self-test). */
export interface InitInfo {
  tools: string[];
  mcpServers: string[];
  permissionMode: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Claude Code's own tools, as the chat names them (so it's clear Claude Code ran them). */
export function activityName(tool: string): string {
  if (tool === 'WebSearch') return 'cc_web_search';
  if (tool === 'WebFetch') return 'cc_web_fetch';
  return `cc_${tool.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40)}`;
}

/** The text of a tool_result block's content (a string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (isObject(b) ? str(b['text']) : '')).join('');
  return '';
}

export class ClaudeStream {
  init: InitInfo | null = null;
  /** Every piece of text seen anywhere (deltas, tool results, the result), for the self-test. */
  readonly seenText: string[] = [];
  /** Every tool Claude Code used (built-in or MCP), by name. */
  readonly toolUses: string[] = [];
  finished = false;
  readonly #pending = new Map<string, { name: string; input: unknown }>();

  /** One stdout line in, zero or more events out. Unreadable lines are skipped (Claude Code may print other things). */
  line(raw: string): ChatEvent[] {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!isObject(msg)) return [];
    switch (msg['type']) {
      case 'system':
        if (msg['subtype'] === 'init') {
          this.init = {
            tools: Array.isArray(msg['tools']) ? msg['tools'].filter((t): t is string => typeof t === 'string') : [],
            mcpServers: Array.isArray(msg['mcp_servers']) ? msg['mcp_servers'].map((s) => (isObject(s) ? str(s['name']) : '')) : [],
            permissionMode: str(msg['permissionMode']),
          };
        }
        return [];
      case 'stream_event': {
        const e = msg['event'];
        if (!isObject(e) || e['type'] !== 'content_block_delta' || !isObject(e['delta'])) return [];
        const d = e['delta'];
        if (d['type'] === 'text_delta' && str(d['text'])) {
          this.seenText.push(str(d['text']));
          return [{ type: 'text', text: str(d['text']) }];
        }
        if (d['type'] === 'thinking_delta' && str(d['thinking'])) {
          this.seenText.push(str(d['thinking']));
          return [{ type: 'reasoning', text: str(d['thinking']) }];
        }
        return [];
      }
      case 'assistant': {
        const m = msg['message'];
        for (const b of isObject(m) && Array.isArray(m['content']) ? m['content'] : []) {
          if (!isObject(b)) continue;
          if (b['type'] === 'text' || b['type'] === 'thinking') this.seenText.push(str(b['text']) + str(b['thinking']));
          if (b['type'] !== 'tool_use') continue;
          const name = str(b['name']);
          this.toolUses.push(name);
          if (!name.startsWith(`mcp__${MCP_SERVER_NAME}__`)) this.#pending.set(str(b['id']), { name, input: b['input'] });
        }
        return [];
      }
      case 'user': {
        const m = msg['message'];
        const out: ChatEvent[] = [];
        for (const b of isObject(m) && Array.isArray(m['content']) ? m['content'] : []) {
          if (!isObject(b) || b['type'] !== 'tool_result') continue;
          const text = resultText(b['content']);
          this.seenText.push(text);
          const id = str(b['tool_use_id']);
          const use = this.#pending.get(id);
          if (!use) continue;
          this.#pending.delete(id);
          const input = isObject(use.input) ? use.input : {};
          const ok = b['is_error'] !== true;
          const query = str(input['query']);
          const url = str(input['url']);
          const urls = use.name === 'WebFetch' ? (url ? [url] : []) : use.name === 'WebSearch' ? [...new Set(extractUrls(text))].slice(0, 20) : [];
          const summary =
            use.name === 'WebSearch'
              ? `Claude Code searched: "${query.slice(0, 80)}"${ok ? ` · ${urls.length} ${urls.length === 1 ? 'result' : 'results'}` : ' · failed'}`
              : use.name === 'WebFetch'
                ? `Claude Code fetched ${url.slice(0, 120)}${ok ? '' : ' · failed'}`
                : `Claude Code tried ${use.name}${ok ? '' : ' (denied)'}`;
          out.push({ type: 'tool_activity', call: { id, name: activityName(use.name), arguments: input }, result: { ok, content: text.slice(0, 4000), summary, ...(urls.length > 0 ? { urls } : {}) } });
        }
        return out;
      }
      case 'result': {
        this.finished = true;
        const usage = isObject(msg['usage']) ? msg['usage'] : {};
        const num = (k: string): number => {
          const v = usage[k];
          return typeof v === 'number' ? v : 0;
        };
        const input = num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens');
        const out = usage['output_tokens'];
        const output = typeof out === 'number' ? out : undefined;
        const result = str(msg['result']);
        if (result) this.seenText.push(result);
        const events: ChatEvent[] = [];
        if (input > 0 || output !== undefined) events.push({ type: 'usage', ...(input > 0 ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}) });
        if (msg['subtype'] !== 'success' || msg['is_error'] === true) {
          const errors = Array.isArray(msg['errors']) ? msg['errors'].filter((e): e is string => typeof e === 'string') : [];
          const why = (result || errors.join(' ') || str(msg['subtype']) || 'an error').slice(0, 500);
          events.push({ type: 'error', message: `Claude Code: ${why}` }, { type: 'done', reason: 'error' });
          return events;
        }
        events.push({ type: 'done', reason: msg['stop_reason'] === 'max_tokens' ? 'length' : 'stop' });
        return events;
      }
      default:
        return [];
    }
  }
}
