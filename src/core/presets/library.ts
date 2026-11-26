// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The preset library: the built-ins, plus preset files in the plugin folder
 * (`presets/<id>.md`, through Storage). A file whose id is a built-in's
 * overrides it. Every file is parsed on its own, so a broken one shows its
 * error and never affects another (INVARIANTS.md PR1).
 */

import type { Storage } from '../storage';
import { BUILTIN_PRESETS } from './builtins';
import { type Preset, parsePreset, serializePreset } from './preset';

/** `builtin`: from code. `edited`: a file overriding a built-in. `file`: the user's own. */
export type PresetSource = 'builtin' | 'edited' | 'file';

export interface PresetEntry {
  readonly id: string;
  readonly source: PresetSource;
  /** Null when its file is broken. */
  readonly preset: Preset | null;
  readonly error?: string;
  /** Built-ins only: hidden from the sidebar, the slash commands and the command palette. */
  readonly hidden: boolean;
}

/** The library from file texts by id (null: the file could not be read). Pure. */
export function buildLibrary(files: ReadonlyMap<string, string | null>, hidden: ReadonlySet<string>): PresetEntry[] {
  const fromFile = (id: string, text: string | null) => (text === null ? ({ ok: false, error: 'The file could not be read.' } as const) : parsePreset(id, text));
  const builtins = BUILTIN_PRESETS.map((b): PresetEntry => {
    const text = files.get(b.id);
    if (text === undefined) return { id: b.id, source: 'builtin', preset: b, hidden: hidden.has(b.id) };
    const r = fromFile(b.id, text);
    return r.ok ? { id: b.id, source: 'edited', preset: r.preset, hidden: hidden.has(b.id) } : { id: b.id, source: 'edited', preset: null, error: r.error, hidden: hidden.has(b.id) };
  });
  const builtinIds = new Set(BUILTIN_PRESETS.map((b) => b.id));
  const own = [...files]
    .filter(([id]) => !builtinIds.has(id))
    .map(([id, text]): PresetEntry => {
      const r = fromFile(id, text);
      return r.ok ? { id, source: 'file', preset: r.preset, hidden: false } : { id, source: 'file', preset: null, error: r.error, hidden: false };
    })
    .sort((a, b) => (a.preset?.name ?? a.id).localeCompare(b.preset?.name ?? b.id) || a.id.localeCompare(b.id));
  return [...builtins, ...own];
}

export class PresetLibrary {
  #entries: PresetEntry[] = buildLibrary(new Map(), new Set());
  #files = new Map<string, string | null>();
  #version = 0;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly storage: Storage,
    /** Ids of hidden built-ins (Settings → Presets). */
    private readonly hidden: () => readonly string[],
  ) {}

  readonly subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  readonly version = (): number => this.#version;

  /** Read every preset file again. */
  async load(): Promise<void> {
    const files = new Map<string, string | null>();
    let ids: string[] = [];
    try {
      ids = await this.storage.list('presets');
    } catch {
      // No folder yet, or it can't be listed: only the built-ins.
    }
    for (const id of ids) files.set(id, await this.storage.read('presets', id).catch(() => null));
    this.#files = files;
    this.refresh();
  }

  /** Rebuild from the files already read (e.g. after hiding a built-in). */
  refresh(): void {
    this.#entries = buildLibrary(this.#files, new Set(this.hidden()));
    this.#version += 1;
    for (const l of this.#listeners) l();
  }

  entries(): readonly PresetEntry[] {
    return this.#entries;
  }

  /** The presets that can run: not hidden, and not broken. */
  runnable(): Preset[] {
    return this.#entries.flatMap((e) => (e.preset && !e.hidden ? [e.preset] : []));
  }

  get(id: string): Preset | null {
    const e = this.#entries.find((x) => x.id === id);
    return e?.preset && !e.hidden ? e.preset : null;
  }

  /** Save a preset as its file (for a built-in, that makes it an edited one). */
  async save(p: Preset): Promise<void> {
    const text = serializePreset(p);
    await this.storage.write('presets', p.id, text);
    this.#files.set(p.id, text);
    this.refresh();
  }

  /** Delete a preset's file: removes a user preset, or resets an edited built-in. */
  async remove(id: string): Promise<void> {
    await this.storage.remove('presets', id);
    this.#files.delete(id);
    this.refresh();
  }
}
