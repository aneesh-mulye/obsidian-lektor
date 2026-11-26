// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MAX_EXCLUDED_PATTERNS, SettingsStore } from '../../src/core/settings';

const disk = (v: unknown): unknown => JSON.parse(JSON.stringify(v)) as unknown;

describe('SettingsStore', () => {
  it('has conservative defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      review: { defaultDisplayMode: 'sidebar' },
      context: { attachmentMode: 'ask', excludedFolders: [], maxLinkDepth: 3 },
      tools: { searchesPerMessage: 5, fetchesPerMessage: 5 },
      privacy: { storeFullTranscripts: false },
    });
  });

  it('hands out frozen settings', () => {
    const store = SettingsStore.load(null);
    expect(() => {
      (store.settings.tools as { searchesPerMessage: number }).searchesPerMessage = 99;
    }).toThrow(TypeError);
    expect(() => {
      (store.settings.context.excludedFolders as string[]).push('x');
    }).toThrow(TypeError);
  });

  it('applies a valid patch and rejects an invalid one whole', () => {
    const store = SettingsStore.load(null);
    expect(store.update({ tools: { searchesPerMessage: 3 }, review: { defaultDisplayMode: 'inline' } })).toEqual({ ok: true });
    expect(store.settings.tools.searchesPerMessage).toBe(3);
    expect(store.settings.review.defaultDisplayMode).toBe('inline');

    const bad = store.update({ tools: { searchesPerMessage: 2, fetchesPerMessage: 51 } });
    expect(bad.ok).toBe(false);
    expect(store.settings.tools).toEqual({ searchesPerMessage: 3, fetchesPerMessage: 5 });
  });

  it('refuses to change exclusions through update()', () => {
    const store = SettingsStore.load(null);
    const result = store.update({ context: { excludedFolders: ['Private/**'] } } as never);
    expect(result.ok).toBe(false);
    expect(store.settings.context.excludedFolders).toEqual([]);
  });

  it('normalises exclusion lines', () => {
    const store = SettingsStore.load(null);
    expect(store.setExcludedFolders(['  Private/** ', '', 'Journal', 'Journal', '\t'])).toEqual({ ok: true });
    expect(store.settings.context.excludedFolders).toEqual(['Private/**', 'Journal']);
  });

  it('rejects too many or too long patterns, and multi-line ones', () => {
    const store = SettingsStore.load(null);
    const many = Array.from({ length: MAX_EXCLUDED_PATTERNS + 1 }, (_, i) => `f${i}`);
    expect(store.setExcludedFolders(many).ok).toBe(false);
    expect(store.setExcludedFolders(['x'.repeat(1025)]).ok).toBe(false);
    expect(store.setExcludedFolders(['a\nb']).ok).toBe(false);
    expect(store.setExcludedFolders(Array.from({ length: MAX_EXCLUDED_PATTERNS }, (_, i) => `f${i}`)).ok).toBe(true);
  });

  it('keeps an unreadable exclusion list closed across saves until the user sets it', () => {
    const store = SettingsStore.load({ ...disk(DEFAULT_SETTINGS) as object, context: { attachmentMode: 'ask', maxLinkDepth: 1, excludedFolders: 'Private' } });
    expect(store.exclusionsIntact).toBe(false);
    expect(store.settings.context.excludedFolders).toEqual(['**']);
    expect(store.settings.context.maxLinkDepth).toBe(1);

    store.update({ tools: { searchesPerMessage: 1 } });
    const reloaded = SettingsStore.load(disk(store.toData()));
    expect(reloaded.exclusionsIntact).toBe(false);
    expect((reloaded.toData() as { context: { excludedFolders: unknown } }).context.excludedFolders).toBe('Private');

    reloaded.setExcludedFolders(['Private']);
    expect(SettingsStore.load(disk(reloaded.toData())).exclusionsIntact).toBe(true);
  });

  // Mutation check: a value that is invalid in memory but valid once JSON-serialised
  // (a Date becomes an ISO string) must not be written back as a readable list.
  it('does not let an unreadable list become readable through serialisation', () => {
    const raw = disk(DEFAULT_SETTINGS) as { context: Record<string, unknown> };
    raw.context.excludedFolders = [new Date(0)];
    const store = SettingsStore.load(raw);
    expect(store.exclusionsIntact).toBe(false);
    expect(SettingsStore.load(disk(store.toData())).exclusionsIntact).toBe(false);
  });

  // Regression: S2 seed 1865398749 (CI run). JSON.parse('-0') yields -0, which was kept as -0
  // but saved as 0, so loading was not idempotent.
  it('normalises -0 to 0, on load and on update', () => {
    const raw = disk(DEFAULT_SETTINGS) as { tools: Record<string, unknown>; context: Record<string, unknown> };
    raw.tools.fetchesPerMessage = -0;
    raw.context.maxLinkDepth = -0;
    const store = SettingsStore.load(raw);
    expect(Object.is(store.settings.tools.fetchesPerMessage, 0)).toBe(true);
    expect(Object.is(store.settings.context.maxLinkDepth, 0)).toBe(true);
    expect(store.update({ tools: { searchesPerMessage: -0 } })).toEqual({ ok: true });
    expect(Object.is(store.settings.tools.searchesPerMessage, 0)).toBe(true);
  });

  it('treats an empty object as damaged, not as a fresh install', () => {
    const store = SettingsStore.load({});
    expect(store.exclusionsIntact).toBe(false);
    expect(store.problems.map((p) => p.path)).toContain('version');
  });

  it('reports settings from a newer version but keeps what it can read', () => {
    const raw = { ...(disk(DEFAULT_SETTINGS) as object), version: 2 };
    const store = SettingsStore.load(raw);
    expect(store.problems).toEqual([expect.objectContaining({ path: 'version' })]);
    expect(store.exclusionsIntact).toBe(true);
    expect(store.settings.version).toBe(1);
  });
});
