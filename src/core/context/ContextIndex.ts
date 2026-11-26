// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The filtered view of the vault that everything in the context system goes
 * through. Excluded notes do not exist here: they are missing from listings,
 * from link and backlink results (only counted, for the user), and `read`
 * refuses them, re-checking the exclusion rules at the moment of reading.
 * The link walk therefore can never pass *through* an excluded note.
 */

import type { Exclusions } from './exclusions';
import type { RawVault } from './vault';

export interface NoteMeta {
  path: string;
  /** File name without `.md`. */
  title: string;
  size: number;
}

/** Notes found next to something, and the excluded notes that were left out (never sent; counted for the user). */
export interface Neighbours {
  notes: string[];
  excluded: string[];
}

export class ContextAccessError extends Error {
  override name = 'ContextAccessError';
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const titleOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');

export class ContextIndex {
  #version = 0;
  #exclusions: Exclusions;
  #all = new Map<string, number>(); // every raw note → size
  #notes = new Map<string, NoteMeta>(); // allowed notes only
  #folders: string[] = [];
  #out = new Map<string, string[]>(); // raw note → raw note targets
  #in = new Map<string, string[]>(); // raw note → raw note sources

  constructor(
    private readonly raw: RawVault,
    private readonly exclusions: () => Exclusions,
  ) {
    this.#exclusions = exclusions();
  }

  /** Rebuild from the raw vault and the current exclusion rules. */
  refresh(): void {
    this.#exclusions = this.exclusions();
    const ex = this.#exclusions;
    this.#all = new Map(this.raw.notes().map((n) => [n.path, n.size]));
    this.#notes = new Map();
    for (const [path, size] of this.#all) {
      if (!ex.isExcluded(path)) this.#notes.set(path, { path, title: titleOf(path), size });
    }
    this.#folders = this.raw.folders().filter((f) => !ex.isExcluded(f));
    this.#out = new Map();
    this.#in = new Map();
    for (const [source, targets] of Object.entries(this.raw.resolvedLinks())) {
      if (!this.#all.has(source)) continue;
      const out = Object.keys(targets).filter((t) => this.#all.has(t)).sort();
      this.#out.set(source, out);
      for (const t of out) {
        const list = this.#in.get(t) ?? [];
        list.push(source);
        this.#in.set(t, list);
      }
    }
    for (const list of this.#in.values()) list.sort();
    this.#version += 1;
  }

  /** Bumped on every refresh, so callers can memoise. */
  get version(): number {
    return this.#version;
  }

  /** Why everything is excluded, if an exclusion rule could not be understood. */
  get problem(): string | null {
    return this.#exclusions.problem;
  }

  isExcluded(path: string): boolean {
    return this.#exclusions.isExcluded(path);
  }

  note(path: string): NoteMeta | null {
    return this.#notes.get(path) ?? null;
  }

  notes(): NoteMeta[] {
    return [...this.#notes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  folders(): string[] {
    return [...this.#folders];
  }

  hasFolder(folder: string): boolean {
    return this.#folders.includes(folder);
  }

  inFolder(folder: string, recursive: boolean): Neighbours {
    const notes: string[] = [];
    const excluded: string[] = [];
    for (const path of [...this.#all.keys()].sort()) {
      const inside = recursive ? path.startsWith(`${folder}/`) : parentOf(path) === folder;
      if (!inside) continue;
      (this.#notes.has(path) ? notes : excluded).push(path);
    }
    return { notes, excluded };
  }

  outgoing(path: string): Neighbours {
    return this.split(this.#notes.has(path) ? (this.#out.get(path) ?? []) : []);
  }

  backlinks(path: string): Neighbours {
    return this.split(this.#notes.has(path) ? (this.#in.get(path) ?? []) : []);
  }

  /** The note's text. Refuses anything excluded *now*, or not an allowed note at the last refresh. */
  async read(path: string): Promise<string> {
    if (!this.#notes.has(path) || this.exclusions().isExcluded(path)) {
      throw new ContextAccessError(`Lektor may not read ${path}.`);
    }
    return this.raw.read(path);
  }

  private split(paths: readonly string[]): Neighbours {
    const notes: string[] = [];
    const excluded: string[] = [];
    for (const p of paths) (this.#notes.has(p) ? notes : excluded).push(p);
    return { notes, excluded };
  }
}
