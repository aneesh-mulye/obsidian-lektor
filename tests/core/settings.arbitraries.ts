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

export const validSettings: fc.Arbitrary<Settings> = fc.record({
  version: fc.constant(2 as const),
  models: fc.record({
    ollama: fc.record({ baseUrl }),
    defaultModel: fc.option(modelRef, { nil: null }),
  }),
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

/** Non-exclusion leaves, each with a generator of values that must be rejected. */
export const LEAVES: Record<string, fc.Arbitrary<unknown>> = {
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
    fc.array(fc.anything(), { minLength: 16, maxLength: 16 }),
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
      target[`x-${extraKey}`] = values[15];
    }
    for (const section of deleted) delete raw[section];
    return raw;
  });
