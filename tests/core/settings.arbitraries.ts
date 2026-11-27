// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Generators for settings tests. Kept independent of the implementation's schema on purpose. */

import fc from 'fast-check';
import type { Settings } from '../../src/core/settings';

export const DISPLAY_MODES = ['prose', 'sidebar', 'inline'] as const;
export const ATTACHMENT_MODES = ['ask', 'allowed', 'upfront'] as const;

/** A canonical exclusion pattern: non-empty, trimmed, single line, ≤ 1024 chars. */
export const pattern = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 30 }),
    fc.constantFrom('Private/**', 'Journal', '*.excalidraw.md', 'Work/Clients/**', 'ünïcödé/**'),
  )
  .filter((s) => s.length > 0 && s.trim() === s && !/[\r\n]/.test(s));

/** A canonical http(s) base URL: no trailing slash, credentials, query or default port. */
export const baseUrl = fc.oneof(
  fc.constantFrom('http://127.0.0.1:11434', 'http://localhost:11434', 'https://ollama.example.com', 'http://192.168.1.20:11434/ollama'),
  fc
    .tuple(
      fc.constantFrom('http', 'https'),
      fc.domain(),
      fc.option(fc.integer({ min: 1024, max: 65535 }), { nil: undefined }),
      fc.array(fc.stringMatching(/^[a-z0-9_-]{1,8}$/), { maxLength: 2 }),
    )
    .map(([scheme, host, port, path]) => `${scheme}://${host}${port ? `:${port}` : ''}${path.map((p) => `/${p}`).join('')}`),
);

export const modelRef = fc.record({
  provider: fc.constantFrom('ollama', 'openai-compat:lm-studio', 'claude-code'),
  model: fc.oneof(fc.constantFrom('qwen3.8:27b', 'llama3.3:70b', 'gpt-oss:20b'), fc.stringMatching(/^[a-z0-9][a-z0-9.:_/-]{0,30}$/)),
});

export const validV1Settings = fc.record({
  version: fc.constant(1 as const),
  review: fc.record({ defaultDisplayMode: fc.constantFrom(...DISPLAY_MODES) }),
  context: fc.record({
    attachmentMode: fc.constantFrom(...ATTACHMENT_MODES),
    excludedFolders: fc.array(pattern, { maxLength: 8 }),
    maxLinkDepth: fc.integer({ min: 0, max: 3 }),
  }),
  tools: fc.record({
    searchesPerMessage: fc.integer({ min: 0, max: 50 }),
    fetchesPerMessage: fc.integer({ min: 0, max: 50 }),
  }),
  privacy: fc.record({ storeFullTranscripts: fc.boolean() }),
});

export const validV2Settings = validV1Settings.chain((v1) =>
  fc
    .record({ ollama: fc.record({ baseUrl }), defaultModel: fc.option(modelRef, { nil: null }) })
    .map((models) => ({ ...v1, version: 2 as const, models })),
);

export const contextLength = fc.oneof(fc.constantFrom(2048, 32768, 65536, 262144, 1048576), fc.integer({ min: 2048, max: 1048576 }));

const secretName = fc.oneof(fc.constant(''), fc.stringMatching(/^[a-z0-9-]{1,20}$/));
export const toolSettings = fc.record({
  searchesPerMessage: fc.integer({ min: 0, max: 50 }),
  fetchesPerMessage: fc.integer({ min: 0, max: 50 }),
  searchProvider: fc.constantFrom('none' as const, 'tavily' as const, 'exa' as const, 'brave' as const, 'searxng' as const, 'duckduckgo' as const),
  resultCount: fc.integer({ min: 1, max: 20 }),
  safeSearch: fc.constantFrom('off' as const, 'moderate' as const, 'strict' as const),
  region: fc.stringMatching(/^[a-z-]{0,6}$/),
  searxngUrl: fc.oneof(fc.constant(''), baseUrl),
  fetchMaxTokens: fc.integer({ min: 500, max: 32000 }),
  secrets: fc.record({ tavily: secretName, exa: secretName, brave: secretName }),
});

export const validV3Settings = fc.record({
  version: fc.constant(3 as const),
  models: fc.record({
    ollama: fc.record({ baseUrl, contextLength }),
    defaultModel: fc.option(modelRef, { nil: null }),
  }),
  review: fc.record({ defaultDisplayMode: fc.constantFrom(...DISPLAY_MODES) }),
  context: fc.record({
    attachmentMode: fc.constantFrom(...ATTACHMENT_MODES),
    excludedFolders: fc.array(pattern, { maxLength: 8 }),
    maxLinkDepth: fc.integer({ min: 0, max: 3 }),
    respectObsidianExclusions: fc.boolean(),
  }),
  tools: fc.record({
    searchesPerMessage: fc.integer({ min: 0, max: 50 }),
    fetchesPerMessage: fc.integer({ min: 0, max: 50 }),
  }),
  privacy: fc.record({ storeFullTranscripts: fc.boolean() }),
});

export const validV4Settings = fc.tuple(validV3Settings, toolSettings).map(([v3, tools]) => ({ ...v3, version: 4 as const, tools }));

export const validV5Settings = fc
  .tuple(validV4Settings, fc.subarray(['proofread', 'garden-paths', 'fact-check', 'mine']))
  .map(([v4, hidden]) => ({ ...v4, version: 5 as const, presets: { hidden } }));

/** An OpenAI- or Anthropic-compatible endpoint (INVARIANTS.md S10). */
export const endpoint = fc.record({
  id: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,31}$/),
  name: fc.constantFrom('LM Studio', 'vLLM box', 'Anthropic', 'Ollama (OpenAI)', 'ünïcode'),
  kind: fc.constantFrom('openai' as const, 'anthropic' as const),
  baseUrl,
  secret: secretName,
  contextLength: fc.integer({ min: 2048, max: 10_000_000 }),
  tools: fc.boolean(),
  images: fc.boolean(),
  maxOutput: fc.integer({ min: 256, max: 1_000_000 }),
  thinking: fc.boolean(),
  models: fc.array(fc.constantFrom('qwen3.8:27b', 'claude-opus-5-5', 'llama-3'), { maxLength: 3 }),
});

export const validV6Settings = fc
  .tuple(validV5Settings, fc.uniqueArray(endpoint, { selector: (e) => e.id, maxLength: 4 }))
  .map(([v5, endpoints]) => ({ ...v5, version: 6 as const, models: { ...v5.models, endpoints } }));

export const validV7Settings = fc
  .tuple(validV6Settings, fc.boolean(), fc.constantFrom('', '/home/me/.local/bin/claude', '/opt/claude code/claude'), fc.constantFrom('claude' as const, 'lektor' as const))
  .map(([v6, enabled, path, pages]) => ({ ...v6, version: 7 as const, cli: { claudeCode: { enabled, path, pages } } }));

export const validSettings: fc.Arbitrary<Settings> = fc
  .tuple(validV7Settings, fc.boolean())
  .map(([v7, warm]) => ({ ...v7, version: 8 as const, cli: { claudeCode: { ...v7.cli.claudeCode, warm } } }));

/** Non-exclusion leaves, each with a generator of values that must be rejected. */
export const LEAVES: Record<string, fc.Arbitrary<unknown>> = {
  'cli.claudeCode.enabled': fc.oneof(fc.constant('yes'), fc.constant(1), fc.constant(null)),
  'cli.claudeCode.path': fc.oneof(fc.constant('relative/claude'), fc.constant('/bin/\nclaude'), fc.constant(3)),
  'cli.claudeCode.warm': fc.oneof(fc.constant('on'), fc.constant(0), fc.constant(null)),
  'cli.claudeCode.pages': fc.oneof(fc.constant('everyone'), fc.constant(''), fc.constant(true)),
  'models.endpoints': fc.oneof(fc.constant('lm-studio'), fc.constant(null), fc.constant(3), fc.constant({ id: 'x' })),
  'presets.hidden': fc.oneof(fc.constant('proofread'), fc.constant([1]), fc.constant(['Bad Id']), fc.constant(['a', 'a']), fc.constant(null)),
  'review.defaultDisplayMode': fc.oneof(
    fc.string().filter((s) => !(DISPLAY_MODES as readonly string[]).includes(s)),
    fc.integer(),
    fc.constant(null),
    fc.constant('Inline'),
  ),
  'context.attachmentMode': fc.oneof(
    fc.string().filter((s) => !(ATTACHMENT_MODES as readonly string[]).includes(s)),
    fc.boolean(),
    fc.constant(null),
  ),
  'context.maxLinkDepth': fc.oneof(
    fc.integer({ min: 4 }),
    fc.integer({ max: -1 }),
    fc.double({ min: 0.01, max: 2.99, noNaN: true }).filter((n) => !Number.isInteger(n)),
    fc.constant(Number.NaN),
    fc.constant('2'),
  ),
  'tools.searchesPerMessage': fc.oneof(fc.integer({ min: 51 }), fc.integer({ max: -1 }), fc.constant(1.5), fc.constant('5')),
  'tools.fetchesPerMessage': fc.oneof(fc.integer({ min: 51 }), fc.integer({ max: -1 }), fc.constant(Infinity), fc.constant(null)),
  'privacy.storeFullTranscripts': fc.oneof(fc.constant('true'), fc.constant(1), fc.constant(null), fc.constant({})),
  'models.ollama': fc.oneof(fc.constant(null), fc.string(), fc.integer(), fc.constant([])),
  'models.ollama.baseUrl': fc.oneof(
    fc.constantFrom(
      'ftp://127.0.0.1:11434',
      'http://127.0.0.1:11434/',
      'http://user:pw@127.0.0.1:11434',
      'http://127.0.0.1:11434?x=1',
      'http://127.0.0.1:11434#f',
      'javascript:alert(1)',
      'not a url',
      '',
      'HTTP://LOCALHOST:11434',
      'http://127.0.0.1:80',
      `http://${'a'.repeat(2050)}.com`,
    ),
    fc.constant(null),
    fc.integer(),
  ),
  'models.ollama.contextLength': fc.oneof(fc.integer({ max: 2047 }), fc.integer({ min: 1048577 }), fc.constant(4096.5), fc.constant('32768'), fc.constant(null)),
  'context.respectObsidianExclusions': fc.oneof(fc.constant('yes'), fc.constant(0), fc.constant(null)),
  'tools.searchProvider': fc.oneof(fc.constant('google'), fc.constant('Tavily'), fc.constant(null)),
  'tools.resultCount': fc.oneof(fc.constant(0), fc.integer({ min: 21 }), fc.constant(2.5)),
  'tools.safeSearch': fc.oneof(fc.constant('on'), fc.constant(true)),
  'tools.region': fc.oneof(fc.constant('us en'), fc.constant('x'.repeat(33)), fc.constant(3)),
  'tools.searxngUrl': fc.oneof(fc.constant('searx.example'), fc.constant('http://h/'), fc.constant(null)),
  'tools.fetchMaxTokens': fc.oneof(fc.constant(499), fc.constant(32001), fc.constant('4000')),
  'tools.secrets': fc.oneof(fc.constant(null), fc.constant('key'), fc.constant([])),
  'tools.secrets.tavily': fc.oneof(fc.constant(42), fc.constant('a\u0007b'), fc.constant('x'.repeat(129))),
  'models.defaultModel': fc.oneof(
    fc.constantFrom(
      { provider: 'Ollama', model: 'x' },
      { provider: 'ollama' },
      { provider: 'ollama', model: '' },
      { provider: 'ollama', model: 'a\u0000b' },
      { provider: '', model: 'x' },
      { provider: 'ollama', model: 'x', extra: 1 },
    ),
    fc.integer(),
    fc.string(),
  ),
};

/** A pattern list that must be rejected as a whole. */
export const badExclusionValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything().filter((v) => !Array.isArray(v)),
  fc
    .tuple(
      fc.array(pattern, { maxLength: 4 }),
      fc.oneof(
        fc.constant(''),
        fc.constant(' leading'),
        fc.constant('trailing '),
        fc.constant('two\nlines'),
        fc.constant('x'.repeat(1025)),
        fc.integer(),
        fc.constant(null),
        fc.object(),
      ),
      fc.array(pattern, { maxLength: 4 }),
    )
    .map(([a, bad, b]) => [...a, bad, ...b]),
);

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj);
}

/** Set a nested value; does nothing if a parent on the way is not an object (it was damaged first). */
export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let parent: unknown = obj;
  for (const k of keys) {
    if (typeof parent !== 'object' || parent === null) return;
    parent = (parent as Record<string, unknown>)[k];
  }
  if (typeof parent !== 'object' || parent === null) return;
  (parent as Record<string, unknown>)[last] = value;
}

export function deletePath(obj: unknown, path: string): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj) as Record<string, unknown>;
  delete parent[last];
}

/** Valid settings with random damage: leaves replaced by anything, extra keys, deleted sections. */
export const nearValid: fc.Arbitrary<unknown> = fc
  .tuple(
    validSettings,
    fc.subarray([...Object.keys(LEAVES), 'context.excludedFolders', 'version']),
    fc.array(fc.anything(), { minLength: 26, maxLength: 26 }),
    fc.subarray(['review', 'context', 'tools', 'privacy', 'models']),
    fc.subarray(['', 'review', 'context', 'tools', 'privacy', 'models']),
    fc.string(),
  )
  .map(([s, damaged, values, deleted, extraIn, extraKey]) => {
    const raw = clone(s) as unknown as Record<string, unknown>;
    damaged.forEach((p, i) => setPath(raw, p, values[i]));
    for (const where of extraIn) {
      const target = (where === '' ? raw : raw[where]) as Record<string, unknown>;
      target['autoApply'] = true;
      target[`x-${extraKey}`] = values[25];
    }
    for (const section of deleted) delete raw[section];
    return raw;
  });
