// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md L8: the warm spare never changes what a reply gets. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SPARE_IDLE_MS, ClaudeCodeProvider } from '../../src/core/cli/claude/provider';
import { CLAUDE_CODE_INSTRUCTIONS } from '../../src/core/cli/claude/prompt';
import type { ChatEvent, ChatRequest, ToolDefinition } from '../../src/core/providers/types';
import { FakeSpawner, type FakeRun, type Script, cc, flag, mcpCall } from './cli.fakes';

type Outcome = 'ok' | 'error' | 'abort';
interface Settings {
  model: string;
  web: { search: boolean; pages: boolean };
  tools: string[];
}
const SETTINGS: Settings[] = [
  { model: 'haiku', web: { search: true, pages: true }, tools: ['propose_edit', 'request_context'] },
  { model: 'haiku', web: { search: false, pages: false }, tools: ['propose_edit', 'request_context'] },
  { model: 'opus', web: { search: true, pages: true }, tools: ['propose_edit', 'request_context'] },
  { model: 'haiku', web: { search: true, pages: true }, tools: ['report_findings', 'request_context'] },
];
const defs = (names: string[]): ToolDefinition[] => names.map((name) => ({ name, description: `the ${name} tool`, parameters: { type: 'object' } }));
const key = (s: Settings) => JSON.stringify(s);

/** A manual clock for the idle timeout. */
class Clock {
  now = 0;
  timers: Array<{ due: number; fn: () => void; live: boolean }> = [];
  schedule = (ms: number, fn: () => void) => {
    const t = { due: this.now + ms, fn, live: true };
    this.timers.push(t);
    return () => {
      t.live = false;
    };
  };
  advance(ms: number) {
    this.now += ms;
    for (const t of this.timers) {
      if (t.live && t.due <= this.now) {
        t.live = false;
        t.fn();
      }
    }
  }
}

interface World {
  spawner: FakeSpawner;
  provider: ClaudeCodeProvider;
  clock: Clock;
  warm: boolean;
  disposed: boolean;
  /** The outcome the next message's Claude Code produces. */
  next: Outcome;
  /** The settings of the spare that should be waiting, if any. */
  spare: string | null;
  /** Every prompt file Claude Code read. */
  prompts: string[];
  /** Whether the daily lockdown check has passed recently. */
  checkFresh: boolean;
}

const chats = (w: World) => w.spawner.runs.filter((r) => r.args[0] === '-p');
const waiting = (w: World) => chats(w).filter((r) => !r.killed && !r.dead && r.stdin === '');
const rootOf = (r: FakeRun) => dirname(r.cwd);

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise<void>((r) => setTimeout(r, 2));
}

function world(): World {
  const clock = new Clock();
  const w = { clock, warm: true, disposed: false, next: 'ok', spare: null, prompts: [], checkFresh: true } as unknown as World;
  w.spawner = new FakeSpawner((run): Script => {
    w.prompts.push(readFileSync(flag(run.args, '--system-prompt-file')!, 'utf8'));
    if (w.next === 'ok') return { lines: [cc.init([]), cc.text('fine'), cc.result()] };
    if (w.next === 'error') return { lines: [cc.init([]), cc.result('error_during_execution', true, 'It failed.')] };
    return { lines: [cc.init([]), cc.text('partial'), cc.result()], hangAfter: 2 };
  });
  w.provider = new ClaudeCodeProvider({
    command: () => Promise.resolve('/usr/local/bin/claude'),
    spawner: w.spawner,
    fetchMode: () => 'claude',
    selfTest: { read: () => Promise.resolve(w.checkFresh ? { version: '2.1.332', at: clock.now, ok: true } : null), write: () => Promise.resolve() },
    now: () => clock.now,
    randomToken: () => 't',
    warm: () => w.warm,
    schedule: clock.schedule,
  });
  return w;
}

/** A message with these settings; `next` is what the session says the next message will most likely use (after a preset run). */
function request(s: Settings, text: string, next?: Settings): ChatRequest {
  return {
    model: s.model,
    web: s.web,
    messages: [{ role: 'system', content: 'CONTEXT note text' }, { role: 'user', content: text }],
    toolHost: { definitions: defs(s.tools), call: () => Promise.resolve({ content: 'ran', isError: false }) },
    ...(next ? { nextLikely: { model: next.model, web: next.web, tools: defs(next.tools) } } : {}),
  };
}

/** The checks after every step (INVARIANTS.md L8). */
function check(w: World): void {
  const idle = waiting(w);
  expect(idle.length).toBeLessThanOrEqual(1);
  expect(idle.length).toBe(w.spare === null ? 0 : 1);
  for (const r of chats(w)) {
    // Each process gets at most one message.
    expect(r.stdin.split('\n').filter(Boolean).length).toBeLessThanOrEqual(1);
    // Every finished or discarded process's run folder is gone; the waiting spare's is there, with nothing private in it.
    if (idle.includes(r)) {
      expect(readFileSync(join(rootOf(r), 'system.txt'), 'utf8')).toBe(CLAUDE_CODE_INSTRUCTIONS);
      expect(readdirSync(r.cwd)).toEqual([]);
      // The waiting spare was started with exactly the settings it should have.
      const want = JSON.parse(w.spare!) as Settings;
      expect(flag(r.args, '--model')).toBe(want.model);
      expect(flag(r.args, '--tools')).toBe([...(want.web.search ? ['WebSearch'] : []), ...(want.web.pages ? ['WebFetch'] : [])].join(','));
      expect(r.args.filter((a) => a.startsWith('mcp__lektor__')).sort()).toEqual(want.tools.map((t) => `mcp__lektor__${t}`).sort());
    } else {
      expect(existsSync(rootOf(r)), `${rootOf(r)} left behind`).toBe(false);
    }
  }
  for (const p of w.prompts) expect(p).toBe(CLAUDE_CODE_INSTRUCTIONS);
}

type Cmd = fc.AsyncCommand<World, World>;
const cmd = (name: string, run: (w: World) => Promise<void>): Cmd => ({
  check: () => true,
  async run(_m, w) {
    await run(w);
    await w.provider.spareSettled();
    await until(() => chats(w).every((r) => waiting(w).includes(r) || !existsSync(rootOf(r))));
    check(w);
  },
  toString: () => name,
});

const sendCmd = ([i, outcome, n]: [number, Outcome, number | null]): Cmd =>
  cmd(`send(${i}, ${outcome}${n === null ? '' : `, then likely ${n}`})`, async (w) => {
    const s = SETTINGS[i]!;
    const next = n === null ? undefined : SETTINGS[n]!;
    w.next = outcome;
    const before = chats(w).length;
    const spareRun = waiting(w)[0];
    const matched = w.spare === key(s);
    const ctl = new AbortController();
    const events: ChatEvent[] = [];
    for await (const e of w.provider.stream(request(s, `message ${before}`, next), ctl.signal)) {
      events.push(e);
      if (outcome === 'abort' && e.type === 'text') ctl.abort();
    }
    await w.provider.spareSettled();
    // The message ran on the spare exactly when the spare's settings matched; otherwise on a fresh process.
    const served = chats(w).filter((r) => r.stdin !== '').at(-1)!;
    if (matched) {
      expect(served).toBe(spareRun);
    } else {
      expect(chats(w).indexOf(served)).toBeGreaterThanOrEqual(before);
      if (spareRun) expect(spareRun.killed).toBe(true);
    }
    // Whichever process served it, it was started with exactly this message's settings (L1).
    expect(flag(served.args, '--model')).toBe(s.model);
    expect(flag(served.args, '--tools')).toBe([...(s.web.search ? ['WebSearch'] : []), ...(s.web.pages ? ['WebFetch'] : [])].join(','));
    for (const t of s.tools) expect(served.args).toContain(`mcp__lektor__${t}`);
    expect(served.args.filter((a) => a.startsWith('mcp__lektor__')).length).toBe(s.tools.length);
    expect(served.stdin).toContain(`message ${before}`);
    expect(events.at(-1)).toEqual({ type: 'done', reason: outcome === 'ok' ? 'stop' : outcome === 'abort' ? 'aborted' : 'error' });
    // A spare starts only after a finished reply, while on and loaded: otherwise no process starts beyond the one the message needs.
    const started = chats(w).length - before;
    expect(started).toBe((matched ? 0 : 1) + (outcome === 'ok' && w.warm && !w.disposed ? 1 : 0));
    // The spare gets the settings the next message will most likely use: this message's, or those the session named.
    w.spare = outcome === 'ok' && w.warm && !w.disposed ? key(next ?? s) : null;
  });

const send = fc
  .tuple(fc.nat({ max: SETTINGS.length - 1 }), fc.constantFrom<Outcome>('ok', 'ok', 'ok', 'error', 'abort'), fc.option(fc.nat({ max: SETTINGS.length - 1 }), { nil: null, freq: 3 }))
  .map(sendCmd);
const commands = fc.commands(
  [
    // Messages are what this test is about, so they are listed four times; unload, which ends spares for good, once.
    send,
    send,
    send,
    send,
    fc.constant(
      cmd('idle 10 minutes', async (w) => {
        w.clock.advance(SPARE_IDLE_MS + 1);
        w.spare = null;
        await until(() => waiting(w).length === 0);
      }),
    ),
    fc.constant(
      cmd('the waiting spare dies', async (w) => {
        const r = waiting(w)[0];
        if (!r) return;
        r.crash();
        w.spare = null;
        await until(() => !existsSync(rootOf(r)));
      }),
    ),
    fc.boolean().map((on) =>
      cmd(`setting ${on ? 'on' : 'off'}`, async (w) => {
        w.warm = on;
        if (!on) {
          await w.provider.discardSpare();
          w.spare = null;
        }
      }),
    ),
    fc.constant(
      cmd('unload', async (w) => {
        await w.provider.dispose();
        w.disposed = true;
        w.spare = null;
      }),
    ),
  ],
  { maxCommands: 25 },
);

describe('the warm spare (INVARIANTS.md L8)', () => {
  it('L8: a reply uses the spare only with exactly its settings; one at a time; never left behind', async () => {
    await fc.assert(
      fc.asyncProperty(commands, async (cmds) => {
        const w = world();
        try {
          await fc.asyncModelRun(() => ({ model: w, real: w }), cmds);
        } finally {
          await w.provider.dispose();
        }
      }),
      { numRuns: process.env['CI'] ? 200 : 40 },
    );
  });

  it('L8: when the daily lockdown check is due, the waiting spare is discarded, not used', async () => {
    const w = world();
    for await (const _ of w.provider.stream(request(SETTINGS[0]!, 'first'), new AbortController().signal)) void _;
    await w.provider.spareSettled();
    const spare = waiting(w)[0]!;
    // A day later the check is due again; here it fails (the fake Claude Code starts with no web tools).
    w.checkFresh = false;
    const events: ChatEvent[] = [];
    for await (const e of w.provider.stream(request(SETTINGS[0]!, 'second note text'), new AbortController().signal)) events.push(e);
    await w.provider.spareSettled();
    expect(spare.killed).toBe(true);
    expect(spare.stdin).toBe('');
    expect(existsSync(rootOf(spare))).toBe(false);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('lockdown self-test failed') as unknown });
    expect(w.spawner.runs.every((r) => !r.stdin.includes('second note text'))).toBe(true);
    expect(waiting(w)).toEqual([]);
    await w.provider.dispose();
  });

  it('L8: two messages sent at once never share the spare', async () => {
    const w = world();
    for await (const _ of w.provider.stream(request(SETTINGS[0]!, 'first'), new AbortController().signal)) void _;
    await w.provider.spareSettled();
    expect(waiting(w)).toHaveLength(1);
    const drain = async (text: string) => {
      for await (const _ of w.provider.stream(request(SETTINGS[0]!, text), new AbortController().signal)) void _;
    };
    await Promise.all([drain('second'), drain('third')]);
    await w.provider.spareSettled();
    for (const r of chats(w)) expect(r.stdin.split('\n').filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(chats(w).filter((r) => r.stdin.includes('second'))).toHaveLength(1);
    expect(chats(w).filter((r) => r.stdin.includes('third'))).toHaveLength(1);
    expect(chats(w).find((r) => r.stdin.includes('second'))).not.toBe(chats(w).find((r) => r.stdin.includes('third')));
    await w.provider.dispose();
  });

  it('L8: a waiting spare’s MCP server runs no tool before a message takes it', async () => {
    const w = world();
    let ran = 0;
    const req = request(SETTINGS[0]!, 'first');
    req.toolHost = { definitions: defs(SETTINGS[0]!.tools), call: () => ((ran += 1), Promise.resolve({ content: 'ran', isError: false })) };
    for await (const _ of w.provider.stream(req, new AbortController().signal)) void _;
    await w.provider.spareSettled();
    const spare = waiting(w)[0]!;
    const r = JSON.parse((await mcpCall(spare, 'tools/call', { name: 'propose_edit', arguments: {} })).body) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(true);
    expect(ran).toBe(0);
    await w.provider.dispose();
    expect(existsSync(rootOf(spare))).toBe(false);
    expect(spare.killed).toBe(true);
  });
});
