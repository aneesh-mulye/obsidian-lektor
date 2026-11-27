// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md C1–C5: the Codex bridge's lockdown, catalog, events, prompt and self-test. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CODEX_CONFIG_KEYS, CODEX_VETTED_FEATURES, type CodexFeature, codexArgs, disabledFeatures, parseFeatures } from '../../src/core/cli/codex/args';
import { checkModel, contextWindow, parseCatalog, runCatalog, visibleModels } from '../../src/core/cli/codex/catalog';
import { CodexStream } from '../../src/core/cli/codex/events';
import { codexPrompt } from '../../src/core/cli/codex/prompt';
import { CODE_MODE_TOOLS, INVENTORY_MARK, RESOURCE_TOOLS, judgeInventory, judgeRealCheck, offeredTools } from '../../src/core/cli/codex/selftest';
import { THIS_REPLY, turnBlock } from '../../src/core/cli/transcript';
import type { ChatEvent, ChatMessage } from '../../src/core/providers/types';
import { CATALOG, FEATURES_TEXT, config, cx } from './codex.fakes';

// ---------------------------------------------------------------------------
// C1: the lockdown is unconditional

const FILES = { instructions: '/tmp/lektor-r/system.txt', catalog: '/tmp/lektor-r/models.json', state: '/tmp/lektor-r/state', log: '/tmp/lektor-r/log' };
const MCP = 'http://127.0.0.1:41234/mcp';
const PREFIX = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config'];
const FORBIDDEN = ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--full-auto', '--yolo', '--approve-for-me', '--add-dir', '--oss', '--profile', '-p', '--worktree', '--enable', '--search', 'resume', 'danger-full-access', 'workspace-write', '--last'];
const STAGES = ['stable', 'experimental', 'under development', 'deprecated', 'removed'];

const featureArb: fc.Arbitrary<CodexFeature> = fc.record({
  name: fc.oneof(fc.stringMatching(/^[a-z][a-z0-9_]{0,16}$/), fc.constantFrom('shell_tool', 'view_image', 'hooks', 'image_generation', 'apps', 'memories', 'multi_agent', ...CODEX_VETTED_FEATURES)),
  stage: fc.constantFrom(...STAGES),
  on: fc.boolean(),
});
const featuresArb = fc
  .tuple(fc.uniqueArray(featureArb, { selector: (f) => f.name, maxLength: 20 }), fc.constantFrom(...STAGES), fc.boolean())
  .map(([fs, stage, on]) => [...fs.filter((f) => !(CODEX_VETTED_FEATURES as readonly string[]).includes(f.name)), ...CODEX_VETTED_FEATURES.map((name) => ({ name, stage, on }))]);
const modelArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,30}$/);
const inputArb = fc.record({
  model: modelArb,
  features: featuresArb,
  web: fc.boolean(),
  images: fc.array(fc.stringMatching(/^[a-f0-9]{4,12}$/).map((h) => `/tmp/lektor-s/image-${h}.png`), { maxLength: 3 }),
  check: fc.option(fc.integer({ min: 1, max: 65535 }).map((port) => ({ modelUrl: `http://127.0.0.1:${port}/v1` })), { nil: undefined }),
  effort: fc.option(fc.constant('low' as const), { nil: undefined }),
});

/** The reference rule: what must be disabled. */
const shouldDisable = (fs: readonly CodexFeature[]) => fs.filter((f) => f.stage !== 'removed' && !(CODEX_VETTED_FEATURES as readonly string[]).includes(f.name) && !(f.stage === 'deprecated' && !f.on)).map((f) => f.name);
const cKeys = (args: readonly string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a.slice(0, a.indexOf('='))] : []));

describe('Codex lockdown (INVARIANTS.md C1)', () => {
  it('C1: every argument list has every lockdown flag, disables exactly the unvetted features, and nothing forbidden', () => {
    fc.assert(
      fc.property(inputArb, (inp) => {
        const { check, effort, ...rest } = inp;
        const args = codexArgs({ ...rest, ...(check ? { check } : {}), ...(effort ? { effort } : {}), workdir: '/tmp/lektor-s/void', files: FILES, mcpUrl: MCP });
        expect(args.slice(0, PREFIX.length)).toEqual(PREFIX);
        expect(args.at(-1)).toBe('-');
        const at = (flag: string) => args[args.indexOf(flag) + 1];
        expect(at('-C')).toBe('/tmp/lektor-s/void');
        expect(at('--sandbox')).toBe('read-only');
        expect(at('-m')).toBe(inp.model);
        const fixed: Record<string, string> = {
          approval_policy: '"never"',
          project_doc_max_bytes: '0',
          'skills.include_instructions': 'false',
          'skills.bundled.enabled': 'false',
          'agents.enabled': 'false',
          'apps._default.enabled': 'false',
          'plugins._default.enabled': 'false',
          personality: '"none"',
          'history.persistence': '"none"',
          sqlite_home: `"${FILES.state}"`,
          log_dir: `"${FILES.log}"`,
          model_instructions_file: `"${FILES.instructions}"`,
          model_catalog_json: `"${FILES.catalog}"`,
          'mcp_servers.lektor.url': `"${MCP}"`,
          'mcp_servers.lektor.bearer_token_env_var': '"LEKTOR_MCP_TOKEN"',
          'mcp_servers.lektor.required': 'true',
          'mcp_servers.lektor.default_tools_approval_mode': '"approve"',
        };
        for (const [k, v] of Object.entries(fixed)) expect(config(args, k), k).toBe(v);
        expect(config(args, 'web_search')).toBe(inp.web && !inp.check ? '"live"' : '"disabled"');
        // Only the fixed keys, each once; only Lektor's MCP server; a model provider only in the inventory check.
        const keys = cKeys(args);
        for (const k of keys) expect(CODEX_CONFIG_KEYS as readonly string[]).toContain(k);
        expect(keys.length).toBe(new Set(keys).size);
        expect(keys.filter((k) => k.startsWith('mcp_servers.')).every((k) => k.startsWith('mcp_servers.lektor.'))).toBe(true);
        expect(config(args, 'model_provider') !== undefined).toBe(inp.check !== undefined);
        if (inp.check) expect(config(args, 'model_providers.lektor_check')).toContain(`base_url = "${inp.check.modelUrl}"`);
        if (inp.check) expect(config(args, 'model_providers.lektor_check')).toContain('requires_openai_auth = false');
        // Features: exactly the unvetted, non-removed ones (deprecated ones already off left alone); nothing enabled.
        const disabled = args.flatMap((a, i) => (args[i - 1] === '--disable' ? [a] : []));
        expect(disabled.sort()).toEqual(shouldDisable(inp.features).sort());
        for (const v of CODEX_VETTED_FEATURES) expect(disabled).not.toContain(v);
        for (const f of FORBIDDEN) expect(args).not.toContain(f);
        expect(args.some((a) => /danger|bypass|workspace-write|full-auto|yolo/.test(a))).toBe(false);
        // Images: one --image= each.
        expect(args.filter((a) => a.startsWith('--image='))).toEqual(inp.images.map((i) => `--image=${i}`));
        expect(args).not.toContain('-i');
        expect(args).not.toContain('--image');
      }),
    );
  });

  it('C1: it fails closed: a bad model, feature name, path or server, or no features at all', () => {
    const ok = { model: 'gpt-6-luna', features: parseFeatures(FEATURES_TEXT), web: true, workdir: '/tmp/lektor-s/void', files: FILES, mcpUrl: MCP };
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom('', '-m', '--yolo', 'a b', 'x"y', 'a=b', 'gpt\n6', 'a'.repeat(101)), fc.string().filter((s) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(s))), (model) => {
        expect(() => codexArgs({ ...ok, model })).toThrow();
      }),
    );
    expect(() => codexArgs({ ...ok, features: [] })).toThrow();
    expect(() => codexArgs({ ...ok, features: [{ name: 'shell tool', stage: 'stable', on: true }] })).toThrow();
    expect(() => codexArgs({ ...ok, features: [{ name: 'x"; danger=1', stage: 'stable', on: true }] })).toThrow();
    expect(() => codexArgs({ ...ok, workdir: '/tmp/a"b' })).toThrow();
    expect(() => codexArgs({ ...ok, workdir: 'relative/void' })).toThrow();
    expect(() => codexArgs({ ...ok, files: { ...FILES, catalog: '/tmp/x\nmodel_provider="evil"' } })).toThrow();
    expect(() => codexArgs({ ...ok, images: ['/tmp/a" -c x="y'] })).toThrow();
    expect(() => codexArgs({ ...ok, mcpUrl: 'http://example.com:80/mcp' })).toThrow();
    expect(() => codexArgs({ ...ok, check: { modelUrl: 'https://api.openai.com/v1' } })).toThrow();
  });

  it('C1: feature lists are read exactly, and anything unreadable fails closed', () => {
    const fs = parseFeatures(FEATURES_TEXT);
    expect(fs.find((f) => f.name === 'agent_message_board')).toEqual({ name: 'agent_message_board', stage: 'under development', on: false });
    expect(disabledFeatures(fs).sort()).toEqual(['agent_message_board', 'apps', 'hooks', 'image_generation', 'memories', 'shell_tool', 'use_legacy_landlock', 'view_image']);
    for (const bad of ['', '\n\n', 'shell_tool stable', 'shell_tool stable yes', 'Shell-Tool stable true', 'Error: could not load']) expect(() => parseFeatures(bad)).toThrow();
    fc.assert(
      fc.property(fc.uniqueArray(featureArb, { selector: (f) => f.name, minLength: 1, maxLength: 15 }), (list) => {
        const text = list.map((f) => `${f.name.padEnd(40)} ${f.stage.padEnd(18)} ${String(f.on)}`).join('\n');
        expect(parseFeatures(text)).toEqual(list);
      }),
    );
  });

  it('C1: a pinned argument list (snapshot)', () => {
    const args = codexArgs({
      model: 'gpt-6-luna',
      features: parseFeatures(FEATURES_TEXT),
      web: true,
      workdir: '/tmp/lektor-s/void',
      files: FILES,
      mcpUrl: MCP,
      images: ['/tmp/lektor-s/image-ab.png'],
    });
    expect(args).toEqual([
      ...PREFIX,
      '--image=/tmp/lektor-s/image-ab.png',
      '-C', '/tmp/lektor-s/void', '--sandbox', 'read-only', '-m', 'gpt-6-luna',
      '-c', 'approval_policy="never"', '-c', 'web_search="live"', '-c', 'project_doc_max_bytes=0',
      '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '-c', 'agents.enabled=false',
      '-c', 'apps._default.enabled=false', '-c', 'plugins._default.enabled=false', '-c', 'personality="none"',
      '-c', 'history.persistence="none"', '-c', 'sqlite_home="/tmp/lektor-r/state"', '-c', 'log_dir="/tmp/lektor-r/log"',
      '-c', 'model_instructions_file="/tmp/lektor-r/system.txt"', '-c', 'model_catalog_json="/tmp/lektor-r/models.json"',
      '-c', 'model_reasoning_summary="auto"',
      '-c', `mcp_servers.lektor.url="${MCP}"`, '-c', 'mcp_servers.lektor.bearer_token_env_var="LEKTOR_MCP_TOKEN"',
      '-c', 'mcp_servers.lektor.required=true', '-c', 'mcp_servers.lektor.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.lektor.tool_timeout_sec=3600',
      '--disable', 'apps', '--disable', 'hooks', '--disable', 'image_generation', '--disable', 'memories', '--disable', 'shell_tool',
      '--disable', 'use_legacy_landlock', '--disable', 'view_image', '--disable', 'agent_message_board',
      '-',
    ]);
  });
});

// ---------------------------------------------------------------------------
// C2: the per-run catalog

const jsonish = fc.jsonValue({ maxDepth: 2 });
describe('Codex model catalog (INVARIANTS.md C2)', () => {
  it('C2: the run catalog is Codex’s own entry for the model, with only the tool fields changed', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ slug: fc.stringMatching(/^[a-z][a-z0-9.-]{0,12}$/), visibility: fc.constantFrom('list', 'hide'), extra: fc.dictionary(fc.stringMatching(/^[a-z_]{1,8}$/), jsonish, { maxKeys: 4 }) }), { selector: (m) => m.slug, minLength: 1, maxLength: 6 }),
        fc.nat(),
        (models, pick) => {
          const entries = models.map((m) => ({ ...m.extra, slug: m.slug, visibility: m.visibility }));
          const json = JSON.stringify({ models: entries });
          const parsed = parseCatalog(json);
          const chosen = entries[pick % entries.length]!;
          const out = JSON.parse(runCatalog(parsed, chosen.slug)) as { models: Array<Record<string, unknown>> };
          expect(out.models).toHaveLength(1);
          const expected = JSON.parse(JSON.stringify({ ...chosen, apply_patch_tool_type: null, experimental_supported_tools: [] })) as unknown;
          expect(out.models[0]).toEqual(expected);
          expect(() => runCatalog(parsed, `${chosen.slug}-not-there`)).toThrow();
          expect(visibleModels(parsed).map((m) => m.id)).toEqual(entries.filter((e) => e.visibility === 'list').map((e) => e.slug));
        },
      ),
    );
  });

  it('C2: unreadable catalogs fail closed; the check model is the first visible “luna”', () => {
    for (const bad of ['', 'null', '{}', '{"models":[]}', '{"models":[{"slug":""}]}', '[1,2]']) expect(() => parseCatalog(bad)).toThrow();
    const c = parseCatalog(JSON.stringify(CATALOG));
    expect(checkModel(c)).toBe('gpt-6-luna');
    expect(visibleModels(c)).toEqual([
      { id: 'gpt-6-sol', name: 'GPT-6-Sol', contextWindow: 258400 },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', contextWindow: 258400 },
    ]);
    expect(contextWindow(undefined)).toBe(200000);
  });
});

// ---------------------------------------------------------------------------
// C3: events

type Part =
  | { k: 'msg'; text: string }
  | { k: 'reason'; text: string }
  | { k: 'search'; query: string; urls: string[] }
  | { k: 'open'; url: string }
  | { k: 'mcp'; server: string }
  | { k: 'warn'; message: string }
  | { k: 'other'; type: string }
  | { k: 'junk'; raw: string };
const urlArb = fc.stringMatching(/^[a-z]{1,8}$/).map((h) => `https://${h}.example/${h}`);
const partArb: fc.Arbitrary<Part> = fc.oneof(
  fc.record({ k: fc.constant('msg' as const), text: fc.oneof(fc.string(), fc.constantFrom('', '日本 🙂', '\n\nx')) }),
  fc.record({ k: fc.constant('reason' as const), text: fc.string() }),
  fc.record({ k: fc.constant('search' as const), query: fc.string({ maxLength: 20 }), urls: fc.uniqueArray(urlArb, { maxLength: 3 }) }),
  fc.record({ k: fc.constant('open' as const), url: urlArb }),
  fc.record({ k: fc.constant('mcp' as const), server: fc.constantFrom('lektor', 'lektor', 'other') }),
  fc.record({ k: fc.constant('warn' as const), message: fc.string({ minLength: 1, maxLength: 30 }) }),
  fc.record({ k: fc.constant('other' as const), type: fc.constantFrom('command_execution', 'file_change', 'todo_list') }),
  fc.record({ k: fc.constant('junk' as const), raw: fc.oneof(fc.string(), fc.constantFrom('{', 'null', '[]', '{"type":"item.started","item":{"type":"web_search"}}', '{"type":"turn.started"}')) }),
);
const lineOf = (p: Part, i: number): string => {
  switch (p.k) {
    case 'msg':
      return cx.message(p.text, `m${i}`);
    case 'reason':
      return cx.reasoning(p.text, `r${i}`);
    case 'search':
      return cx.search(p.query, p.urls, `s${i}`);
    case 'open':
      return cx.open(p.url, `o${i}`);
    case 'mcp':
      return cx.mcp('propose_edit', {}, p.server, `t${i}`);
    case 'warn':
      return cx.itemError(p.message);
    case 'other':
      return cx.other(p.type, `x${i}`);
    case 'junk':
      return p.raw;
  }
};

describe('Codex events (INVARIANTS.md C3)', () => {
  it('C3: one done, last; text and reasoning exactly as sent; Codex’s web work shown; Lektor’s calls not doubled; never throws', () => {
    fc.assert(
      fc.property(fc.array(partArb, { maxLength: 12 }), fc.constantFrom('completed', 'failed', 'error', 'none'), fc.array(partArb, { maxLength: 3 }), (given, ending, after) => {
        const s = new CodexStream();
        const lines = [cx.thread(), cx.turn(), ...given.map(lineOf), ...(ending === 'completed' ? [cx.completed()] : ending === 'failed' ? [cx.failed('quota')] : ending === 'error' ? [cx.error('broken')] : []), ...after.map((p, i) => lineOf(p, i + 100))];
        const events: ChatEvent[] = lines.flatMap((l) => s.line(l));
        // Lines after the end are ignored; with no end, they are part of the stream.
        const parts = ending === 'none' ? [...given, ...after] : given;
        const dones = events.filter((e) => e.type === 'done');
        expect(dones.length).toBe(ending === 'none' ? 0 : 1);
        if (dones.length > 0) expect(events.at(-1)).toEqual(dones[0]);
        if (ending === 'completed') expect(dones[0]).toEqual({ type: 'done', reason: 'stop' });
        if (ending === 'failed' || ending === 'error') {
          expect(dones[0]).toEqual({ type: 'done', reason: 'error' });
          expect(events.at(-2)?.type).toBe('error');
        }
        expect(s.finished).toBe(ending === 'completed');
        // Text: the non-empty messages, in order, joined by blank lines.
        const msgs = parts.flatMap((p) => (p.k === 'msg' && p.text !== '' ? [p.text] : []));
        expect(events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')).toBe(msgs.join('\n\n'));
        const reasons = parts.flatMap((p) => (p.k === 'reason' && p.text !== '' ? [p.text] : []));
        expect(events.flatMap((e) => (e.type === 'reasoning' ? [e.text] : [])).join('')).toBe(reasons.join('\n\n'));
        // Activities: one per search or opened page, none for Lektor's own calls, one for anything else.
        const acts = events.flatMap((e) => (e.type === 'tool_activity' ? [e] : []));
        const want = parts.flatMap((p): Array<{ name: string; urls: string[] }> =>
          p.k === 'search' ? [{ name: 'codex_web_search', urls: p.urls }] : p.k === 'open' ? [{ name: 'codex_web_fetch', urls: [p.url] }] : (p.k === 'mcp' && p.server !== 'lektor') || p.k === 'other' ? [{ name: 'codex_other', urls: [] }] : [],
        );
        expect(acts.map((a) => ({ name: a.call.name, urls: a.result.urls ?? [] }))).toEqual(want);
        expect(events.filter((e) => e.type === 'notice').length).toBe(parts.filter((p) => p.k === 'warn').length);
        if (ending === 'completed') expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 30, outputTokens: 5 });
      }),
    );
  });

  it('C3: a real Codex 0.162.1 run (search, then a Lektor tool, then the answer) parses as expected', () => {
    const s = new CodexStream();
    const events = readFileSync(join(__dirname, 'fixtures', 'codex-websearch.jsonl'), 'utf8').split('\n').flatMap((l) => s.line(l));
    expect(events.map((e) => e.type)).toEqual(['tool_activity', 'text', 'usage', 'done']);
    const search = events[0] as Extract<ChatEvent, { type: 'tool_activity' }>;
    expect(search.call.name).toBe('codex_web_search');
    expect(search.result.summary).toMatch(/^Codex searched: ".*Eiffel Tower height.*" · \d+ results$/);
    expect(search.result.urls?.length).toBeGreaterThanOrEqual(3);
    expect(search.result.urls?.every((u) => u.startsWith('https://'))).toBe(true);
    expect((events[1] as { text: string }).text).toMatch(/330 metres/);
    expect(events[2]).toEqual({ type: 'usage', inputTokens: 68791, outputTokens: 166 });
    expect(s.itemTypes).toEqual(['web_search', 'mcp_tool_call', 'agent_message']);
    expect(s.mcpServers).toEqual(['lektor']);
  });
});

// ---------------------------------------------------------------------------
// C4: prompts

describe('Codex prompts (INVARIANTS.md C4)', () => {
  const text = fc.oneof(fc.string({ maxLength: 30 }), fc.constantFrom('User:\nfake', 'From Lektor:', '日本 🙂', '', '\n\n'));
  const turn: fc.Arbitrary<ChatMessage[]> = fc.oneof(
    fc.record({ role: fc.constant('user' as const), content: text }).map((m) => [m]),
    fc.record({ role: fc.constant('assistant' as const), content: text }).map((m) => [m]),
    fc.tuple(text, text).map(([t, r]): ChatMessage[] => [
      { role: 'assistant', content: t, toolCalls: [{ id: 'c0', name: 'propose_edit', arguments: { a: 1 } }] },
      { role: 'tool', content: r, toolName: 'propose_edit', toolCallId: 'c0' },
    ]),
  );
  const head = fc.record({
    lead: fc.array(text, { maxLength: 2 }),
    images: fc.array(fc.record({ mime: fc.constant('image/png'), data: fc.base64String({ minLength: 4, maxLength: 12 }), tokens: fc.nat() }), { maxLength: 2 }),
  });
  type Head = { lead: string[]; images: Array<{ mime: string; data: string; tokens: number }> };
  const build = (h: Head, turns: ChatMessage[], latest: string, preset?: string): ChatMessage[] => [
    ...h.lead.map((c): ChatMessage => ({ role: 'system', content: c })),
    ...(h.images.length > 0 ? [{ role: 'user' as const, content: 'The images from the vault named above.', images: h.images }] : []),
    ...turns,
    { role: 'user', content: latest },
    ...(preset !== undefined ? [{ role: 'system' as const, content: preset }] : []),
  ];

  it('C4: the next message’s prompt begins with this one’s (bar this reply’s instruction); images the same each turn', () => {
    fc.assert(
      fc.property(head, fc.array(turn, { maxLength: 4 }), text, text, text, fc.option(text, { nil: undefined }), fc.option(text, { nil: undefined }), (h, turns, first, reply, next, p1, p2) => {
        const before = codexPrompt(build(h, turns.flat(), first, p1));
        const after = codexPrompt(build(h, [...turns.flat(), { role: 'user', content: first }, { role: 'assistant', content: reply }], next, p2));
        const stable = p1 === undefined ? before.text : before.text.slice(0, before.text.lastIndexOf(`\n\n${THIS_REPLY}`) === -1 ? 0 : before.text.lastIndexOf(`\n\n${THIS_REPLY}`));
        expect(after.text.startsWith(stable)).toBe(true);
        expect(after.images).toEqual(before.images);
        expect(before.images.map((i) => i.data)).toEqual(h.images.map((i) => i.data));
      }),
    );
  });

  it('C4: every visible turn once, in order, in the shared block format; this reply’s instruction last', () => {
    fc.assert(
      fc.property(head, fc.array(turn, { maxLength: 4 }), text, fc.option(text, { nil: undefined }), (h, turns, latest, preset) => {
        const messages = build(h, turns.flat(), latest, preset);
        const p = codexPrompt(messages);
        const blocks = [
          ...h.lead.map((c) => `From Lektor:\n${c}`),
          ...messages.filter((m) => m.role !== 'system').map((m) => turnBlock(m)),
          ...(preset !== undefined ? [`${THIS_REPLY}${preset}`] : []),
        ];
        expect(p.text).toBe(blocks.join('\n\n'));
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// C5: the self-test fails closed

const INSTR = 'Lektor instructions.';
const LEKTOR = ['request_context', 'propose_edit', 'propose_note', 'report_findings', 'web_search', 'fetch_page'].map((t) => `mcp__lektor__${t}`);
interface Inv {
  top: string[];
  nested: string[];
  resources: unknown;
  templates: unknown;
  globals: string[];
  instructions: string;
  devFirst: string;
  leak: string;
  second: boolean;
}
const clean: Inv = { top: [...CODE_MODE_TOOLS], nested: [...RESOURCE_TOOLS, ...LEKTOR], resources: '{"resources":[]}', templates: '{"resourceTemplates":[]}', globals: Array(6).fill('undefined') as string[], instructions: '', devFirst: INSTR, leak: '', second: true };
function bodiesOf(i: Inv): unknown[] {
  const first = {
    instructions: i.instructions,
    input: [
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: i.top.map((name) => ({ type: name === 'exec' ? 'custom' : 'function', name })) }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: i.devFirst }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `env ${i.leak}` }] },
    ],
  };
  const report = { tools: i.nested, resources: i.resources, templates: i.templates, globals: i.globals };
  const second = { ...first, input: [...first.input, { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: INVENTORY_MARK + JSON.stringify(report) }] }] };
  return i.second ? [first, second] : [first];
}
const TOKENS = ['LEKTOR-CANARY-a', 'LEKTOR-CANARY-b'];
const deviation: fc.Arbitrary<[string, (i: Inv) => Inv]> = fc.oneof(
  fc.constantFrom('exec_command', 'shell', 'apply_patch', 'view_image', 'request_user_input_async', 'image_gen', 'web_search').map((t): [string, (i: Inv) => Inv] => [`extra top ${t}`, (i) => ({ ...i, top: [...i.top, t] })]),
  fc.constantFrom('apply_patch', 'exec_command', 'mcp__other__read', 'view_image', 'clock__curr_time').map((t): [string, (i: Inv) => Inv] => [`extra nested ${t}`, (i) => ({ ...i, nested: [...i.nested, t] })]),
  fc.constantFrom(...LEKTOR, ...RESOURCE_TOOLS).map((t): [string, (i: Inv) => Inv] => [`missing nested ${t}`, (i) => ({ ...i, nested: i.nested.filter((n) => n !== t) })]),
  fc.constant<[string, (i: Inv) => Inv]>(['duplicate nested', (i) => ({ ...i, nested: [...i.nested, i.nested[0]!] })]),
  fc.constant<[string, (i: Inv) => Inv]>(['no exec', (i) => ({ ...i, top: ['wait', 'request_user_input', 'exec_command'] })]),
  fc.constant<[string, (i: Inv) => Inv]>(['resources', (i) => ({ ...i, resources: '{"resources":[{"uri":"file:///etc"}]}' })]),
  fc.constant<[string, (i: Inv) => Inv]>(['templates', (i) => ({ ...i, templates: { resourceTemplates: [{}] } })]),
  fc.constant<[string, (i: Inv) => Inv]>(['resource error', (i) => ({ ...i, resources: 'error: nope' })]),
  fc.nat({ max: 5 }).map((k): [string, (i: Inv) => Inv] => [`global ${k}`, (i) => ({ ...i, globals: i.globals.map((g, j) => (j === k ? 'function' : g)) })]),
  fc.constant<[string, (i: Inv) => Inv]>(['other instructions', (i) => ({ ...i, instructions: 'You are Codex.' })]),
  fc.constant<[string, (i: Inv) => Inv]>(['other developer text first', (i) => ({ ...i, devFirst: `${INSTR} plus AGENTS.md` })]),
  fc.constantFrom(...TOKENS).map((t): [string, (i: Inv) => Inv] => [`leak ${t}`, (i) => ({ ...i, leak: `...${t}...` })]),
  fc.constant<[string, (i: Inv) => Inv]>(['no second request', (i) => ({ ...i, second: false })]),
);

describe('Codex self-test (INVARIANTS.md C5)', () => {
  it('C5: a clean inventory passes; every single deviation fails', () => {
    expect(judgeInventory({ bodies: bodiesOf(clean), instructions: INSTR, tokens: TOKENS })).toEqual({ ok: true });
    expect(judgeInventory({ bodies: bodiesOf({ ...clean, instructions: INSTR }), instructions: INSTR, tokens: TOKENS })).toEqual({ ok: true });
    fc.assert(
      fc.property(fc.array(deviation, { minLength: 1, maxLength: 3 }), fc.boolean(), (devs, shuffle) => {
        let inv = clean;
        for (const [, f] of devs) inv = f(inv);
        if (shuffle) inv = { ...inv, top: [...inv.top].reverse(), nested: [...inv.nested].reverse() };
        const v = judgeInventory({ bodies: bodiesOf(inv), instructions: INSTR, tokens: TOKENS });
        expect(v.ok, devs.map((d) => d[0]).join(', ')).toBe(false);
      }),
    );
    expect(judgeInventory({ bodies: [], instructions: INSTR, tokens: TOKENS }).ok).toBe(false);
    expect(judgeInventory({ bodies: [null], instructions: INSTR, tokens: TOKENS }).ok).toBe(false);
    expect(judgeInventory({ bodies: bodiesOf(clean), instructions: INSTR, tokens: TOKENS, error: 'exit 1' }).ok).toBe(false);
  });

  it('C5: a model without code mode passes only with its direct tools', () => {
    const direct = (tools: string[]) => [{ input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: INSTR }] }], tools: tools.map((name) => (name === 'tool_search' ? { type: 'tool_search' } : { type: 'function', name })) }];
    expect(judgeInventory({ bodies: direct([...RESOURCE_TOOLS, 'request_user_input', 'tool_search']), instructions: INSTR, tokens: TOKENS })).toEqual({ ok: true });
    for (const extra of ['apply_patch', 'shell', 'exec_command', 'view_image', 'local_shell', 'web_search']) expect(judgeInventory({ bodies: direct([...RESOURCE_TOOLS, extra]), instructions: INSTR, tokens: TOKENS }).ok).toBe(false);
    expect(offeredTools(direct(['tool_search'])[0])).toEqual(['tool_search']);
  });

  it('C5: the real check passes only when finished, with allowed items only, Lektor’s server only, and no canary', () => {
    const ok = { itemTypes: ['web_search', 'agent_message', 'mcp_tool_call', 'reasoning', 'error'], mcpServers: ['lektor'], text: 'I can’t read files.', finished: true };
    expect(judgeRealCheck(ok, TOKENS)).toEqual({ ok: true });
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('command_execution', 'file_change', 'todo_list', 'collab_tool_call', '').map((t) => ({ ...ok, itemTypes: [...ok.itemTypes, t] })),
          fc.constant({ ...ok, mcpServers: ['lektor', 'files'] }),
          fc.constantFrom(...TOKENS).map((t) => ({ ...ok, text: `here: ${t}` })),
          fc.constant({ ...ok, finished: false }),
          fc.constant({ ...ok, error: 'quota' }),
        ),
        (obs) => {
          expect(judgeRealCheck(obs, TOKENS).ok).toBe(false);
        },
      ),
    );
  });
});
