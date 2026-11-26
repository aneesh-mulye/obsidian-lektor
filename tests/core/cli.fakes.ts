// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A fake Claude Code process for the bridge tests (INVARIANTS.md L1–L6). */

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { Spawned, SpawnOptions, Spawner } from '../../src/core/cli/spawn';

export interface FakeRun {
  command: string;
  args: readonly string[];
  cwd: string;
  stdin: string;
  killed: boolean;
}

/** What the fake process does: print lines, maybe call Lektor's MCP server first, then exit. */
export interface Script {
  /** Lines to print (stdout). A function line runs (e.g. an MCP call) and prints what it returns. */
  lines: Array<string | ((run: FakeRun) => Promise<string[]>)>;
  code?: number;
  stderr?: string;
  /** Stop printing after this many lines and wait to be killed. */
  hangAfter?: number;
}

export class FakeSpawner implements Spawner {
  readonly runs: FakeRun[] = [];
  version = '2.1.332 (Claude Code)';
  constructor(public script: (run: FakeRun) => Script) {}

  run(command: string, args: readonly string[], options: SpawnOptions): Spawned {
    const run: FakeRun = { command, args: [...args], cwd: options.cwd, stdin: '', killed: false };
    this.runs.push(run);
    const version = this.version;
    const isVersion = args.length === 1 && args[0] === '--version';
    const scriptFor = this.script;
    let killResolve: () => void = () => undefined;
    const killed = new Promise<void>((r) => (killResolve = r));
    let exitResolve: (v: { code: number | null; signal: string | null }) => void = () => undefined;
    const exit = new Promise<{ code: number | null; signal: string | null }>((r) => (exitResolve = r));
    let ended: () => void = () => undefined;
    const stdinEnded = new Promise<void>((r) => (ended = r));
    const script: Script | null = isVersion ? { lines: [version] } : null;
    const lines = (async function* () {
      await stdinEnded;
      const s = script ?? scriptFor(run);
      let n = 0;
      for (const l of s.lines) {
        if (run.killed) break;
        if (s.hangAfter !== undefined && n >= s.hangAfter) {
          await killed;
          break;
        }
        const out = typeof l === 'string' ? [l] : await l(run);
        for (const o of out) {
          await Promise.resolve();
          if (run.killed) break;
          yield o;
        }
        n++;
      }
      exitResolve(run.killed ? { code: null, signal: 'SIGTERM' } : { code: s.code ?? 0, signal: null });
    })();
    return {
      lines,
      stderr: () => (script ? '' : (scriptFor(run).stderr ?? '')),
      exit,
      write: (d) => {
        run.stdin += d;
      },
      end: () => ended(),
      kill: () => {
        if (run.killed) return;
        run.killed = true;
        killResolve();
        exitResolve({ code: null, signal: 'SIGTERM' });
      },
    };
  }
}

/** The value after a flag in an argument list. */
export const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** Call a tool on the run's MCP server, as Claude Code would (reads the run's MCP config file). */
export function mcpCall(run: FakeRun, method: string, params: unknown, id = 1, tamper?: { token?: string; host?: string; origin?: string }): Promise<{ status: number; body: string }> {
  const config = JSON.parse(readFileSync(flag(run.args, '--mcp-config')!, 'utf8')) as { mcpServers: { lektor: { url: string; headers: { Authorization: string } } } };
  const { url, headers } = config.mcpServers.lektor;
  const u = new URL(url);
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(u.port),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Host: tamper?.host ?? u.host,
          Authorization: tamper?.token !== undefined ? `Bearer ${tamper.token}` : headers.Authorization,
          ...(tamper?.origin ? { Origin: tamper.origin } : {}),
        },
      },
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

// Lines Claude Code prints (shapes checked against 2.1.332).
export const cc = {
  init: (tools: string[], mcp: string[] = ['lektor'], mode = 'dontAsk') =>
    JSON.stringify({ type: 'system', subtype: 'init', tools, mcp_servers: mcp.map((name) => ({ name, status: 'connected' })), permissionMode: mode, cwd: '/tmp/lektor-x/void' }),
  text: (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
  thinking: (thinking: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } }),
  toolUse: (id: string, name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
  toolResult: (id: string, content: string, isError = false) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } }),
  result: (subtype = 'success', isError = false, result = '', usage = { input_tokens: 3, cache_read_input_tokens: 10, output_tokens: 5 }) =>
    JSON.stringify({ type: 'result', subtype, is_error: isError, result, usage, stop_reason: 'end_turn' }),
};
