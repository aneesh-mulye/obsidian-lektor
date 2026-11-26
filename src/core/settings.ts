// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Plugin settings: schema, defaults, migrations and a store with field-level
 * salvage. See INVARIANTS.md S1–S5.
 *
 * Exclusions fail closed: if a stored exclusion list cannot be read, the
 * effective list is "exclude everything", the store reports
 * `exclusionsIntact: false`, and saving writes the unreadable value back as it
 * was. Only an explicit `setExcludedFolders` (a user edit) clears that state.
 */

import { z } from 'zod';

export const SETTINGS_VERSION = 1;

/** The effective exclusion list while the stored one is unreadable. */
export const EXCLUDE_EVERYTHING: readonly string[] = Object.freeze(['**']);

export const MAX_EXCLUDED_PATTERNS = 1000;
export const MAX_PATTERN_LENGTH = 1024;

export const DISPLAY_MODES = ['prose', 'sidebar', 'inline'] as const;
export const ATTACHMENT_MODES = ['ask', 'allowed', 'upfront'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
export type AttachmentMode = (typeof ATTACHMENT_MODES)[number];

// ---------------------------------------------------------------------------
// Schema

const Pattern = z
  .string()
  .min(1, 'Pattern is empty.')
  .max(MAX_PATTERN_LENGTH, `Pattern is longer than ${MAX_PATTERN_LENGTH} characters.`)
  .refine((s) => s.trim() === s && !/[\r\n]/.test(s), 'Pattern must be a single line without surrounding spaces.');

const ExcludedFolders = z.array(Pattern).max(MAX_EXCLUDED_PATTERNS, `More than ${MAX_EXCLUDED_PATTERNS} patterns.`);

/** A non-negative integer; `-0` (which JSON.parse can produce) is normalised to `0` so settings stay canonical. */
const count = (max: number) =>
  z
    .int()
    .min(0)
    .max(max)
    .transform((n) => n + 0);

const Cap = count(50);

const SECTIONS = {
  review: z.strictObject({
    defaultDisplayMode: z.enum(DISPLAY_MODES),
  }),
  context: z.strictObject({
    attachmentMode: z.enum(ATTACHMENT_MODES),
    excludedFolders: ExcludedFolders,
    maxLinkDepth: count(3),
  }),
  tools: z.strictObject({
    searchesPerMessage: Cap,
    fetchesPerMessage: Cap,
  }),
  privacy: z.strictObject({
    storeFullTranscripts: z.boolean(),
  }),
};

type SectionName = keyof typeof SECTIONS;
const SECTION_NAMES = Object.keys(SECTIONS) as SectionName[];

export const SettingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  ...SECTIONS,
});

export type Settings = z.infer<typeof SettingsSchema>;

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Settings as handed out by the store: frozen at runtime, read-only in the type. */
export type ReadonlySettings = DeepReadonly<Settings>;

export const DEFAULT_SETTINGS: Settings = deepFreeze({
  version: SETTINGS_VERSION,
  review: { defaultDisplayMode: 'sidebar' },
  context: { attachmentMode: 'ask', excludedFolders: [], maxLinkDepth: 3 },
  tools: { searchesPerMessage: 5, fetchesPerMessage: 5 },
  privacy: { storeFullTranscripts: false },
});

/**
 * Migrations from version n to n+1, keyed by n. Each takes the raw stored
 * object and returns the raw object for the next version; field-level salvage
 * runs after the last one. There are none yet: version 1 is the first.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

// ---------------------------------------------------------------------------
// Store

export interface SettingsProblem {
  /** Dotted path of the field, or '' for the whole file. */
  readonly path: string;
  readonly message: string;
}

export type SettingsResult = { ok: true } | { ok: false; problems: SettingsProblem[] };

/** A change to any setting except the exclusion list (use `setExcludedFolders`). */
export interface SettingsPatch {
  readonly review?: Partial<Settings['review']>;
  readonly context?: Partial<Omit<Settings['context'], 'excludedFolders'>>;
  readonly tools?: Partial<Settings['tools']>;
  readonly privacy?: Partial<Settings['privacy']>;
}

export class SettingsStore {
  #settings: Settings;
  #intact: boolean;
  /** JSON-safe copy of the unreadable stored exclusion value, written back on save. */
  #unreadableExclusions: unknown;

  private constructor(
    settings: Settings,
    intact: boolean,
    unreadable: unknown,
    readonly problems: readonly SettingsProblem[],
  ) {
    this.#settings = deepFreeze(settings);
    this.#intact = intact;
    this.#unreadableExclusions = unreadable;
  }

  /** Load whatever `loadData()` returned. Never throws. */
  static load(raw: unknown): SettingsStore {
    if (raw === null || raw === undefined) {
      return new SettingsStore(clone(DEFAULT_SETTINGS), true, undefined, []);
    }

    const problems: SettingsProblem[] = [];
    let data: Record<string, unknown>;
    if (isRecord(raw)) {
      data = raw;
    } else {
      problems.push({ path: '', message: 'The settings file is not an object; defaults are in use.' });
      data = {};
    }

    data = migrate(data, problems);

    for (const key of Object.keys(data)) {
      if (key !== 'version' && !(SECTION_NAMES as string[]).includes(key)) {
        problems.push({ path: key, message: 'Unknown setting; dropped.' });
      }
    }

    const settings = clone(DEFAULT_SETTINGS) as Record<string, unknown> & Settings;
    let intact = false;
    let unreadable: unknown = undefined;

    for (const section of SECTION_NAMES) {
      const shape = SECTIONS[section].shape as Record<string, z.ZodType>;
      const stored = own(data, section);
      const out = settings[section] as Record<string, unknown>;

      if (!isRecord(stored)) {
        if (isRecord(raw)) {
          problems.push({
            path: section,
            message: stored === undefined ? 'Section missing; defaults are in use.' : 'Section is not an object; defaults are in use.',
          });
        }
        // No list to write back; on reload the missing list is unreadable again, so this stays closed.
        if (section === 'context') unreadable = undefined;
        continue;
      }

      for (const key of Object.keys(stored)) {
        if (!(key in shape)) problems.push({ path: `${section}.${key}`, message: 'Unknown setting; dropped.' });
      }

      for (const [field, schema] of Object.entries(shape)) {
        const value = own(stored, field);
        const parsed = schema.safeParse(value);
        const isExclusions = section === 'context' && field === 'excludedFolders';
        if (parsed.success) {
          out[field] = parsed.data;
          if (isExclusions) intact = true;
        } else {
          problems.push({
            path: `${section}.${field}`,
            message: isExclusions
              ? 'The excluded-folders list could not be read, so no notes will be shared until you set it again.'
              : `${value === undefined ? 'Missing' : 'Invalid value'}; the default is in use.`,
          });
          if (isExclusions) unreadable = jsonSafe(value);
        }
      }
    }

    if (!intact) {
      settings.context.excludedFolders = [...EXCLUDE_EVERYTHING];
      // Never let the written-back value become readable by accident (S5).
      if (ExcludedFolders.safeParse(unreadable).success) unreadable = { unreadable };
    }

    return new SettingsStore(settings, intact, intact ? undefined : unreadable, Object.freeze(problems));
  }

  /** The current settings. Deeply frozen; change them with `update` or `setExcludedFolders`. */
  get settings(): ReadonlySettings {
    return this.#settings;
  }

  /** False while the stored exclusion list is unreadable; the effective list is then `['**']`. */
  get exclusionsIntact(): boolean {
    return this.#intact;
  }

  /** Apply a patch if the result is valid; otherwise change nothing. Never touches exclusions. */
  update(patch: SettingsPatch): SettingsResult {
    const problems: SettingsProblem[] = [];
    if (!isRecord(patch)) return { ok: false, problems: [{ path: '', message: 'Patch is not an object.' }] };

    const next = clone(this.#settings) as unknown as Record<string, Record<string, unknown>>;
    for (const [section, fields] of Object.entries(patch)) {
      if (!(SECTION_NAMES as string[]).includes(section) || !isRecord(fields)) {
        problems.push({ path: section, message: 'Unknown or invalid section.' });
        continue;
      }
      if (section === 'context' && Object.hasOwn(fields, 'excludedFolders')) {
        problems.push({ path: 'context.excludedFolders', message: 'Use setExcludedFolders to change exclusions.' });
        continue;
      }
      Object.assign(next[section]!, fields);
    }
    if (problems.length > 0) return { ok: false, problems };

    const parsed = SettingsSchema.safeParse(next);
    if (!parsed.success) {
      return {
        ok: false,
        problems: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    this.#settings = deepFreeze(parsed.data);
    return { ok: true };
  }

  /**
   * Replace the exclusion list (a user edit). Lines are trimmed; blank lines
   * and duplicates are dropped. This is the only way to restore exclusions
   * after they were unreadable.
   */
  setExcludedFolders(lines: readonly string[]): SettingsResult {
    if (lines.some((l) => typeof l !== 'string' || /[\r\n]/.test(l))) {
      return { ok: false, problems: [{ path: 'context.excludedFolders', message: 'Each pattern must be a single line.' }] };
    }
    const normalised = [...new Set(lines.map((l) => l.trim()).filter((l) => l !== ''))];
    const parsed = ExcludedFolders.safeParse(normalised);
    if (!parsed.success) {
      return {
        ok: false,
        problems: parsed.error.issues.map((i) => ({ path: ['context', 'excludedFolders', ...i.path].join('.'), message: i.message })),
      };
    }
    const next = clone(this.#settings);
    next.context.excludedFolders = parsed.data;
    this.#settings = deepFreeze(next);
    this.#intact = true;
    this.#unreadableExclusions = undefined;
    return { ok: true };
  }

  /** What to pass to `saveData()`. Keeps an unreadable exclusion list as it was. */
  toData(): unknown {
    const data = clone(this.#settings) as unknown as { context: Record<string, unknown> };
    if (!this.#intact) data.context.excludedFolders = clone(this.#unreadableExclusions);
    return data;
  }
}

// ---------------------------------------------------------------------------
// Helpers

function migrate(data: Record<string, unknown>, problems: SettingsProblem[]): Record<string, unknown> {
  let version = own(data, 'version');
  while (typeof version === 'number' && Number.isInteger(version) && version < SETTINGS_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    data = step(data);
    version += 1;
  }
  if (version !== SETTINGS_VERSION) {
    const message =
      typeof version === 'number' && version > SETTINGS_VERSION
        ? 'Settings were saved by a newer version of Lektor; settings it does not know were dropped.'
        : 'Settings version missing or unknown; readable settings were kept.';
    problems.push({ path: 'version', message });
  }
  return data;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(obj: unknown, key: string): unknown {
  return isRecord(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function jsonSafe(v: unknown): unknown {
  try {
    const text = JSON.stringify(v);
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}
