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

export const validSettings: fc.Arbitrary<Settings> = fc.record({
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

export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], obj) as Record<string, unknown>;
  parent[last] = value;
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
    fc.array(fc.anything(), { minLength: 13, maxLength: 13 }),
    fc.subarray(['review', 'context', 'tools', 'privacy']),
    fc.subarray(['', 'review', 'context', 'tools', 'privacy']),
    fc.string(),
  )
  .map(([s, damaged, values, deleted, extraIn, extraKey]) => {
    const raw = clone(s) as unknown as Record<string, unknown>;
    damaged.forEach((p, i) => setPath(raw, p, values[i]));
    for (const where of extraIn) {
      const target = (where === '' ? raw : raw[where]) as Record<string, unknown>;
      target['autoApply'] = true;
      target[`x-${extraKey}`] = values[12];
    }
    for (const section of deleted) delete raw[section];
    return raw;
  });
