// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md C6: a Codex reply goes through Lektor's tools, review and approvals; nothing is left behind. */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CodexProvider } from '../../src/core/cli/codex/provider';
import { CODEX_INSTRUCTIONS } from '../../src/core/cli/codex/prompt';
import { FROM_LEKTOR } from '../../src/core/cli/transcript';
import { ChatSession } from '../../src/core/chat/session';
import type { Chat } from '../../src/core/chat/types';
import type { PreparedContext } from '../../src/core/context/prepare';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import { proposeEditTool } from '../../src/core/review/tools';
import { ToolRegistry } from '../../src/core/tools/registry';
import { toolRuns } from '../../src/core/tools/run';
import type { FakeRun, FakeSpawner, Script } from './cli.fakes';
import { type InventoryTamper, codexMcp, config, cx, fakeCodex, isCheck, isExec } from './codex.fakes';

const NOTE = 'The the lighthouse was finished in 1844.';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface World {
  session: ChatSession;
  spawner: FakeSpawner;
  provider: CodexProvider;
  seen: { tools?: string[]; results: string[] };
  record: { version: string; at: number; ok: boolean; reason?: string } | null;
}

/** Every world made in a test is disposed after it, so no shared working folder outlives a test. */
const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.session.stop();
    await w.provider.dispose();
  }
});

function world(reply: (run: FakeRun, seen: World['seen']) => Script, opts: { web?: 'codex' | 'lektor'; inventory?: InventoryTamper; checked?: boolean; realCheck?: (run: FakeRun) => Script; images?: boolean } = {}): World {
  const seen: World['seen'] = { results: [] };
  const w = { seen, record: opts.checked === false ? null : { version: '0.162.1', at: 0, ok: true } } as World;
  w.spawner = fakeCodex((run) => (isExec(run) && config(run.args, 'model_reasoning_effort') !== undefined ? (opts.realCheck ?? (() => ({ lines: [cx.message('I can’t read files.'), cx.completed()] })))(run) : reply(run, seen)), opts.inventory ? { inventory: opts.inventory } : {});
  w.provider = new CodexProvider({
    command: () => Promise.resolve('/usr/local/bin/codex'),
    spawner: w.spawner,
    webMode: () => opts.web ?? 'codex',
    selfTest: { read: () => Promise.resolve(w.record), write: (r) => ((w.record = r), Promise.resolve()) },
    now: () => 1,
    randomToken: () => 't',
  });
  const registry = new ToolRegistry();
  registry.register(proposeEditTool({ readNote: () => Promise.resolve(NOTE), isExcluded: () => false, exists: () => true, newId: () => `p${Math.random()}`, now: () => 0 }));
  registry.register({ name: 'fetch_page', description: 'Fetch a page.', schema: z.object({ url: z.string() }), approval: 'ask', touchesVault: false, run: (a) => Promise.resolve({ content: `PAGE ${a.url}`, summary: a.url }) });
  registry.register({ name: 'web_search', description: 'Search.', schema: z.object({ query: z.string() }), approval: 'never', touchesVault: false, run: () => Promise.resolve({ content: 'results', summary: 's' }) });
  const tools = toolRuns(registry, { webNames: () => ['web_search', 'fetch_page'], reviewNames: () => ['propose_edit'], displayMode: () => 'sidebar', limits: () => ({ searches: 5, fetches: 5 }) });
  const prepared: PreparedContext = {
    message: `CONTEXT: Drafts/Essay.md\n${NOTE}`,
    images: opts.images ? [{ mime: 'image/png', data: PNG, tokens: 10, path: 'a.png' } as never] : [],
    tokens: 20,
    manifest: { notes: [{ path: 'Drafts/Essay.md', hash: 'h' }], selections: [], attachments: [], backlinkLists: 0, excluded: 0 },
    skipped: [],
    urls: [],
  };
  const chat: Chat = { id: 'c', title: '', createdAt: 0, updatedAt: 0, model: { provider: 'codex', model: 'gpt-6-luna' }, messages: [], context: EMPTY_CONTEXT };
  let n = 0;
  w.session = new ChatSession(chat, {
    providers: { get: (id) => (id === 'codex' ? w.provider : undefined) },
    clock: { now: () => 0 },
    newId: () => `id${++n}`,
    save: () => Promise.resolve(),
    prepare: () => Promise.resolve(prepared),
    tools,
  });
  worlds.push(w);
  return w;
}

const settle = async (w: World, until: () => boolean = () => !w.session.busy) => {
  for (let i = 0; i < 400 && !until(); i++) await new Promise<void>((r) => setTimeout(r, 5));
  // Wait for a finished reply's clean-up, but not for one that is meant to be still running (an approval, a hang).
  if (!w.session.busy) await w.provider.settled();
};
const chats = (w: World) => w.spawner.runs.filter((r) => isExec(r) && !isCheck(r) && config(r.args, 'model_reasoning_effort') === undefined);
const listTools = (seen: World['seen']) => async (run: FakeRun) => {
  const r = await codexMcp(run, 'tools/list', {});
  seen.tools = ((r.json?.['result'] as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
  return [];
};
const callTool = (seen: World['seen'], name: string, args: unknown) => async (run: FakeRun) => {
  const r = await codexMcp(run, 'tools/call', { name, arguments: args }, 2);
  const res = r.json?.['result'] as { content: Array<{ text: string }>; isError: boolean };
  seen.results.push(`${res.isError ? 'ERR' : 'OK'} ${res.content[0]!.text}`);
  return [cx.mcp(name, args)];
};
const runFolderOf = (r: FakeRun) => dirname(config(r.args, 'model_instructions_file')!.replace(/^"|"$/g, ''));

describe('Codex replies (INVARIANTS.md C6)', () => {
  it('C6: Lektor tools over MCP run through the same tool run; the proposal lands; Codex’s search shows; the prompt is the shared block format', async () => {
    const w = world((_run, seen) => ({
      lines: [
        cx.thread(),
        cx.turn(),
        listTools(seen),
        cx.search('lighthouse 1844', ['https://a.example/x']),
        callTool(seen, 'propose_edit', { path: 'Drafts/Essay.md', edits: [{ find: 'The the lighthouse', replace: 'The lighthouse', reason: 'doubled word' }] }),
        cx.message('Proposed.'),
        cx.completed(),
      ],
    }));
    expect(w.session.send('Proofread my note.')).toBe(true);
    await settle(w);
    const reply = w.session.chat.messages.at(-1)!;
    expect(reply.role === 'assistant' && reply.status).toBe('complete');
    if (reply.role !== 'assistant') return;
    expect(reply.content).toBe('Proposed.');
    const calls = (reply.steps ?? []).flatMap((s) => s.calls.map((c) => [c.name, c.result?.ok]));
    expect(calls).toEqual([
      ['codex_web_search', true],
      ['propose_edit', true],
    ]);
    expect(Object.values(w.session.chat.proposals ?? {})).toHaveLength(1);
    expect(w.seen.results[0]).toMatch(/^OK Proposed 1 change/);
    // Codex searches itself, so Lektor's web tools are not offered.
    expect(w.seen.tools).toEqual(['propose_edit']);
    const run = chats(w)[0]!;
    expect(config(run.args, 'web_search')).toBe('"live"');
    expect(run.stdin).toBe(`${FROM_LEKTOR}CONTEXT: Drafts/Essay.md\n${NOTE}\n\nUser:\nProofread my note.`);
    expect(run.args.join(' ')).not.toContain('lighthouse');
    expect(run.env['LEKTOR_MCP_TOKEN']).toMatch(/^[0-9a-f]{64}$/);
    expect(run.args.join(' ')).not.toContain(run.env['LEKTOR_MCP_TOKEN']);
    expect(existsSync(runFolderOf(run))).toBe(false);
    expect(readdirSync(run.cwd)).toEqual([]);
  });

  it('C6: with the globe off, Codex gets no web search and Lektor’s web tools aren’t offered', async () => {
    const w = world((_run, seen) => ({ lines: [listTools(seen), cx.message('OK.'), cx.completed()] }));
    w.session.setTools(false);
    w.session.send('Hi.');
    await settle(w);
    expect(config(chats(w)[0]!.args, 'web_search')).toBe('"disabled"');
    expect(w.seen.tools).toEqual(['propose_edit']);
  });

  it('C6: with Lektor doing web work, Codex’s search is off and Lektor’s search and fetch go over MCP, with their approvals', async () => {
    const w = world((_run, seen) => ({ lines: [listTools(seen), callTool(seen, 'fetch_page', { url: 'https://unknown.example/x' }), cx.message('Read it.'), cx.completed()] }), { web: 'lektor' });
    w.session.send('Read that page.');
    await settle(w, () => (w.session.chat.messages.at(-1) as { approval?: unknown }).approval !== undefined);
    const waiting = w.session.chat.messages.at(-1) as { approval?: { id: string; tool: string } };
    expect(waiting.approval?.tool).toBe('fetch_page');
    w.session.answerApproval(waiting.approval!.id, true);
    await settle(w);
    expect(w.seen.tools?.sort()).toEqual(['fetch_page', 'propose_edit', 'web_search']);
    expect(w.seen.results).toEqual(['OK PAGE https://unknown.example/x']);
    expect(config(chats(w)[0]!.args, 'web_search')).toBe('"disabled"');
  });

  it('C6: Stop ends Codex at once; the run folder goes; the shared folder stays empty and goes on unload', async () => {
    const w = world(() => ({ lines: [cx.thread(), cx.turn(), cx.message('Thinking…'), cx.completed()], hangAfter: 2 }));
    w.session.send('Go.');
    await settle(w, () => chats(w).length > 0 && chats(w)[0]!.stdin !== '');
    w.session.stop();
    await settle(w);
    const run = chats(w)[0]!;
    expect(run.killed).toBe(true);
    expect(existsSync(runFolderOf(run))).toBe(false);
    expect(readdirSync(run.cwd)).toEqual([]);
    // A second reply uses the same working folder (the prompt's start stays the same).
    w.spawner.script = (r) => (isExec(r) ? { lines: [cx.message('Done.'), cx.completed()] } : { lines: [] });
    w.session.send('Again.');
    await settle(w);
    expect(chats(w)[1]!.cwd).toBe(run.cwd);
    const workdir = (r: FakeRun) => r.args[r.args.indexOf('-C') + 1];
    expect(workdir(chats(w)[1]!)).toBe(workdir(run));
    expect(workdir(run)).toBe(run.cwd);
    await w.provider.dispose();
    expect(existsSync(dirname(run.cwd))).toBe(false);
  });

  it('C6: context images go as files in the shared folder, named by content, the same path every turn', async () => {
    const w = world(() => ({ lines: [cx.message('A pixel.'), cx.completed()] }), { images: true });
    w.session.send('What is it?');
    await settle(w);
    w.session.send('And now?');
    await settle(w);
    const [a, b] = chats(w);
    const imgs = (r: FakeRun) => r.args.filter((x) => x.startsWith('--image='));
    expect(imgs(a!)).toHaveLength(1);
    expect(imgs(b!)).toEqual(imgs(a!));
    expect(imgs(a!)[0]).toMatch(new RegExp(`^--image=${dirname(a!.cwd)}/image-[0-9a-f]{32}\\.png$`));
    expect(readFileSync(imgs(a!)[0]!.slice('--image='.length)).toString('base64')).toBe(PNG);
    await w.provider.dispose();
  });

  it('C6: the instructions file is Lektor’s, every run; Codex’s own state and log go in the run folder', async () => {
    let instructions = '';
    const w = world((run) => {
      instructions = readFileSync(config(run.args, 'model_instructions_file')!.replace(/^"|"$/g, ''), 'utf8');
      return { lines: [cx.message('OK.'), cx.completed()] };
    });
    w.session.send('Hi.');
    await settle(w);
    expect(instructions).toBe(CODEX_INSTRUCTIONS);
    const run = chats(w)[0]!;
    expect(config(run.args, 'sqlite_home')).toBe(`"${runFolderOf(run)}/state"`);
    expect(config(run.args, 'log_dir')).toBe(`"${runFolderOf(run)}/log"`);
  });
});

describe('Codex checks before any chat (INVARIANTS.md C5)', () => {
  it('C5: the real check runs first when due; if it fails, no chat process starts and nothing is sent', async () => {
    const w = world(() => ({ lines: [cx.message('Sure.'), cx.completed()] }), { checked: false, realCheck: () => ({ lines: [cx.other('command_execution'), cx.message('Done.'), cx.completed()] }) });
    w.session.send('Proofread my note.');
    await settle(w);
    const reply = w.session.chat.messages.at(-1)!;
    expect(reply.role === 'assistant' && reply.status).toBe('error');
    expect(reply.role === 'assistant' && reply.error).toMatch(/lockdown self-test failed \(Codex used command_execution\)/);
    expect(chats(w)).toEqual([]);
    expect(w.spawner.runs.every((r) => !r.stdin.includes('lighthouse'))).toBe(true);
    expect(w.record).toMatchObject({ ok: false, version: '0.162.1' });
  });

  it('C5: a clean real check is stored; the inventory runs on the scripted model and passes', async () => {
    const w = world(() => ({ lines: [cx.message('Sure.'), cx.completed()] }), { checked: false });
    w.session.send('Hi.');
    await settle(w);
    expect(w.record).toMatchObject({ ok: true, version: '0.162.1' });
    const check = w.spawner.runs.find(isCheck)!;
    expect(config(check.args, 'model_provider')).toBe('"lektor_check"');
    expect(config(check.args, 'web_search')).toBe('"disabled"');
    expect(chats(w)).toHaveLength(1);
  });

  it('C5: a failed inventory is never remembered as a pass: the next message checks again, and is refused again', async () => {
    const w = world(() => ({ lines: [cx.message('Sure.'), cx.completed()] }), { inventory: { extraNested: 'exec_command' } });
    for (const text of ['First.', 'Second.']) {
      w.session.send(text);
      await settle(w);
      const reply = w.session.chat.messages.at(-1)!;
      expect(reply.role === 'assistant' && reply.error, text).toMatch(/tool check failed/);
    }
    expect(w.spawner.runs.filter(isCheck)).toHaveLength(2);
    expect(chats(w)).toEqual([]);
  });

  it('C6: if the shared working folder isn’t empty, the reply is refused, and the next one gets a fresh folder', async () => {
    const w = world(() => ({ lines: [cx.message('OK.'), cx.completed()] }));
    w.session.send('One.');
    await settle(w);
    const first = chats(w)[0]!;
    writeFileSync(`${first.cwd}/planted.md`, 'planted');
    w.session.send('Two.');
    await settle(w);
    const reply = w.session.chat.messages.at(-1)!;
    expect(reply.role === 'assistant' && reply.error).toMatch(/working folder was not empty/);
    expect(chats(w)).toHaveLength(1);
    w.session.send('Three.');
    await settle(w);
    expect(chats(w)).toHaveLength(2);
    expect(chats(w)[1]!.cwd).not.toBe(first.cwd);
    expect(readdirSync(chats(w)[1]!.cwd)).toEqual([]);
    // The refused folder is removed, not left behind.
    expect(existsSync(dirname(first.cwd))).toBe(false);
  });

  it('C5: if the inventory finds an extra tool, the model is refused and nothing is sent', async () => {
    for (const tamper of [{ extraNested: 'exec_command' }, { extraTop: 'apply_patch' }, { dropNested: 'propose_edit' }, { leak: 'LEKTOR-CANARY-t' }, { skipSecond: true }, { token: 'wrong' }, { globals: ['function', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'] }] satisfies InventoryTamper[]) {
      const w = world(() => ({ lines: [cx.message('Sure.'), cx.completed()] }), { inventory: tamper });
      w.session.send('Proofread my note.');
      await settle(w);
      const reply = w.session.chat.messages.at(-1)!;
      expect(reply.role === 'assistant' && reply.error, JSON.stringify(tamper)).toMatch(/tool check failed/);
      expect(chats(w), JSON.stringify(tamper)).toEqual([]);
      expect(w.spawner.runs.every((r) => !r.stdin.includes('lighthouse'))).toBe(true);
      await w.provider.dispose();
    }
  });
});
