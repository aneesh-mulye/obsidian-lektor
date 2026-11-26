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

export const SETTINGS_VERSION = 3;

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

/**
 * A user-entered server URL in canonical form: http(s), no credentials, query
 * or fragment, lower-cased host, no default port and no trailing slash.
 * Returns null if it cannot be one.
 */
export function normaliseBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, '');
}

const BaseUrl = z
  .string()
  .max(2048)
  .refine((s) => normaliseBaseUrl(s) === s, 'Must be an http(s) URL without credentials, query or trailing slash.');

// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;

export const ModelRefSchema = z.strictObject({
  provider: z.string().max(64).regex(/^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/),
  model: z.string().min(1).max(256).regex(NO_CONTROL),
});

const SECTIONS = {
  models: z.strictObject({
    ollama: z.strictObject({
      baseUrl: BaseUrl,
      /** Sent as num_ctx on every request, and the budget requests are checked against. */
      contextLength: z.int().min(2048).max(1048576),
    }),
    /** The model last picked in the sidebar; new chats start with it. */
    defaultModel: ModelRefSchema.nullable(),
  }),
  review: z.strictObject({
    defaultDisplayMode: z.enum(DISPLAY_MODES),
  }),
  context: z.strictObject({
    attachmentMode: z.enum(ATTACHMENT_MODES),
    excludedFolders: ExcludedFolders,
    maxLinkDepth: count(3),
    /** Also treat Obsidian's own "Excluded files" as excluded. */
    respectObsidianExclusions: z.boolean(),
  }),
  tools: z.strictObject({
    searchesPerMessage: Cap,
    fetchesPerMessage: Cap,
  }),
  privacy: z.strictObject({
    storeFullTranscripts: z.boolean(),
  }),
};

const SECTION_NAMES = Object.keys(SECTIONS);

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
  models: { ollama: { baseUrl: 'http://127.0.0.1:11434', contextLength: 32768 }, defaultModel: null },
  review: { defaultDisplayMode: 'sidebar' },
  context: { attachmentMode: 'ask', excludedFolders: [], maxLinkDepth: 3, respectObsidianExclusions: true },
  tools: { searchesPerMessage: 5, fetchesPerMessage: 5 },
  privacy: { storeFullTranscripts: false },
});

/**
 * Migrations from version n to n+1, keyed by n. Each takes the raw stored
 * object and returns the raw object for the next version; field-level salvage
 * runs after the last one (INVARIANTS.md S6).
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // 1 → 2: the models section (Ollama URL, last-picked model) was added.
  1: (raw) => ({
    ...raw,
    version: 2,
    ...(Object.hasOwn(raw, 'models') ? {} : { models: { ollama: { baseUrl: DEFAULT_SETTINGS.models.ollama.baseUrl }, defaultModel: null } }),
  }),
  // 2 → 3: the Ollama context length and the "respect Obsidian's excluded files" toggle were added.
  2: (raw) => {
    const out: Record<string, unknown> = { ...raw, version: 3 };
    if (Object.hasOwn(raw, 'models')) {
      out['models'] = mapField(raw['models'], 'ollama', (o) => addMissing(o, 'contextLength', DEFAULT_SETTINGS.models.ollama.contextLength));
    }
    if (Object.hasOwn(raw, 'context')) {
      out['context'] = addMissing(raw['context'], 'respectObsidianExclusions', DEFAULT_SETTINGS.context.respectObsidianExclusions);
    }
    return out;
  },
};

/** A copy of `obj` with `key` added, if obj is an object lacking it; otherwise obj unchanged (salvage reports anything wrong). */
function addMissing(obj: unknown, key: string, value: unknown): unknown {
  return isRecord(obj) && !Object.hasOwn(obj, key) ? { ...obj, [key]: value } : obj;
}

/** A copy of `obj` with `obj[key]` transformed, if obj is an object with that key; otherwise obj unchanged. */
function mapField(obj: unknown, key: string, fn: (v: unknown) => unknown): unknown {
  return isRecord(obj) && Object.hasOwn(obj, key) ? { ...obj, [key]: fn(obj[key]) } : obj;
}

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
  readonly models?: Partial<Settings['models']>;
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

    const salvage: Salvage = { problems, intact: false, unreadable: undefined };
    const { version: _version, ...shape } = SettingsSchema.shape;
    for (const key of Object.keys(data)) {
      if (key !== 'version' && !Object.hasOwn(shape, key)) problems.push({ path: key, message: 'Unknown setting; dropped.' });
    }
    const sections = salvageObject(shape, data, DEFAULT_SETTINGS, '', salvage, isRecord(raw));
    const settings = { version: SETTINGS_VERSION, ...sections } as Settings;
    const { intact } = salvage;
    let { unreadable } = salvage;

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
      if (!(SECTION_NAMES).includes(section) || !isRecord(fields)) {
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

const EXCLUSIONS_PATH = 'context.excludedFolders';

interface Salvage {
  problems: SettingsProblem[];
  /** Whether the stored exclusion list was read. */
  intact: boolean;
  /** JSON-safe copy of an unreadable stored exclusion list. */
  unreadable: unknown;
}

/**
 * Field-level salvage: keep every stored leaf that is valid, default the rest,
 * and report each problem by its dotted path (INVARIANTS.md S1, S3). Nested
 * objects are salvaged recursively; the exclusion list fails closed (S4).
 */
function salvageObject(
  shape: Record<string, z.ZodType>,
  stored: unknown,
  defaults: unknown,
  path: string,
  st: Salvage,
  report: boolean,
): Record<string, unknown> {
  const out = clone(defaults) as Record<string, unknown>;
  if (!isRecord(stored)) {
    if (report && path !== '') {
      st.problems.push({ path, message: stored === undefined ? 'Missing; defaults are in use.' : 'Not an object; defaults are in use.' });
    }
    return out;
  }
  if (path !== '') {
    for (const key of Object.keys(stored)) {
      if (!Object.hasOwn(shape, key)) st.problems.push({ path: `${path}.${key}`, message: 'Unknown setting; dropped.' });
    }
  }
  for (const [field, schema] of Object.entries(shape)) {
    const fieldPath = path === '' ? field : `${path}.${field}`;
    const value = own(stored, field);
    if (schema instanceof z.ZodObject) {
      out[field] = salvageObject(schema.shape, value, out[field], fieldPath, st, report);
      continue;
    }
    const parsed = schema.safeParse(value);
    const isExclusions = fieldPath === EXCLUSIONS_PATH;
    if (parsed.success) {
      out[field] = parsed.data;
      if (isExclusions) st.intact = true;
    } else {
      st.problems.push({
        path: fieldPath,
        message: isExclusions
          ? 'The excluded-folders list could not be read, so no notes will be shared until you set it again.'
          : `${value === undefined ? 'Missing' : 'Invalid value'}; the default is in use.`,
      });
      if (isExclusions) st.unreadable = jsonSafe(value);
    }
  }
  return out;
}

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
