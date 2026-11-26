// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md L6: a Claude Code reply goes through Lektor's tools, review and approvals. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeCodeProvider } from '../../src/core/cli/claude/provider';
import { ChatSession } from '../../src/core/chat/session';
import type { Chat } from '../../src/core/chat/types';
import type { PreparedContext } from '../../src/core/context/prepare';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import { proposeEditTool } from '../../src/core/review/tools';
import { ToolRegistry } from '../../src/core/tools/registry';
import { toolRuns } from '../../src/core/tools/run';
import { FakeSpawner, type FakeRun, type Script, cc, flag, mcpCall } from './cli.fakes';

const NOTE = 'The the lighthouse was finished in 1844.';

interface World {
  session: ChatSession;
  spawner: FakeSpawner;
  seen: { tools?: string[]; system?: string; results: string[] };
}

function world(script: (run: FakeRun, seen: World['seen']) => Script, opts: { pages?: 'claude' | 'lektor' } = {}): World {
  const seen: World['seen'] = { results: [] };
  const spawner = new FakeSpawner((run) => script(run, seen));
  const provider = new ClaudeCodeProvider({
    command: () => Promise.resolve('/usr/local/bin/claude'),
    spawner,
    fetchMode: () => opts.pages ?? 'claude',
    selfTest: { read: () => Promise.resolve({ version: '2.1.332', at: 0, ok: true }), write: () => Promise.resolve() },
    now: () => 1,
    randomToken: () => 't',
  });
  const registry = new ToolRegistry();
  registry.register(proposeEditTool({ readNote: () => Promise.resolve(NOTE), isExcluded: () => false, exists: () => true, newId: () => `p${Math.random()}`, now: () => 0 }));
  // A stand-in for fetch_page that always asks first.
  registry.register({ name: 'fetch_page', description: 'Fetch a page.', schema: z.object({ url: z.string() }), approval: 'ask', touchesVault: false, run: (a) => Promise.resolve({ content: `PAGE ${a.url}`, summary: a.url }) });
  registry.register({ name: 'web_search', description: 'Search.', schema: z.object({ query: z.string() }), approval: 'never', touchesVault: false, run: () => Promise.resolve({ content: 'results', summary: 's' }) });
  const tools = toolRuns(registry, {
    webNames: () => ['web_search', 'fetch_page'],
    reviewNames: () => ['propose_edit'],
    displayMode: () => 'sidebar',
    limits: () => ({ searches: 5, fetches: 5 }),
  });
  const prepared: PreparedContext = {
    message: `CONTEXT: Drafts/Essay.md\n${NOTE}`,
    images: [],
    tokens: 20,
    manifest: { notes: [{ path: 'Drafts/Essay.md', hash: 'h' }], selections: [], attachments: [], backlinkLists: 0, excluded: 0 },
    skipped: [],
    urls: [],
  };
  const chat: Chat = { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'claude-code', model: 'haiku' }, messages: [], context: EMPTY_CONTEXT };
  let n = 0;
  const session = new ChatSession(chat, {
    providers: { get: (id) => (id === 'claude-code' ? provider : undefined) },
    clock: { now: () => 0 },
    newId: () => `id${++n}`,
    save: () => Promise.resolve(),
    prepare: () => Promise.resolve(prepared),
    tools,
  });
  return { session, spawner, seen };
}

const settle = async (w: World, until: () => boolean = () => !w.session.busy) => {
  for (let i = 0; i < 400 && !until(); i++) await new Promise<void>((r) => setTimeout(r, 5));
};

/** The fake CLI reads its config the way Claude Code does, lists Lektor's tools, and calls them. */
const listTools = (seen: World['seen']) => async (run: FakeRun) => {
  const r = JSON.parse((await mcpCall(run, 'tools/list', {})).body) as { result: { tools: Array<{ name: string }> } };
  seen.tools = r.result.tools.map((t) => t.name);
  seen.system = readFileSync(flag(run.args, '--system-prompt-file')!, 'utf8');
  return [];
};
const callTool = (seen: World['seen'], name: string, args: unknown) => async (run: FakeRun) => {
  const r = JSON.parse((await mcpCall(run, 'tools/call', { name, arguments: args }, 2)).body) as { result: { content: Array<{ text: string }>; isError: boolean } };
  seen.results.push(`${r.result.isError ? 'ERR' : 'OK'} ${r.result.content[0]!.text}`);
  return [cc.toolUse('tu1', `mcp__lektor__${name}`, args), cc.toolResult('tu1', r.result.content[0]!.text)];
};

describe('Claude Code replies (INVARIANTS.md L6)', () => {
  it('L6: Lektor tools called over MCP run through the same tool run; the proposal lands in the chat; steps keep their order', async () => {
    const w = world((_run, seen) => ({
      lines: [
        cc.init(['WebSearch', 'WebFetch', 'mcp__lektor__propose_edit']),
        listTools(seen),
        cc.text('Let me fix that. '),
        callTool(seen, 'propose_edit', { path: 'Drafts/Essay.md', edits: [{ find: 'The the lighthouse', replace: 'The lighthouse', reason: 'doubled word' }] }),
        cc.text('Proposed.'),
        cc.result(),
      ],
    }));
    expect(w.session.send('Proofread my note.')).toBe(true);
    await settle(w);
    const reply = w.session.chat.messages.at(-1)!;
    expect(reply.role === 'assistant' && reply.status).toBe('complete');
    if (reply.role !== 'assistant') return;
    expect(reply.content).toBe('Proposed.');
    expect(reply.steps?.map((s) => ({ text: s.text, calls: s.calls.map((c) => [c.name, c.result?.ok]) }))).toEqual([{ text: 'Let me fix that. ', calls: [['propose_edit', true]] }]);
    expect(Object.values(w.session.chat.proposals ?? {})).toHaveLength(1);
    expect(w.seen.results[0]).toMatch(/^OK Proposed 1 change/);
    // Lektor's web tools are not offered: Claude Code searches and fetches itself.
    expect(w.seen.tools).toEqual(['propose_edit']);
    const run = w.spawner.runs.find((r) => r.args[0] === '-p')!;
    expect(flag(run.args, '--tools')).toBe('WebSearch,WebFetch');
    // The model sees the context and exactly the visible transcript.
    expect(w.seen.system).toContain(`CONTEXT: Drafts/Essay.md\n${NOTE}`);
    expect(run.stdin).toContain('Proofread my note.');
  });

  it('L6: in Lektor-fetch mode, fetch_page is offered over MCP (with its approval card) and WebFetch is not', async () => {
    const w = world(
      (_run, seen) => ({ lines: [cc.init(['WebSearch', 'mcp__lektor__fetch_page']), listTools(seen), callTool(seen, 'fetch_page', { url: 'https://unknown.example/x' }), cc.text('Read it.'), cc.result()] }),
      { pages: 'lektor' },
    );
    w.session.send('Read that page.');
    await settle(w, () => w.session.chat.messages.at(-1)?.role === 'assistant' && (w.session.chat.messages.at(-1) as { approval?: unknown }).approval !== undefined);
    const waiting = w.session.chat.messages.at(-1) as { approval?: { id: string; tool: string } };
    expect(waiting.approval?.tool).toBe('fetch_page');
    w.session.answerApproval(waiting.approval!.id, true);
    await settle(w);
    expect(w.seen.tools?.sort()).toEqual(['fetch_page', 'propose_edit']);
    expect(w.seen.results).toEqual(['OK PAGE https://unknown.example/x']);
    const run = w.spawner.runs.find((r) => r.args[0] === '-p')!;
    expect(flag(run.args, '--tools')).toBe('WebSearch');
    expect(run.args).toContain('mcp__lektor__fetch_page');
  });

  it('L6: with the globe off, Claude Code gets no web tools at all', async () => {
    const w = world((_run, seen) => ({ lines: [cc.init([]), listTools(seen), cc.text('OK.'), cc.result()] }), { pages: 'lektor' });
    w.session.setTools(false);
    w.session.send('Hi.');
    await settle(w);
    const run = w.spawner.runs.find((r) => r.args[0] === '-p')!;
    expect(flag(run.args, '--tools')).toBe('');
    expect(w.seen.tools).toEqual(['propose_edit']);
  });

  it('L6: Stop while an approval card waits declines it, kills Claude Code, and the reply stays stopped', async () => {
    const w = world((_run, seen) => ({ lines: [cc.init(['WebSearch', 'mcp__lektor__fetch_page']), listTools(seen), callTool(seen, 'fetch_page', { url: 'https://unknown.example/x' }), cc.text('never'), cc.result()] }), { pages: 'lektor' });
    w.session.send('Read that page.');
    await settle(w, () => (w.session.chat.messages.at(-1) as { approval?: unknown }).approval !== undefined);
    w.session.stop();
    await settle(w, () => w.spawner.runs.some((r) => r.args[0] === '-p' && r.killed));
    const reply = w.session.chat.messages.at(-1)!;
    expect(reply.role === 'assistant' && reply.status).toBe('stopped');
    expect(w.spawner.runs.find((r) => r.args[0] === '-p')!.killed).toBe(true);
    await settle(w, () => w.seen.results.length > 0);
    expect(w.seen.results[0]).toMatch(/^ERR /);
    expect(reply.role === 'assistant' && reply.content).toBe('');
    // L3: the run folder is removed after a stopped run too.
    const root = join(w.spawner.runs.find((r) => r.args[0] === '-p')!.cwd, '..');
    await settle(w, () => !existsSync(root));
    expect(existsSync(root)).toBe(false);
  });

  it('L5, L6: Claude Code’s own searches appear in the reply as its own, between the text around them', async () => {
    const w = world(() => ({
      lines: [
        cc.init(['WebSearch', 'WebFetch']),
        cc.text('Searching. '),
        cc.toolUse('s1', 'WebSearch', { query: 'skerryvore' }),
        cc.toolResult('s1', 'Links: [{"url":"https://en.wikipedia.org/wiki/Skerryvore"}]'),
        cc.text('It is 48 m.'),
        cc.result(),
      ],
    }));
    w.session.send('How tall is Skerryvore?');
    await settle(w);
    const reply = w.session.chat.messages.at(-1)!;
    if (reply.role !== 'assistant') throw new Error('no reply');
    expect(reply.content).toBe('It is 48 m.');
    expect(reply.steps?.map((s) => ({ text: s.text, calls: s.calls.map((c) => [c.name, c.result?.summary, c.result?.urls]) }))).toEqual([
      { text: 'Searching. ', calls: [['cc_web_search', 'Claude Code searched: "skerryvore" · 1 result', ['https://en.wikipedia.org/wiki/Skerryvore']]] },
    ]);
  });
});
