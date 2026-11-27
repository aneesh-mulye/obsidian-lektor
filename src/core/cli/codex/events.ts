// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `codex exec --json` lines into chat events (INVARIANTS.md C3). Codex gives
 * each message whole (it doesn't stream text), its own web searches as items,
 * and Lektor's tool calls as `mcp_tool_call` items, which Lektor has already
 * recorded through its MCP server, so those give no event here. Exactly one
 * `done` comes out, last.
 */

import type { ChatEvent } from '../../providers/types';
import { MCP_SERVER_NAME } from '../claude/args';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The item types a locked-down Codex may report (anything else fails the self-test). */
export const CODEX_ALLOWED_ITEMS = ['agent_message', 'reasoning', 'web_search', 'mcp_tool_call', 'error'] as const;

function resultsOf(item: Record<string, unknown>): { urls: string[]; text: string } {
  const results = Array.isArray(item['results']) ? item['results'].filter(isObject) : [];
  const urls = [...new Set(results.map((r) => str(r['url'])).filter((u) => /^https?:\/\//.test(u)))].slice(0, 20);
  const text = results.map((r) => [str(r['title']), str(r['url']) || str(r['domain']), str(r['snippet'])].filter(Boolean).join(' — ')).join('\n');
  return { urls, text };
}

export class CodexStream {
  /** Every item type Codex reported, in order (for the self-test). */
  readonly itemTypes: string[] = [];
  /** MCP servers Codex called tools on. */
  readonly mcpServers: string[] = [];
  /** Every piece of text seen anywhere (messages, reasoning, tool results, results, errors), for the self-test. */
  readonly seenText: string[] = [];
  finished = false;
  #ended = false;
  #messages = 0;
  #reasoning = 0;

  /** Whether `done` has been emitted. */
  get ended(): boolean {
    return this.#ended;
  }

  /** One stdout line in, zero or more events out. Unreadable lines are skipped. */
  line(raw: string): ChatEvent[] {
    if (this.#ended) return [];
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!isObject(msg)) return [];
    switch (msg['type']) {
      case 'item.completed':
        return isObject(msg['item']) ? this.#item(msg['item']) : [];
      case 'turn.completed': {
        this.finished = true;
        this.#ended = true;
        const u = isObject(msg['usage']) ? msg['usage'] : {};
        const input = num(u['input_tokens']);
        const output = num(u['output_tokens']);
        const usage: ChatEvent[] = input !== undefined || output !== undefined ? [{ type: 'usage', ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}) }] : [];
        return [...usage, { type: 'done', reason: 'stop' }];
      }
      case 'turn.failed': {
        const e = isObject(msg['error']) ? str(msg['error']['message']) : '';
        return this.#fail(e || 'the turn failed');
      }
      case 'error':
        return this.#fail(str(msg['message']) || 'an error');
      default:
        return [];
    }
  }

  #fail(why: string): ChatEvent[] {
    this.#ended = true;
    this.seenText.push(why);
    return [
      { type: 'error', message: `Codex: ${why.slice(0, 500)}` },
      { type: 'done', reason: 'error' },
    ];
  }

  #item(item: Record<string, unknown>): ChatEvent[] {
    const type = str(item['type']);
    this.itemTypes.push(type);
    const id = str(item['id']) || `codex-${this.itemTypes.length}`;
    switch (type) {
      case 'agent_message': {
        const text = str(item['text']);
        this.seenText.push(text);
        if (text === '') return [];
        return [{ type: 'text', text: (this.#messages++ > 0 ? '\n\n' : '') + text }];
      }
      case 'reasoning': {
        const text = str(item['text']);
        this.seenText.push(text);
        if (text === '') return [];
        return [{ type: 'reasoning', text: (this.#reasoning++ > 0 ? '\n\n' : '') + text }];
      }
      case 'web_search': {
        const action = isObject(item['action']) ? item['action'] : {};
        const kind = str(action['type']);
        const { urls, text } = resultsOf(item);
        this.seenText.push(text, str(item['query']));
        const opened = kind === 'open_page' || kind === 'find_in_page';
        const url = str(action['url']);
        const query = str(action['query']) || str(item['query']);
        const summary = opened
          ? `Codex ${kind === 'find_in_page' ? 'searched in' : 'opened'} ${url.slice(0, 120)}`
          : `Codex searched: "${query.slice(0, 80)}"${urls.length > 0 ? ` · ${urls.length} ${urls.length === 1 ? 'result' : 'results'}` : ''}`;
        const links = opened && /^https?:\/\//.test(url) ? [url] : urls;
        return [
          {
            type: 'tool_activity',
            call: { id, name: opened ? 'codex_web_fetch' : 'codex_web_search', arguments: { ...action, ...(query && !opened ? { query } : {}) } },
            result: { ok: true, content: text.slice(0, 4000), summary, ...(links.length > 0 ? { urls: links } : {}) },
          },
        ];
      }
      case 'mcp_tool_call': {
        // Lektor's own tools: already recorded through Lektor's MCP server.
        const server = str(item['server']);
        this.mcpServers.push(server);
        const result = isObject(item['result']) && Array.isArray(item['result']['content']) ? item['result']['content'] : [];
        this.seenText.push(result.map((b) => (isObject(b) ? str(b['text']) : '')).join('\n'));
        if (server === MCP_SERVER_NAME) return [];
        return [{ type: 'tool_activity', call: { id, name: 'codex_other', arguments: { server, tool: str(item['tool']) } }, result: { ok: false, content: '', summary: `Codex called ${str(item['tool']).slice(0, 40)} on ${server.slice(0, 40)}` } }];
      }
      case 'error': {
        const message = str(item['message']);
        this.seenText.push(message);
        return message ? [{ type: 'notice', message: `Codex: ${message.slice(0, 300)}` }] : [];
      }
      default: {
        // Nothing else should ever appear (the lockdown leaves no such tool); say so plainly if it does.
        this.seenText.push(JSON.stringify(item).slice(0, 4000));
        return [{ type: 'tool_activity', call: { id, name: 'codex_other', arguments: {} }, result: { ok: false, content: '', summary: `Codex tried ${type.slice(0, 40) || 'something unknown'}` } }];
      }
    }
  }
}
