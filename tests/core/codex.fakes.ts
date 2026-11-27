// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A fake Codex CLI for the bridge tests (INVARIANTS.md C1–C6): its information commands, its JSONL, and its inventory run. */

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { TOKEN_ENV } from '../../src/core/cli/codex/args';
import { INVENTORY_MARK, RESOURCE_TOOLS } from '../../src/core/cli/codex/selftest';
import { FakeSpawner, type FakeRun, type Script } from './cli.fakes';

export const CODEX_VERSION = 'codex-cli 0.162.1';
/** A feature list shaped like 0.162.1's (stages with spaces, removed and deprecated ones). */
export const FEATURES_TEXT = [
  'apps                                     stable             true',
  'code_mode_host                           stable             true',
  'enable_request_compression               stable             true',
  'hooks                                    stable             true',
  'image_generation                         stable             true',
  'memories                                 stable             false',
  'shell_tool                               stable             true',
  'steer                                    removed            true',
  'system_proxy_fallback                    stable             true',
  'transcript_v2                            deprecated         false',
  'use_legacy_landlock                      deprecated         true',
  'view_image                               stable             true',
  'agent_message_board                      under development  false',
].join('\n');
export const MODEL_ENTRY = { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'], context_window: 272000, effective_context_window_percent: 95, input_modalities: ['text', 'image'] };
export const CATALOG = { models: [{ ...MODEL_ENTRY, slug: 'gpt-6-sol', display_name: 'GPT-6-Sol' }, MODEL_ENTRY, { ...MODEL_ENTRY, slug: 'hidden-one', visibility: 'hide' }] };

/** The value of a `-c key=value` argument. */
export function config(args: readonly string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '-c' && args[i + 1]!.startsWith(`${key}=`)) return args[i + 1]!.slice(key.length + 1);
  return undefined;
}
const unquote = (v: string | undefined) => (v ?? '').replace(/^"|"$/g, '');
export const isExec = (run: FakeRun) => run.args[0] === 'exec';
export const isCheck = (run: FakeRun) => config(run.args, 'model_provider') !== undefined;

function post(url: string, token: string, body: string, tamper?: { token?: string }): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: Number(u.port), path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', Host: u.host, Authorization: `Bearer ${tamper?.token ?? token}` } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Call Lektor's MCP server as Codex would (URL from the -c flags, token from the environment). */
export async function codexMcp(run: FakeRun, method: string, params: unknown, id = 1): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const r = await post(unquote(config(run.args, 'mcp_servers.lektor.url')), run.env[TOKEN_ENV] ?? '', JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    // no body (a notification, or refused)
  }
  return { status: r.status, json };
}

/** How the fake inventory run departs from a clean one (to see the check fail). */
export interface InventoryTamper {
  extraTop?: string;
  extraNested?: string;
  resources?: unknown;
  instructions?: string;
  leak?: string;
  globals?: string[];
  skipSecond?: boolean;
  token?: string;
  /** Leave out one of Lektor's tools (MCP not reaching Codex). */
  dropNested?: string;
}

/** What Codex does for the inventory: send the request, run the inventory script, send its output. */
export async function fakeInventory(run: FakeRun, tamper: InventoryTamper = {}): Promise<string[]> {
  const base = /base_url = "([^"]+)"/.exec(config(run.args, 'model_providers.lektor_check') ?? '')?.[1] ?? '';
  const token = run.env[TOKEN_ENV] ?? '';
  const instructions = tamper.instructions ?? readFileSync(unquote(config(run.args, 'model_instructions_file')), 'utf8');
  const listed = await codexMcp(run, 'tools/list', {});
  const lektor = ((listed.json?.['result'] as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => `mcp__lektor__${t.name}`).filter((n) => n !== `mcp__lektor__${tamper.dropNested}`);
  const top = [{ type: 'custom', name: 'exec' }, { type: 'function', name: 'wait' }, { type: 'function', name: 'request_user_input' }, ...(tamper.extraTop ? [{ type: 'function', name: tamper.extraTop }] : [])];
  const first = {
    model: 'gpt-6-luna',
    input: [
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: top }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context><cwd>${run.cwd}</cwd></environment_context>${tamper.leak ?? ''}` }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: run.stdin }] },
    ],
  };
  const r1 = await post(`${base}/responses`, token, JSON.stringify(first), tamper.token ? { token: tamper.token } : undefined);
  if (r1.status !== 200) return [JSON.stringify({ type: 'turn.failed', error: { message: `unexpected status ${r1.status}` } })];
  if (!tamper.skipSecond && r1.body.includes('custom_tool_call')) {
    const report = {
      tools: [...RESOURCE_TOOLS, ...lektor, ...(tamper.extraNested ? [tamper.extraNested] : [])],
      resources: tamper.resources ?? '{"resources":[]}',
      templates: '{"resourceTemplates":[]}',
      globals: tamper.globals ?? ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
    };
    const second = { ...first, input: [...first.input, { type: 'custom_tool_call', call_id: 'call_1', name: 'exec' }, { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: INVENTORY_MARK + JSON.stringify(report) }] }] };
    await post(`${base}/responses`, token, JSON.stringify(second));
  }
  return [cx.message('Inventory done.'), cx.completed()];
}

// Lines `codex exec --json` prints (shapes checked against 0.162.1).
export const cx = {
  thread: () => JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-7000-8000-000000000000' }),
  turn: () => JSON.stringify({ type: 'turn.started' }),
  message: (text: string, id = 'item_m') => JSON.stringify({ type: 'item.completed', item: { id, type: 'agent_message', text } }),
  reasoning: (text: string, id = 'item_r') => JSON.stringify({ type: 'item.completed', item: { id, type: 'reasoning', text } }),
  search: (query: string, urls: string[], id = 'ws_1') =>
    JSON.stringify({ type: 'item.completed', item: { id, type: 'web_search', query, action: { type: 'search', query }, results: urls.map((url, i) => ({ type: 'text_result', domain: new URL(url).host, ref_id: `turn0search${i}`, snippet: `snippet ${i}`, title: `title ${i}`, url })) } }),
  open: (url: string, id = 'ws_2') => JSON.stringify({ type: 'item.completed', item: { id, type: 'web_search', query: '', action: { type: 'open_page', url } } }),
  mcp: (tool: string, args: unknown, server = 'lektor', id = 'item_t') =>
    JSON.stringify({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server, tool, arguments: args, result: { content: [{ type: 'text', text: 'ok' }] }, error: null, status: 'completed' } }),
  other: (type: string, id = 'item_o') => JSON.stringify({ type: 'item.completed', item: { id, type, command: 'cat canary.txt' } }),
  itemError: (message: string) => JSON.stringify({ type: 'item.completed', item: { id: 'item_e', type: 'error', message } }),
  completed: (usage = { input_tokens: 30, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }) => JSON.stringify({ type: 'turn.completed', usage }),
  failed: (message: string) => JSON.stringify({ type: 'turn.failed', error: { message } }),
  error: (message: string) => JSON.stringify({ type: 'error', message }),
};

/** A fake Codex: its information commands, the inventory run, and `exec` runs scripted by `reply`. */
export function fakeCodex(reply: (run: FakeRun) => Script, opts: { inventory?: InventoryTamper; features?: string; catalog?: unknown } = {}): FakeSpawner {
  const spawner = new FakeSpawner((run): Script => {
    if (run.args[0] === 'features') return { lines: (opts.features ?? FEATURES_TEXT).split('\n') };
    if (run.args[0] === 'debug') return { lines: [JSON.stringify(opts.catalog ?? CATALOG)] };
    if (isCheck(run)) return { lines: [(r) => fakeInventory(r, opts.inventory)] };
    return reply(run);
  });
  spawner.version = CODEX_VERSION;
  return spawner;
}
