// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Claude Code as a chat backend (DESIGN.md § Backends; INVARIANTS.md L1–L6).
 * Each reply is one locked-down `claude -p` run in a fresh temp folder: the
 * official CLI as installed and signed in (Lektor never touches its tokens),
 * Lektor's tools over a loopback MCP server, and its own WebSearch and
 * WebFetch unless the chat or a setting says otherwise. No chat is sent until
 * the lockdown self-test has passed on the installed version.
 */

import { guardStream, ProviderError } from '../../providers/stream';
import type { Capabilities, ChatEvent, ChatProvider, ChatRequest, ModelInfo, ToolHost } from '../../providers/types';
import { type RunFolder, createRun, removeRun, voidIsEmpty, writeRunFile, writeVoidCanary } from '../fs';
import { startMcpServer } from '../mcp';
import type { Spawner } from '../spawn';
import { CliError, LEKTOR_MCP_TOOLS, claudeArgs, mcpConfig } from './args';
import { ClaudeStream } from './events';
import { systemPrompt, userLine } from './prompt';
import { type SelfTestRecord, type Verdict, judgeSelfTest, selfTestCurrent, selfTestPrompt } from './selftest';

export const CLAUDE_MODELS: readonly ModelInfo[] = [
  { id: 'opus', name: 'Opus (latest)' },
  { id: 'sonnet', name: 'Sonnet (latest)' },
  { id: 'haiku', name: 'Haiku (latest)' },
  { id: 'fable', name: 'Fable (latest)' },
];
/** Lektor's budget for Claude Code requests (conservative: every current model has at least this). */
export const CLAUDE_CONTEXT = 200_000;
/** Long enough for an approval card to wait for the user. */
const MCP_TOOL_TIMEOUT_MS = String(60 * 60 * 1000);

export interface ClaudeCodeDeps {
  /** The `claude` executable (the setting, or found on the system), or null. */
  command: () => Promise<string | null>;
  spawner: Spawner;
  /** 'claude': its own WebFetch; 'lektor': Lektor's fetch_page over MCP, with its approvals. */
  fetchMode: () => 'claude' | 'lektor';
  selfTest: { read(): Promise<SelfTestRecord | null>; write(r: SelfTestRecord): Promise<void> };
  now: () => number;
  /** A random token for canaries. */
  randomToken: () => string;
}

const VERSION = /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/;

export class ClaudeCodeProvider implements ChatProvider {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  #version: { command: string; version: string } | null = null;
  #testing: Promise<Verdict> | null = null;

  constructor(private readonly deps: ClaudeCodeDeps) {}

  /** The installed CLI and its version; only the official Claude Code is accepted. */
  async installed(): Promise<{ command: string; version: string }> {
    const command = await this.deps.command();
    if (!command) throw new ProviderError('Claude Code was not found. Install it, or set its path in Lektor’s settings.');
    if (this.#version?.command === command) return this.#version;
    const run = await createRun();
    try {
      const p = this.deps.spawner.run(command, ['--version'], { cwd: run.void });
      p.end();
      let out = '';
      for await (const l of p.lines) out += `${l}\n`;
      await p.exit;
      const m = VERSION.exec(out.trim());
      if (!m) throw new ProviderError(`${command} is not the official Claude Code CLI (it reported "${out.trim().slice(0, 80)}").`);
      this.#version = { command, version: m[1]! };
      return this.#version;
    } finally {
      await removeRun(run);
    }
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([...CLAUDE_MODELS]);
  }

  async capabilities(): Promise<Capabilities> {
    await this.installed();
    return { toolCalling: 'mcp', nativeWebSearch: true, nativeWebFetch: this.deps.fetchMode() === 'claude', images: true, contextWindow: CLAUDE_CONTEXT };
  }

  /** The stored self-test result for the installed version, if any (for settings). */
  async lastSelfTest(): Promise<SelfTestRecord | null> {
    return this.deps.selfTest.read();
  }

  /** Run the lockdown self-test now (settings button, or before the first reply of the day). */
  selfTest(force = false): Promise<Verdict> {
    if (!this.#testing) {
      this.#testing = (async (): Promise<Verdict> => {
        const { command, version } = await this.installed();
        const stored = await this.deps.selfTest.read();
        if (!force && selfTestCurrent(stored, version, this.deps.now())) return { ok: true };
        const verdict = await this.runSelfTest(command).catch((err: unknown): Verdict => ({ ok: false, reason: err instanceof Error ? err.message : 'the check failed' }));
        await this.deps.selfTest.write({ version, at: this.deps.now(), ok: verdict.ok, ...(verdict.ok ? {} : { reason: verdict.reason }) });
        return verdict;
      })().finally(() => (this.#testing = null));
    }
    return this.#testing;
  }

  private async runSelfTest(command: string): Promise<Verdict> {
    const inside = `LEKTOR-CANARY-${this.deps.randomToken()}`;
    const outside = `LEKTOR-CANARY-${this.deps.randomToken()}`;
    const run = await createRun();
    const other = await createRun();
    const server = await startMcpServer({ definitions: [], call: () => Promise.resolve({ content: 'No tools.', isError: true }) });
    try {
      await writeVoidCanary(run, inside);
      const outsidePath = await writeRunFile(other, 'canary.txt', outside);
      const args = claudeArgs({
        model: 'haiku',
        web: { search: true, pages: true },
        lektorTools: [],
        mcpConfigPath: await writeRunFile(run, 'mcp.json', mcpConfig(server.url, server.token)),
        systemPromptPath: await writeRunFile(run, 'system.txt', 'You are being tested by the app that started you. Do what you are asked, with the tools you have.'),
      });
      const p = this.deps.spawner.run(command, args, { cwd: run.void, env: { MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS } });
      p.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: selfTestPrompt(outsidePath) }] } })}\n`);
      p.end();
      const stream = new ClaudeStream();
      let error: string | undefined;
      const timer = setTimeout(() => p.kill(), 5 * 60 * 1000);
      for await (const l of p.lines) {
        for (const e of stream.line(l)) if (e.type === 'error') error = e.message;
      }
      clearTimeout(timer);
      const exit = await p.exit;
      if (!stream.finished && exit.code !== 0) error = error ?? `Claude Code exited with ${exit.code ?? exit.signal ?? 'an error'}: ${p.stderr().trim().slice(-300)}`;
      return judgeSelfTest({ init: stream.init, toolUses: stream.toolUses, text: stream.seenText.join('\n'), finished: stream.finished, ...(error ? { error } : {}) }, [inside, outside]);
    } finally {
      await server.close();
      await removeRun(run);
      await removeRun(other);
    }
  }

  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return guardStream(() => this.rawStream(req, signal), signal);
  }

  private async *rawStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const { command, version } = await this.installed();
    const stored = await this.deps.selfTest.read();
    if (!selfTestCurrent(stored, version, this.deps.now())) {
      yield { type: 'notice', message: `Lektor checked Claude Code ${version}’s lockdown before using it (once a day for each version).` };
      const verdict = await this.selfTest();
      if (!verdict.ok) throw new ProviderError(`Claude Code is disabled: the lockdown self-test failed (${verdict.reason}). Lektor won’t send it your notes.`);
    }
    if (signal.aborted) return;

    const host: ToolHost = req.toolHost ?? { definitions: [], call: () => Promise.resolve({ content: 'No tools.', isError: true }) };
    const offered = host.definitions.map((d) => d.name).filter((n) => (LEKTOR_MCP_TOOLS as readonly string[]).includes(n));
    const web = req.web ?? { search: false, pages: false };
    let run: RunFolder | null = null;
    let server: Awaited<ReturnType<typeof startMcpServer>> | null = null;
    try {
      run = await createRun();
      server = await startMcpServer({ definitions: host.definitions.filter((d) => offered.includes(d.name)), call: (n, a) => host.call(n, a) });
      const args = claudeArgs({
        model: req.model,
        web: { search: web.search, pages: web.pages && this.deps.fetchMode() === 'claude' },
        lektorTools: offered,
        mcpConfigPath: await writeRunFile(run, 'mcp.json', mcpConfig(server.url, server.token)),
        systemPromptPath: await writeRunFile(run, 'system.txt', systemPrompt(req.messages)),
      });
      if (!(await voidIsEmpty(run))) throw new ProviderError('Claude Code’s working folder was not empty.');
      const p = this.deps.spawner.run(command, args, { cwd: run.void, env: { MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS } });
      const onAbort = () => p.kill();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        p.write(`${userLine(req.messages)}\n`);
        p.end();
        const stream = new ClaudeStream();
        for await (const l of p.lines) {
          for (const e of stream.line(l)) {
            if (e.type === 'error') throw new ProviderError(e.message);
            yield e;
            if (e.type === 'done') return;
          }
        }
        const exit = await p.exit;
        throw new ProviderError(`Claude Code stopped before it finished (${exit.code ?? exit.signal ?? 'no exit code'}). ${p.stderr().trim().slice(-300)}`.trim());
      } finally {
        signal.removeEventListener('abort', onAbort);
        p.kill();
      }
    } catch (err) {
      if (err instanceof CliError) throw new ProviderError(err.message);
      throw err;
    } finally {
      await server?.close();
      if (run) await removeRun(run);
    }
  }
}
