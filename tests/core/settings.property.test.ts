// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md S1–S5: settings loading, round-trip, salvage and fail-closed exclusions. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  EXCLUDE_EVERYTHING,
  type Settings,
  SettingsSchema,
  SettingsStore,
} from '../../src/core/settings';
import {
  LEAVES,
  badExclusionValue,
  clone,
  deletePath,
  getPath,
  nearValid,
  baseUrl,
  contextLength,
  modelRef,
  pattern,
  setPath,
  validSettings,
  validV1Settings,
  validV2Settings,
  validV3Settings,
  validV4Settings,
  toolSettings,
} from './settings.arbitraries';

/** What Obsidian's saveData/loadData does to our data: a JSON round-trip. */
const disk = (v: unknown): unknown => {
  const text = JSON.stringify(v);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
};

const anyStored = fc.oneof(fc.anything(), fc.jsonValue(), nearValid, validSettings);

describe('SettingsStore (INVARIANTS.md S1–S5)', () => {
  it('S1: loading is total and the result conforms to the strict schema', () => {
    fc.assert(
      fc.property(anyStored, (raw) => {
        const store = SettingsStore.load(raw);
        expect(SettingsSchema.safeParse(store.settings).success).toBe(true);
        // No key the schema doesn't name survives (e.g. autoApply).
        expect(JSON.stringify(store.settings)).not.toContain('autoApply');
        expect(() => disk(store.toData())).not.toThrow();
      }),
    );
  });

  it('S2: valid settings round-trip, and loading is idempotent', () => {
    fc.assert(
      fc.property(validSettings, (s) => {
        const store = SettingsStore.load(disk(s));
        expect(store.settings).toEqual(s);
        expect(store.exclusionsIntact).toBe(true);
        expect(store.problems).toEqual([]);
        expect(SettingsStore.load(disk(store.toData())).settings).toEqual(s);
      }),
    );
    fc.assert(
      fc.property(anyStored, (raw) => {
        const once = SettingsStore.load(raw);
        const twice = SettingsStore.load(disk(once.toData()));
        expect(twice.settings).toEqual(once.settings);
        expect(twice.exclusionsIntact).toBe(once.exclusionsIntact);
      }),
    );
  });

  it('S3: one bad field falls back to its default; every other field is kept', () => {
    const leaf = fc.constantFrom(...Object.keys(LEAVES));
    fc.assert(
      fc.property(
        validSettings,
        leaf.chain((path) => LEAVES[path]!.map((bad) => ({ path, bad }))),
        (s, { path, bad }) => {
          const raw = clone(s) as unknown;
          setPath(raw, path, bad);
          const store = SettingsStore.load(disk(raw));

          const expected = clone(s);
          setPath(expected, path, getPath(DEFAULT_SETTINGS, path));
          // NaN/Infinity become null on disk; either way the field is invalid.
          expect(store.settings).toEqual(expected);
          expect(store.problems.map((p) => p.path)).toEqual([path]);
          expect(store.exclusionsIntact).toBe(true);
        },
      ),
    );
  });

  it('S3: unknown keys are dropped and reported, without touching known fields', () => {
    fc.assert(
      fc.property(validSettings, fc.constantFrom('', 'review.', 'context.', 'tools.', 'privacy.', 'models.', 'models.ollama.'), (s, where) => {
        const raw = clone(s) as unknown;
        setPath(raw, `${where}autoApply`, true);
        const store = SettingsStore.load(disk(raw));
        expect(store.settings).toEqual(s);
        expect(store.problems.map((p) => p.path)).toEqual([`${where}autoApply`]);
      }),
    );
  });

  it('S4: a stored but unreadable exclusion list fails closed', () => {
    const corrupt = fc.oneof(
      // excludedFolders itself is bad or missing.
      fc.tuple(validSettings, fc.option(badExclusionValue, { nil: undefined })).map(([s, bad]) => {
        const raw = clone(s) as unknown;
        if (bad === undefined) deletePath(raw, 'context.excludedFolders');
        else setPath(raw, 'context.excludedFolders', bad);
        return raw;
      }),
      // The context section is missing or not an object.
      fc.tuple(validSettings, fc.anything()).map(([s, ctx]) => ({ ...clone(s), context: ctx })),
      // The whole file is not an object.
      fc.anything().filter((v) => v !== null && v !== undefined && (typeof v !== 'object' || Array.isArray(v))),
    );
    fc.assert(
      fc.property(corrupt, (raw) => {
        const stored = disk(raw);
        fc.pre(stored !== null && stored !== undefined);
        const ctx = (stored as { context?: { excludedFolders?: unknown } } | null)?.context;
        // Skip the rare case where the generator produced a valid list by chance.
        fc.pre(!(typeof ctx === 'object' && ctx !== null && Array.isArray(ctx.excludedFolders) &&
          ctx.excludedFolders.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 1024 && p.trim() === p && !/[\r\n]/.test(p))));

        const store = SettingsStore.load(stored);
        expect(store.exclusionsIntact).toBe(false);
        expect(store.settings.context.excludedFolders).toEqual(EXCLUDE_EVERYTHING);
        expect(store.problems.some((p) => p.path.startsWith('context') || p.path === '')).toBe(true);
      }),
    );
  });

  it('S6: version-1 settings migrate (via 2) to version 3 losslessly', () => {
    fc.assert(
      fc.property(validV1Settings, (v1) => {
        const store = SettingsStore.load(disk(v1));
        const { version: _v, ...rest } = v1;
        expect(store.settings).toEqual({
          ...rest,
          version: 5,
          models: DEFAULT_SETTINGS.models,
          context: { ...rest.context, respectObsidianExclusions: true },
          tools: { ...DEFAULT_SETTINGS.tools, ...rest.tools },
          presets: { hidden: [] },
        });
        expect(store.problems).toEqual([]);
        expect(store.exclusionsIntact).toBe(true);
      }),
    );
  });

  it('S7: version-2 settings migrate to version 3 losslessly', () => {
    fc.assert(
      fc.property(validV2Settings, (v2) => {
        const store = SettingsStore.load(disk(v2));
        const { version: _v, ...rest } = v2;
        expect(store.settings).toEqual({
          ...rest,
          version: 5,
          models: { ...rest.models, ollama: { ...rest.models.ollama, contextLength: 32768 } },
          context: { ...rest.context, respectObsidianExclusions: true },
          tools: { ...DEFAULT_SETTINGS.tools, ...rest.tools },
          presets: { hidden: [] },
        });
        expect(store.problems).toEqual([]);
      }),
    );
  });

  it('S8: version-3 settings migrate to version 4 losslessly, with no search provider and no keys', () => {
    fc.assert(
      fc.property(validV3Settings, (v3) => {
        const store = SettingsStore.load(disk(v3));
        const { version: _v, ...rest } = v3;
        expect(store.settings).toEqual({ ...rest, version: 5, tools: { ...DEFAULT_SETTINGS.tools, ...rest.tools }, presets: { hidden: [] } });
        expect(store.settings.tools.searchProvider).toBe('none');
        expect(store.settings.tools.secrets).toEqual({ tavily: '', exa: '', brave: '' });
        expect(store.problems).toEqual([]);
      }),
    );
  });

  it('S9: version-4 settings migrate to version 5 losslessly, with no presets hidden', () => {
    fc.assert(
      fc.property(validV4Settings, (v4) => {
        const store = SettingsStore.load(disk(v4));
        const { version: _v, ...rest } = v4;
        expect(store.settings).toEqual({ ...rest, version: 5, presets: { hidden: [] } });
        expect(store.problems).toEqual([]);
      }),
    );
  });

  it('S4: a fresh install starts with no exclusions, intact', () => {
    for (const raw of [null, undefined]) {
      const store = SettingsStore.load(raw);
      expect(store.exclusionsIntact).toBe(true);
      expect(store.settings).toEqual(DEFAULT_SETTINGS);
      expect(store.settings.context.excludedFolders).toEqual([]);
      expect(store.problems).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// S5: stateful model

interface Model {
  settings: Settings;
  intact: boolean;
}
interface Real {
  store: SettingsStore;
}

function checkAgainst(m: Model, r: Real): void {
  expect(r.store.settings).toEqual(m.settings);
  expect(r.store.exclusionsIntact).toBe(m.intact);
}

type Patch = Record<string, Record<string, unknown>>;

class UpdateCommand implements fc.Command<Model, Real> {
  constructor(
    readonly patch: Patch,
    readonly valid: boolean,
  ) {}
  check = () => true;
  run(m: Model, r: Real): void {
    const result = r.store.update(this.patch);
    expect(result.ok).toBe(this.valid);
    if (this.valid) {
      for (const [section, fields] of Object.entries(this.patch)) {
        Object.assign((m.settings as unknown as Patch)[section]!, fields);
      }
    }
    checkAgainst(m, r);
  }
  toString = () => `update(${JSON.stringify(this.patch)}) /* ${this.valid ? 'valid' : 'invalid'} */`;
}

/** The model's own normalisation, written independently of the implementation. */
function modelNormalise(lines: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const line of lines) {
    if (/[\r\n]/.test(line)) return null;
    const p = line.trim();
    if (p === '' || out.includes(p)) continue;
    if (p.length > 1024) return null;
    out.push(p);
  }
  return out.length > 1000 ? null : out;
}

class SetExcludedCommand implements fc.Command<Model, Real> {
  constructor(readonly lines: string[]) {}
  check = () => true;
  run(m: Model, r: Real): void {
    const expected = modelNormalise(this.lines);
    const result = r.store.setExcludedFolders(this.lines);
    expect(result.ok).toBe(expected !== null);
    if (expected !== null) {
      m.settings.context.excludedFolders = expected;
      m.intact = true;
    }
    checkAgainst(m, r);
  }
  toString = () => `setExcludedFolders(${JSON.stringify(this.lines)})`;
}

class SaveReloadCommand implements fc.Command<Model, Real> {
  check = () => true;
  run(m: Model, r: Real): void {
    r.store = SettingsStore.load(disk(r.store.toData()));
    checkAgainst(m, r);
  }
  toString = () => 'saveAndReload()';
}

const validField: Record<string, Record<string, fc.Arbitrary<unknown>>> = {
  review: { defaultDisplayMode: fc.constantFrom('prose', 'sidebar', 'inline') },
  context: {
    attachmentMode: fc.constantFrom('ask', 'allowed', 'upfront'),
    maxLinkDepth: fc.integer({ min: 0, max: 3 }),
    respectObsidianExclusions: fc.boolean(),
  },
  tools: {
    searchesPerMessage: fc.integer({ min: 0, max: 50 }),
    fetchesPerMessage: fc.integer({ min: 0, max: 50 }),
    searchProvider: toolSettings.map((t) => t.searchProvider),
    resultCount: fc.integer({ min: 1, max: 20 }),
    secrets: toolSettings.map((t) => t.secrets),
  },
  privacy: { storeFullTranscripts: fc.boolean() },
  models: {
    ollama: fc.record({ baseUrl, contextLength }),
    defaultModel: fc.option(modelRef, { nil: null }),
  },
};

const validPatch: fc.Arbitrary<Patch> = fc
  .subarray(Object.keys(validField), { minLength: 1 })
  .chain((sections) =>
    fc.record(
      Object.fromEntries(
        sections.map((sec) => [sec, fc.record(validField[sec]!, { requiredKeys: [] })]),
      ) as Record<string, fc.Arbitrary<Record<string, unknown>>>,
    ),
  );

const invalidPatch: fc.Arbitrary<Patch> = fc.oneof(
  // A bad value for a known leaf.
  fc.constantFrom(...Object.keys(LEAVES)).chain((path) =>
    LEAVES[path]!.map((bad) => {
      const [section, field] = path.split('.') as [string, string];
      return { [section]: { [field]: bad } };
    }),
  ),
  // Smuggling the exclusion list through update(), even a valid one.
  fc.array(pattern, { maxLength: 3 }).map((list) => ({ context: { excludedFolders: list } })),
  // Unknown keys and sections.
  fc.constantFrom<Patch>({ review: { autoApply: true } }, { tools: { shell: true } }),
  fc.constant({ version: { x: 2 } }),
);

const lines = fc.array(
  fc.oneof(
    pattern,
    fc.constantFrom('', '   ', ' Private/** ', 'Journal', 'Journal', '\tTabbed\t', 'x'.repeat(1025), 'a\nb'),
  ),
  { maxLength: 6 },
);

const commands = fc.commands(
  [
    validPatch.map((p) => new UpdateCommand(p, true)),
    invalidPatch.map((p) => new UpdateCommand(p, false)),
    lines.map((l) => new SetExcludedCommand(l)),
    fc.constant(new SaveReloadCommand()),
  ],
  { maxCommands: 40, size: 'large' },
);

const initial: fc.Arbitrary<{ raw: unknown; model: Model }> = fc.oneof(
  validSettings.map((s) => ({ raw: clone(s), model: { settings: clone(s), intact: true } })),
  fc.tuple(validSettings, badExclusionValue).map(([s, bad]) => {
    const raw = clone(s) as unknown;
    setPath(raw, 'context.excludedFolders', bad);
    const expected = clone(s);
    expected.context.excludedFolders = [...EXCLUDE_EVERYTHING];
    return { raw, model: { settings: expected, intact: false } };
  }),
  fc.constant({ raw: null, model: { settings: clone(DEFAULT_SETTINGS), intact: true } }),
);

describe('SettingsStore stateful model (INVARIANTS.md S5)', () => {
  it('S5: only an explicit edit can restore exclusions; update can never touch them', () => {
    fc.assert(
      fc.property(initial, commands, ({ raw, model }, cmds) => {
        const stored = disk(raw);
        // A bad value that JSON turns into a valid list (vanishingly rare) is not this test's concern.
        const start = SettingsStore.load(stored);
        fc.pre(start.exclusionsIntact === model.intact);
        fc.modelRun(() => ({ model: clone(model), real: { store: start } }), cmds);
      }),
    );
  });
});
