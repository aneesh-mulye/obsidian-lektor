// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md L1–L5: the Claude Code bridge's lockdown, self-test, run folder, MCP server and streams. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLAUDE_WEB_TOOLS, CliError, LEKTOR_MCP_TOOLS, claudeArgs } from '../../src/core/cli/claude/args';
import { ClaudeStream } from '../../src/core/cli/claude/events';
import { ClaudeCodeProvider } from '../../src/core/cli/claude/provider';
import { type SelfTestObservation, type SelfTestRecord, SELF_TEST_MAX_AGE, judgeSelfTest, selfTestCurrent } from '../../src/core/cli/claude/selftest';
import { RUN_PREFIX, RunFolderError, createRun, removeRun, voidIsEmpty, writeRunFile } from '../../src/core/cli/fs';
import { answer, refuse, startMcpServer } from '../../src/core/cli/mcp';
import type { ChatEvent, ToolHost } from '../../src/core/providers/types';
import { FakeSpawner, type Script, cc, flag, mcpCall } from './cli.fakes';

// ---------------------------------------------------------------------------
// L1: the argument list

const LOCKDOWN: Array<[string, string | null]> = [
  ['-p', null],
  ['--input-format', 'stream-json'],
  ['--output-format', 'stream-json'],
  ['--verbose', null],
  ['--include-partial-messages', null],
  ['--no-session-persistence', null],
  ['--setting-sources', ''],
  ['--restricted', null],
  ['--strict-mcp-config', null],
  ['--permission-mode', 'dontAsk'],
  ['--permission-prompts', 'none'],
  ['--disable-slash-commands', null],
];
const FORBIDDEN = [
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--add-dir', '--settings', '--plugin-dir', '--plugin-url',
  '--agents', '--agent', '--resume', '-r', '--continue', '-c', '--chrome', '--safe-mode', '--bare', '--append-system-prompt', '--system-prompt',
];
const FORBIDDEN_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'Agent', 'Task', 'PowerShell', 'Skill'];

const modelName = fc.oneof(
  fc.constantFrom('opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'opus[1m]'),
  fc.constantFrom('--dangerously-skip-permissions', '-p', 'opus --tools Bash', 'opus\nBash', '', ' opus', 'x'.repeat(101)),
  fc.string({ maxLength: 20 }),
);
const toolName = fc.oneof(fc.constantFrom(...LEKTOR_MCP_TOOLS), fc.constantFrom('Bash', 'web_search', 'Read', '../x', 'mcp__evil__x'));
const path = fc.oneof(fc.constantFrom('/tmp/lektor-abc/mcp.json', '/tmp/with space/system.txt', "/tmp/quote'd/x"), fc.constantFrom('relative.json', '--settings', '/tmp/new\nline', ''));

describe('the argument list (INVARIANTS.md L1, design invariant 10)', () => {
  it('L1: every lockdown flag, always; never a forbidden flag or tool; web tools only as asked', () => {
    fc.assert(
      fc.property(modelName, fc.boolean(), fc.boolean(), fc.array(toolName, { maxLength: 6 }), path, path, (model, search, pages, lektor, mcp, sys) => {
        let args: string[];
        try {
          args = claudeArgs({ model, web: { search, pages }, lektorTools: lektor, mcpConfigPath: mcp, systemPromptPath: sys });
        } catch (err) {
          expect(err).toBeInstanceOf(CliError);
          // Refused only for a bad model, a tool Lektor never offers, or an unusable path.
          const badModel = !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/.test(model);
          const badTool = lektor.some((t) => !(LEKTOR_MCP_TOOLS as readonly string[]).includes(t));
          const badPath = [mcp, sys].some((p) => !p.startsWith('/') || /[\r\n\0]/.test(p));
          expect(badModel || badTool || badPath).toBe(true);
          return;
        }
        for (const [f, v] of LOCKDOWN) {
          const i = args.indexOf(f);
          expect(i, f).toBeGreaterThanOrEqual(0);
          if (v !== null) expect(args[i + 1], f).toBe(v);
        }
        expect(flag(args, '--mcp-config')).toBe(mcp);
        expect(flag(args, '--system-prompt-file')).toBe(sys);
        expect(flag(args, '--model')).toBe(model);
        for (const f of FORBIDDEN) expect(args).not.toContain(f);
        // --tools: only the web tools asked for.
        const tools = flag(args, '--tools')!.split(',').filter(Boolean);
        expect(tools).toEqual([...(search ? ['WebSearch'] : []), ...(pages ? ['WebFetch'] : [])]);
        // --allowedTools: those, and the Lektor tools offered over MCP; nothing else.
        const a = args.indexOf('--allowedTools');
        const allowed = a === -1 ? [] : args.slice(a + 1, args.indexOf('--system-prompt-file'));
        expect(allowed).toEqual([...tools, ...[...new Set(lektor)].map((t) => `mcp__lektor__${t}`)]);
        for (const t of [...tools, ...allowed]) for (const bad of FORBIDDEN_TOOLS) expect(t === bad || t.endsWith(`__${bad}`)).toBe(false);
        for (const t of tools) expect(CLAUDE_WEB_TOOLS).toContain(t);
      }),
    );
  });

  it('L1: the exact list (a snapshot: changing it must be deliberate)', () => {
    expect(
      claudeArgs({ model: 'opus', web: { search: true, pages: true }, lektorTools: ['request_context', 'propose_edit'], mcpConfigPath: '/tmp/lektor-r/mcp.json', systemPromptPath: '/tmp/lektor-r/system.txt' }),
    ).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
      '--setting-sources', '', '--restricted', '--strict-mcp-config', '--mcp-config', '/tmp/lektor-r/mcp.json',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--disable-slash-commands',
      '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch', 'mcp__lektor__request_context', 'mcp__lektor__propose_edit',
      '--system-prompt-file', '/tmp/lektor-r/system.txt', '--model', 'opus',
    ]);
    expect(claudeArgs({ model: 'haiku', web: { search: false, pages: false }, lektorTools: [], mcpConfigPath: '/m', systemPromptPath: '/s' })).toContain('--tools');
    expect(flag(claudeArgs({ model: 'haiku', web: { search: false, pages: false }, lektorTools: [], mcpConfigPath: '/m', systemPromptPath: '/s' }), '--tools')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// L2: the self-test verdict

describe('the lockdown self-test (INVARIANTS.md L2)', () => {
  const tokens = ['LEKTOR-CANARY-aaaa1111', 'LEKTOR-CANARY-bbbb2222'];
  const observation: fc.Arbitrary<SelfTestObservation & { expectOk: boolean }> = fc
    .record({
      tools: fc.oneof(fc.constant(['WebSearch', 'WebFetch']), fc.constant(['WebFetch', 'WebSearch']), fc.subarray(['WebSearch', 'WebFetch', 'Read', 'Bash', 'mcp__lektor__x'])).map((t): string[] => [...t]),
      mode: fc.constantFrom('dontAsk', 'dontAsk', 'default', 'bypassPermissions'),
      mcp: fc.oneof(fc.constant(['lektor']), fc.constant([] as string[]), fc.constant(['lektor', 'filesystem'])).map((m): string[] => [...m]),
      uses: fc.array(fc.constantFrom('WebSearch', 'WebFetch', 'Read', 'Bash', 'mcp__lektor__propose_edit'), { maxLength: 3 }),
      leak: fc.constantFrom('none', 'none', 'inside', 'outside'),
      finished: fc.boolean(),
      init: fc.boolean(),
      error: fc.constantFrom(undefined, undefined, 'exit 1'),
    })
    .map((r) => {
      const text = `I could not read files. ${r.leak === 'inside' ? tokens[0] : r.leak === 'outside' ? tokens[1] : ''}`;
      const expectOk: boolean =
        r.init && r.finished && !r.error && [...r.tools].sort().join() === 'WebFetch,WebSearch' && r.mode === 'dontAsk' && r.mcp.every((m) => m === 'lektor') && r.uses.every((u) => u === 'WebSearch' || u === 'WebFetch') && r.leak === 'none';
      return {
        init: r.init ? { tools: r.tools, mcpServers: r.mcp, permissionMode: r.mode } : null,
        toolUses: r.uses,
        text,
        finished: r.finished,
        ...(r.error ? { error: r.error } : {}),
        expectOk,
      };
    });

  it('L2: passes only with exactly the expected tools, dontAsk, Lektor’s server alone, no other tool used, no canary, finished', () => {
    fc.assert(
      fc.property(observation, (o) => {
        const v = judgeSelfTest(o, tokens);
        expect(v.ok).toBe(o.expectOk);
        if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
      }),
    );
  });

  it('L2: a pass lasts 24 hours for that version only; a failure never counts', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.constantFrom('2.1.332', '2.1.333'), fc.integer({ min: -1000, max: 2 * SELF_TEST_MAX_AGE }), (ok, version, age) => {
        const now = 10 * SELF_TEST_MAX_AGE;
        const current = selfTestCurrent({ version: '2.1.332', at: now - age, ok }, version, now);
        expect(current).toBe(ok && version === '2.1.332' && age >= 0 && age < SELF_TEST_MAX_AGE);
      }),
    );
    expect(selfTestCurrent(null, '2.1.332', 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L3: the run folder

describe('the run folder (INVARIANTS.md L3)', () => {
  it('L3: under the temp directory, private, void empty; only the fixed names; removed; foreign folders refused', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(fc.constantFrom('mcp.json', 'system.txt', 'canary.txt'), fc.constantFrom('../x', '/etc/passwd', 'void', 'notes.md', 'mcp.json/../../x')), { maxLength: 5 }), async (names) => {
        const run = await createRun();
        try {
          expect(run.root.startsWith(join(tmpdir(), RUN_PREFIX))).toBe(true);
          expect(statSync(run.root).mode & 0o077).toBe(0);
          expect(await voidIsEmpty(run)).toBe(true);
          const written = new Set<string>();
          for (const n of names) {
            const ok = ['mcp.json', 'system.txt', 'canary.txt'].includes(n) && !written.has(n);
            const r = await writeRunFile(run, n as 'mcp.json', 'x').then(() => true, () => false);
            expect(r).toBe(ok);
            if (r) written.add(n);
          }
          expect(readdirSync(run.root).sort()).toEqual([...written, 'void'].sort());
          for (const n of written) expect(statSync(join(run.root, n)).mode & 0o077).toBe(0);
        } finally {
          await removeRun(run);
        }
        expect(existsSync(run.root)).toBe(false);
      }),
      { numRuns: 30 },
    );
    await expect(removeRun({ root: tmpdir(), void: join(tmpdir(), 'void') })).rejects.toBeInstanceOf(RunFolderError);
    await expect(writeRunFile({ root: '/home', void: '/home/void' }, 'mcp.json', 'x')).rejects.toBeInstanceOf(RunFolderError);
  });
});

// ---------------------------------------------------------------------------
// L4: the MCP server

const host = (names: string[], calls: string[] = []): ToolHost => ({
  definitions: names.map((name) => ({ name, description: name, parameters: { type: 'object' } })),
  call: (name) => {
    calls.push(name);
    return Promise.resolve({ content: `ran ${name}`, isError: false });
  },
});

describe('the loopback MCP server (INVARIANTS.md L4)', () => {
  it('L4: a request is answered only with the token, the right Host, no Origin, POST to /mcp', () => {
    fc.assert(
      fc.property(
        fc.record({
          method: fc.constantFrom('POST', 'POST', 'GET', 'DELETE'),
          path: fc.constantFrom('/mcp', '/mcp', '/', '/mcp/x'),
          token: fc.constantFrom('good', 'good', 'bad', '', 'goo'),
          host: fc.constantFrom('127.0.0.1:4000', '127.0.0.1:4000', 'localhost:4000', 'evil.example', '127.0.0.1:4001'),
          origin: fc.constantFrom(undefined, undefined, 'https://evil.example', 'null', 'app://obsidian.md'),
        }),
        (r) => {
          const refused = refuse({ method: r.method, path: r.path, headers: { host: r.host, authorization: `Bearer ${r.token}`, ...(r.origin !== undefined ? { origin: r.origin } : {}) } }, { token: 'good', port: 4000 });
          const ok = r.method === 'POST' && r.path === '/mcp' && r.token === 'good' && r.host === '127.0.0.1:4000' && r.origin === undefined;
          expect(refused === null).toBe(ok);
        },
      ),
    );
  });

  it('L4: tools/list is exactly the offered tools; other tools never run; bad input is an error, never a throw', async () => {
    const message = fc.oneof(
      fc.record({ jsonrpc: fc.constant('2.0'), id: fc.nat(), method: fc.constant('tools/call'), params: fc.record({ name: fc.constantFrom('report_findings', 'propose_edit', 'Bash', 'fetch_page'), arguments: fc.jsonValue() }) }).map((m) => JSON.stringify(m)),
      fc.record({ jsonrpc: fc.constant('2.0'), id: fc.nat(), method: fc.constantFrom('tools/list', 'initialize', 'ping', 'resources/list', 'prompts/get') }).map((m) => JSON.stringify(m)),
      fc.constantFrom('not json', '[]', '[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]', '{"jsonrpc":"1.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","method":"notifications/initialized"}', 'null', '{"jsonrpc":"2.0","id":{},"method":"ping"}'),
      fc.string(),
    );
    await fc.assert(
      fc.asyncProperty(fc.subarray(['report_findings', 'propose_edit', 'fetch_page']), message, async (offered, body) => {
        const calls: string[] = [];
        const out = (await answer(body, host(offered, calls))) as { result?: { tools?: Array<{ name: string }>; isError?: boolean }; error?: unknown } | null;
        const parsed = (() => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            return undefined;
          }
        })();
        const m = parsed as { method?: string; params?: { name?: string }; id?: unknown } | undefined;
        if (m && typeof m === 'object' && !Array.isArray(m) && m.method === 'tools/list' && typeof m.id === 'number') expect(out?.result?.tools?.map((t) => t.name)).toEqual(offered);
        // Only an offered tool ever runs, and only for a well-formed tools/call.
        for (const c of calls) expect(offered).toContain(c);
        if (calls.length > 0) expect(m?.method === 'tools/call' && offered.includes(m.params?.name ?? '')).toBe(true);
        if (m?.method === 'tools/call' && !offered.includes(m.params?.name ?? '') && typeof m.id === 'number') expect(out?.error).toBeDefined();
      }),
    );
  });

  it('L4: the real server: refuses a wrong token, Host or Origin before running anything; answers its client; closes', async () => {
    const calls: string[] = [];
    const server = await startMcpServer(host(['report_findings'], calls));
    const fakeRun = { command: 'claude', args: ['--mcp-config', '/x'], cwd: '/', stdin: '', killed: false };
    const run = await createRun();
    try {
      const { mcpConfig } = await import('../../src/core/cli/claude/args');
      const cfgPath = await writeRunFile(run, 'mcp.json', mcpConfig(server.url, server.token));
      fakeRun.args = ['--mcp-config', cfgPath];
      expect((await mcpCall(fakeRun, 'tools/call', { name: 'report_findings', arguments: {} }, 1, { token: 'wrong' })).status).toBe(401);
      expect((await mcpCall(fakeRun, 'tools/call', { name: 'report_findings', arguments: {} }, 1, { host: 'evil.example' })).status).toBe(403);
      expect((await mcpCall(fakeRun, 'tools/call', { name: 'report_findings', arguments: {} }, 1, { origin: 'https://evil.example' })).status).toBe(403);
      expect(calls).toEqual([]);
      const ok = await mcpCall(fakeRun, 'tools/call', { name: 'report_findings', arguments: {} });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ran report_findings' }], isError: false } });
      expect(calls).toEqual(['report_findings']);
      expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
    } finally {
      await server.close();
    }
    await expect(mcpCall(fakeRun, 'ping', {})).rejects.toThrow();
    await removeRun(run);
  });

  it('L4: calls run one at a time, even when they arrive together', async () => {
    let running = 0;
    let most = 0;
    const slow: ToolHost = {
      definitions: [{ name: 'report_findings', description: 'r', parameters: { type: 'object' } }],
      call: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise<void>((r) => setTimeout(r, 20));
        running--;
        return { content: 'ok', isError: false };
      },
    };
    const server = await startMcpServer(slow);
    const run = await createRun();
    try {
      const { mcpConfig } = await import('../../src/core/cli/claude/args');
      const fakeRun = { command: 'claude', args: ['--mcp-config', await writeRunFile(run, 'mcp.json', mcpConfig(server.url, server.token))], cwd: '/', stdin: '', killed: false };
      const results = await Promise.all([1, 2, 3].map((id) => mcpCall(fakeRun, 'tools/call', { name: 'report_findings', arguments: {} }, id)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(most).toBe(1);
    } finally {
      await server.close();
      await removeRun(run);
    }
  });
});

// ---------------------------------------------------------------------------
// L5: streams

function provider(spawner: FakeSpawner, opts: { selfTestOk?: boolean } = {}) {
  let record: SelfTestRecord | null = opts.selfTestOk === false ? null : { version: '2.1.332', at: 1000, ok: true };
  const p = new ClaudeCodeProvider({
    command: () => Promise.resolve('/usr/local/bin/claude'),
    spawner,
    fetchMode: () => 'claude',
    selfTest: {
      read: () => Promise.resolve(record),
      write: (r) => {
        record = r;
        return Promise.resolve();
      },
    },
    now: () => 2000,
    randomToken: () => 'tok',
  });
  return p;
}

async function collect(stream: AsyncIterable<ChatEvent>, abortAfter?: number, ctl?: AbortController): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of stream) {
    out.push(e);
    if (abortAfter !== undefined && out.length === abortAfter) ctl?.abort();
  }
  return out;
}

describe('Claude Code streams (INVARIANTS.md L5)', () => {
  const piece = fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('日本', '🙂', '\n'));
  const step = fc.oneof(
    fc.record({ k: fc.constant('text' as const), t: piece }),
    fc.record({ k: fc.constant('think' as const), t: piece }),
    fc.record({ k: fc.constant('search' as const), q: fc.constantFrom('skerryvore height', 'x'), ok: fc.boolean() }),
    fc.record({ k: fc.constant('fetch' as const), url: fc.constantFrom('https://en.wikipedia.org/wiki/Skerryvore', 'https://x.example/a'), ok: fc.boolean() }),
    fc.record({ k: fc.constant('mcp' as const) }),
    fc.record({ k: fc.constant('garbage' as const), t: fc.constantFrom('not json', '{"type":"rate_limit_event"}', '{"type":"system","subtype":"status"}') }),
  );
  const ending = fc.constantFrom('success', 'success', 'error_max_turns', 'error_result', 'exit', 'hang');

  it('L5: one done, last; text and thinking exactly as streamed; Claude Code’s own tools reported as its own; failures are errors', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 10 }), ending, fc.option(fc.nat({ max: 8 }), { nil: undefined }), async (steps, end, abortAfter) => {
        let n = 0;
        const lines: string[] = [cc.init(['WebSearch', 'WebFetch'])];
        for (const s of steps) {
          if (s.k === 'text') lines.push(cc.text(s.t));
          else if (s.k === 'think') lines.push(cc.thinking(s.t));
          else if (s.k === 'search') lines.push(cc.toolUse(`t${++n}`, 'WebSearch', { query: s.q }), cc.toolResult(`t${n}`, `Links: [{"url":"https://en.wikipedia.org/wiki/Skerryvore"}]`, !s.ok));
          else if (s.k === 'fetch') lines.push(cc.toolUse(`t${++n}`, 'WebFetch', { url: s.url, prompt: 'p' }), cc.toolResult(`t${n}`, 'The tower is 48 m.', !s.ok));
          else if (s.k === 'mcp') lines.push(cc.toolUse(`t${++n}`, 'mcp__lektor__report_findings', {}), cc.toolResult(`t${n}`, 'Recorded.'));
          else lines.push(s.t);
        }
        const script: Script = { lines: [...lines], code: end === 'exit' ? 1 : 0, stderr: 'boom' };
        if (end === 'success') script.lines.push(cc.result());
        else if (end === 'error_max_turns' || end === 'error_result') script.lines.push(cc.result(end === 'error_result' ? 'success' : end, true, 'It failed.'));
        else if (end === 'hang') script.hangAfter = lines.length;
        const spawner = new FakeSpawner(() => script);
        const ctl = new AbortController();
        const effectiveAbort = end === 'hang' && abortAfter === undefined ? 1 : abortAfter;
        const events = await collect(provider(spawner).stream({ model: 'haiku', messages: [{ role: 'user', content: 'hi' }], web: { search: true, pages: true } }, ctl.signal), effectiveAbort, ctl);
        expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
        expect(events.at(-1)?.type).toBe('done');
        const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
        const chat = spawner.runs.find((r) => r.args[0] === '-p');
        // L3: the run folder is gone afterwards, however the run ended.
        if (chat) {
          const root = join(chat.cwd, '..');
          for (let i = 0; i < 50 && existsSync(root); i++) await new Promise<void>((r) => setTimeout(r, 5));
          expect(existsSync(root)).toBe(false);
        }
        if (done.reason === 'aborted') {
          if (chat) expect(chat.killed).toBe(true);
          return;
        }
        expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe(steps.flatMap((s) => (s.k === 'text' ? [s.t] : [])).join(''));
        expect(events.filter((e) => e.type === 'reasoning').map((e) => (e as { text: string }).text).join('')).toBe(steps.flatMap((s) => (s.k === 'think' ? [s.t] : [])).join(''));
        // Claude Code's own tools appear as its own, in order; Lektor's MCP tools are recorded by the session, not here.
        const acts = events.flatMap((e) => (e.type === 'tool_activity' ? [e] : []));
        expect(acts.map((a) => a.call.name)).toEqual(steps.flatMap((s) => (s.k === 'search' ? ['cc_web_search'] : s.k === 'fetch' ? ['cc_web_fetch'] : [])));
        for (const a of acts) expect(a.result.summary.startsWith('Claude Code ')).toBe(true);
        expect(done.reason).toBe(end === 'success' ? 'stop' : 'error');
        if (end !== 'success') expect(events.some((e) => e.type === 'error')).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('L5: Stop while Claude Code is silent kills it at once, and the stream ends aborted', async () => {
    const spawner = new FakeSpawner(() => ({ lines: [cc.init(['WebSearch']), cc.text('thinking…'), cc.result()], hangAfter: 2 }));
    const ctl = new AbortController();
    const events: ChatEvent[] = [];
    const reading = (async () => {
      for await (const e of provider(spawner).stream({ model: 'haiku', messages: [{ role: 'user', content: 'hi' }] }, ctl.signal)) events.push(e);
    })();
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'text'); i++) await new Promise<void>((r) => setTimeout(r, 5));
    const run = spawner.runs.find((r) => r.args[0] === '-p')!;
    expect(run.killed).toBe(false);
    ctl.abort(); // nothing more is coming from Claude Code
    await reading;
    expect(run.killed).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'aborted' });
  });

  it('L5: the real stream Claude Code 2.1.332 printed (WebSearch, WebFetch, answer)', () => {
    const s = new ClaudeStream();
    const events = readFileSync(join(__dirname, 'fixtures/claude-websearch.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => s.line(l));
    expect([...(s.init?.tools ?? [])].sort()).toEqual(['WebFetch', 'WebSearch']);
    expect(s.init?.permissionMode).toBe('dontAsk');
    const acts = events.flatMap((e) => (e.type === 'tool_activity' ? [e] : []));
    expect(acts.map((a) => a.call.name)).toEqual(['cc_web_search', 'cc_web_fetch']);
    expect(acts[0]!.result.summary).toMatch(/^Claude Code searched: "Skerryvore lighthouse height" · \d+ results$/);
    expect(acts[0]!.result.urls).toContain('https://en.wikipedia.org/wiki/Skerryvore');
    expect(acts[1]!.result.summary).toBe('Claude Code fetched https://en.wikipedia.org/wiki/Skerryvore');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toContain('48 metres');
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' });
  });

  it('L2, L5: no chat is sent before the self-test passes; a failed test is an error naming why', async () => {
    const leak: Script = { lines: [cc.init(['WebSearch', 'WebFetch', 'Read']), cc.text('canary: LEKTOR-CANARY-tok'), cc.result()] };
    const spawner = new FakeSpawner(() => leak);
    const p = provider(spawner, { selfTestOk: false });
    const events = await collect(p.stream({ model: 'haiku', messages: [{ role: 'user', content: 'secret note text' }] }, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('lockdown self-test failed') as unknown });
    // Only the version check and the self-test ran; the chat (with its note text) never reached Claude Code.
    expect(spawner.runs.map((r) => (r.args[0] === '-p' ? 'run' : r.args[0]))).toEqual(['--version', 'run']);
    expect(spawner.runs.every((r) => !r.stdin.includes('secret note text'))).toBe(true);
  });
});
