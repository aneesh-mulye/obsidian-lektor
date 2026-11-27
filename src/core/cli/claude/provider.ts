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
import type { Capabilities, ChatEvent, ChatProvider, ChatRequest, ModelInfo, ToolDefinition, ToolHost } from '../../providers/types';
import { type RunFolder, createRun, removeRun, voidIsEmpty, writeRunFile, writeVoidCanary } from '../fs';
import { type McpServer, startMcpServer } from '../mcp';
import type { Spawned, Spawner } from '../spawn';
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
/** How long a spare Claude Code process may wait for a message before it is discarded (INVARIANTS.md L8). */
export const SPARE_IDLE_MS = 10 * 60 * 1000;

/** Everything a Claude Code process is started with, apart from the message. */
interface Launch {
  command: string;
  version: string;
  model: string;
  web: { search: boolean; pages: boolean };
  /** Lektor's tools, served over MCP. */
  definitions: ToolDefinition[];
}

/** A started process, its run folder and MCP server; the message's tool host is attached when it is used. */
interface Started {
  readonly key: string;
  readonly run: RunFolder;
  readonly server: McpServer;
  readonly proc: Spawned;
  attach(host: ToolHost): void;
  closed: boolean;
}

interface Spare extends Started {
  exited: boolean;
  cancelIdle: () => void;
}

/** Two launches may share a process only if every setting it was started with is the same (INVARIANTS.md L8). */
const keyOf = (l: Launch): string =>
  JSON.stringify({ command: l.command, version: l.version, model: l.model, web: l.web, tools: l.definitions.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })) });

const defaultSchedule = (ms: number, fn: () => void): (() => void) => {
  const t: unknown = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t as Parameters<typeof clearTimeout>[0]);
};

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
  /** Keep one process started ahead of time, so the next message skips start-up (the setting; off if absent). */
  warm?: () => boolean;
  /** Run `fn` after `ms`; returns a cancel function (tests pass a manual clock). */
  schedule?: (ms: number, fn: () => void) => () => void;
}

const VERSION = /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/;

export class ClaudeCodeProvider implements ChatProvider {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  #version: { command: string; version: string } | null = null;
  #testing: Promise<Verdict> | null = null;
  /** At most one process waiting for the next message (INVARIANTS.md L8). */
  #spare: Spare | null = null;
  /** Starting or discarding the spare, one step at a time. */
  #preparing: Promise<void> = Promise.resolve();
  readonly #closing = new Set<Promise<void>>();
  /** Replies whose clean-up (and the spare after them) hasn't finished yet. */
  readonly #ending = new Set<Promise<void>>();
  #disposed = false;

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
    return { toolCalling: 'mcp', nativeWebSearch: true, nativeWebFetch: this.deps.fetchMode() === 'claude', nativeWebBy: 'Claude Code', images: true, contextWindow: CLAUDE_CONTEXT };
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
    let ended: () => void = () => undefined;
    const ending = new Promise<void>((r) => (ended = r));
    this.#ending.add(ending);
    try {
      yield* this.reply(req, signal);
    } finally {
      this.#ending.delete(ending);
      ended();
    }
  }

  private async *reply(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const { command, version } = await this.installed();
    const stored = await this.deps.selfTest.read();
    if (!selfTestCurrent(stored, version, this.deps.now())) {
      // A spare started under an earlier check is not used until the check passes again.
      await this.discardSpare();
      yield { type: 'notice', message: `Lektor checked Claude Code ${version}’s lockdown before using it (once a day for each version).` };
      const verdict = await this.selfTest();
      if (!verdict.ok) throw new ProviderError(`Claude Code is disabled: the lockdown self-test failed (${verdict.reason}). Lektor won’t send it your notes.`);
    }
    if (signal.aborted) return;

    const host: ToolHost = req.toolHost ?? { definitions: [], call: () => Promise.resolve({ content: 'No tools.', isError: true }) };
    const web = req.web ?? { search: false, pages: false };
    const launch: Launch = {
      command,
      version,
      model: req.model,
      web: { search: web.search, pages: web.pages && this.deps.fetchMode() === 'claude' },
      definitions: host.definitions.filter((d) => (LEKTOR_MCP_TOOLS as readonly string[]).includes(d.name)),
    };
    let started: Started | null = null;
    let finished = false;
    try {
      // The waiting spare, if it was started with exactly these settings; otherwise a fresh process.
      started = (await this.takeSpare(keyOf(launch))) ?? (await this.start(launch));
      started.attach(host);
      const p = started.proc;
      const onAbort = () => p.kill();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        p.write(`${userLine(req.messages)}\n`);
        p.end();
        const stream = new ClaudeStream();
        for await (const l of p.lines) {
          for (const e of stream.line(l)) {
            if (e.type === 'error') throw new ProviderError(e.message);
            if (e.type === 'done') finished = e.reason !== 'error';
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
      if (started) await this.close(started);
      // After a finished reply, start the next message's process now, with the settings it will most likely use (INVARIANTS.md L8).
      if (finished && !signal.aborted) {
        const n = req.nextLikely;
        this.startSpare(
          n
            ? {
                command,
                version,
                model: n.model,
                web: { search: n.web.search, pages: n.web.pages && this.deps.fetchMode() === 'claude' },
                definitions: n.tools.filter((d) => (LEKTOR_MCP_TOOLS as readonly string[]).includes(d.name)),
              }
            : launch,
        );
      }
    }
  }

  /** Start a process: a fresh run folder, an MCP server with these tools (handled once attached), the files, and Claude Code. */
  private async start(l: Launch): Promise<Started> {
    const run = await createRun();
    let server: McpServer | null = null;
    try {
      let host: ToolHost | null = null;
      server = await startMcpServer({
        definitions: l.definitions,
        // Until a message takes this process, no tool runs.
        call: (name, args) => (host ? host.call(name, args) : Promise.resolve({ content: 'No message is being answered.', isError: true })),
      });
      const args = claudeArgs({
        model: l.model,
        web: l.web,
        lektorTools: l.definitions.map((d) => d.name),
        mcpConfigPath: await writeRunFile(run, 'mcp.json', mcpConfig(server.url, server.token)),
        systemPromptPath: await writeRunFile(run, 'system.txt', systemPrompt()),
      });
      if (!(await voidIsEmpty(run))) throw new ProviderError('Claude Code’s working folder was not empty.');
      const proc = this.deps.spawner.run(l.command, args, { cwd: run.void, env: { MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS } });
      return { key: keyOf(l), run, server, proc, closed: false, attach: (h) => (host = h) };
    } catch (err) {
      await server?.close();
      await removeRun(run);
      throw err;
    }
  }

  /** Kill a process and remove its MCP server and run folder (once). */
  private close(s: Started): Promise<void> {
    if (s.closed) return Promise.resolve();
    s.closed = true;
    s.proc.kill();
    const done = (async () => {
      await s.server.close();
      await removeRun(s.run);
    })();
    this.#closing.add(done);
    void done.finally(() => this.#closing.delete(done)).catch(() => undefined);
    return done;
  }

  /** The waiting spare if it matches `key` exactly; any other spare is discarded. */
  private async takeSpare(key: string): Promise<Started | null> {
    await this.#preparing;
    const s = this.#spare;
    this.#spare = null;
    if (!s) return null;
    s.cancelIdle();
    if (s.key === key && !s.exited) return s;
    await this.close(s);
    return null;
  }

  /** Start a spare for the next message with these settings, replacing any other (INVARIANTS.md L8). */
  private startSpare(l: Launch): void {
    this.#preparing = this.#preparing
      .then(async () => {
        if (this.#disposed || !(this.deps.warm?.() ?? false)) return;
        const old = this.#spare;
        this.#spare = null;
        if (old) {
          old.cancelIdle();
          await this.close(old);
        }
        const started = await this.start(l);
        if (this.#disposed || !(this.deps.warm?.() ?? false)) {
          await this.close(started);
          return;
        }
        const spare: Spare = Object.assign(started, { exited: false, cancelIdle: () => undefined });
        const drop = () => {
          if (this.#spare !== spare) return;
          this.#spare = null;
          spare.cancelIdle();
          void this.close(spare);
        };
        spare.cancelIdle = (this.deps.schedule ?? defaultSchedule)(SPARE_IDLE_MS, drop);
        void spare.proc.exit.then(() => {
          spare.exited = true;
          drop();
        });
        this.#spare = spare;
      })
      .catch(() => undefined);
  }

  /** Resolves once replies that have ended are cleaned up and any spare being started or discarded is settled. */
  async spareSettled(): Promise<void> {
    await Promise.all([...this.#ending]);
    await this.#preparing;
    await Promise.all([...this.#closing]);
  }

  /** Discard the waiting spare, if any (the setting was turned off). */
  async discardSpare(): Promise<void> {
    await this.#preparing;
    const s = this.#spare;
    this.#spare = null;
    if (s) {
      s.cancelIdle();
      await this.close(s);
    }
    await Promise.all([...this.#closing]);
  }

  /** Lektor is unloading: discard the spare and start no more. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.discardSpare();
  }
}
