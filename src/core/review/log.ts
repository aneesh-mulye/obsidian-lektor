// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The AI edit log (DESIGN.md § AI undo history; INVARIANTS.md W5): every
 * accepted hunk, created note and revert, appended per note to
 * `history/<note-id>.jsonl` and never rewritten. A small index in
 * `meta/edit-log-index.json` maps note ids to current paths, so a note keeps
 * its history when renamed. Cleared only on request. Undo and redo in the
 * editor are logged too, as a revert and a new accept (INVARIANTS.md B6).
 */

import { z } from 'zod';
import type { ModelRef } from '../providers/types';
import { ModelRefSchema } from '../settings';
import type { Storage } from '../storage';

export interface LogEntry {
  readonly v: 1;
  readonly id: string;
  readonly kind: 'hunk' | 'create' | 'revert';
  /** The note's path when this happened. */
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** Text just around the change, to find it again for a revert. */
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly at: number;
  readonly chatId?: string;
  readonly model?: ModelRef;
  readonly proposalId?: string;
  readonly hunkId?: string;
  /** For a revert: the entry it undid. */
  readonly revertOf?: string;
  /** Not a click in Lektor: the note's own undo took the change out, or redo put it back. */
  readonly via?: 'undo' | 'redo';
}

const Entry = z.strictObject({
  v: z.literal(1),
  id: z.string(),
  kind: z.enum(['hunk', 'create', 'revert']),
  path: z.string(),
  before: z.string(),
  after: z.string(),
  contextBefore: z.string(),
  contextAfter: z.string(),
  at: z.number(),
  chatId: z.string().optional(),
  model: ModelRefSchema.optional(),
  proposalId: z.string().optional(),
  hunkId: z.string().optional(),
  revertOf: z.string().optional(),
  via: z.enum(['undo', 'redo']).optional(),
});

const Index = z.strictObject({ version: z.literal(1), notes: z.record(z.string(), z.string()) });
const INDEX_KEY = 'edit-log-index';

export type NewEntry = Omit<LogEntry, 'v' | 'id' | 'path'>;

export class EditLog {
  #index: Record<string, string> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: Storage,
    private readonly newId: () => string,
  ) {}

  /** Run one change at a time, so the index and the logs never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  private async index(): Promise<Record<string, string>> {
    if (this.#index) return this.#index;
    const text = await this.storage.read('meta', INDEX_KEY);
    let notes: Record<string, string> = {};
    if (text !== null) {
      try {
        const parsed = Index.safeParse(JSON.parse(text));
        if (parsed.success) notes = parsed.data.notes;
      } catch {
        // an unreadable index loses the path mapping, never the logs themselves
      }
    }
    this.#index = notes;
    return notes;
  }

  private async saveIndex(): Promise<void> {
    await this.storage.write('meta', INDEX_KEY, JSON.stringify({ version: 1, notes: this.#index ?? {} }));
  }

  private async idOf(path: string): Promise<string | undefined> {
    const index = await this.index();
    return Object.keys(index).find((id) => index[id] === path);
  }

  append(path: string, entry: NewEntry): Promise<LogEntry> {
    return this.serial(async () => {
      let id = await this.idOf(path);
      if (id === undefined) {
        id = this.newId();
        (await this.index())[id] = path;
        await this.saveIndex();
      }
      const full: LogEntry = { v: 1, id: this.newId(), path, ...entry };
      await this.storage.append('history', id, `${JSON.stringify(full)}\n`);
      return full;
    });
  }

  /** The note's log, oldest first. Unreadable lines are skipped. */
  async entries(path: string): Promise<LogEntry[]> {
    const id = await this.idOf(path);
    if (id === undefined) return [];
    const text = (await this.storage.read('history', id)) ?? '';
    const out: LogEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = Entry.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data as LogEntry);
      } catch {
        // skip
      }
    }
    return out;
  }

  async hasHistory(path: string): Promise<boolean> {
    return (await this.idOf(path)) !== undefined;
  }

  /** A note or folder was renamed: its history follows it. */
  renamed(from: string, to: string): Promise<void> {
    return this.serial(async () => {
      const index = await this.index();
      let changed = false;
      for (const [id, p] of Object.entries(index)) {
        const next = p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
        if (next !== p) {
          index[id] = next;
          changed = true;
        }
      }
      if (changed) await this.saveIndex();
    });
  }

  /** Delete one note's history (an explicit user request). */
  clear(path: string): Promise<void> {
    return this.serial(async () => {
      const id = await this.idOf(path);
      if (id === undefined) return;
      await this.storage.remove('history', id);
      delete (await this.index())[id];
      await this.saveIndex();
    });
  }

  /** Delete all AI edit history (an explicit user request). */
  clearAll(): Promise<void> {
    return this.serial(async () => {
      for (const id of await this.storage.list('history')) await this.storage.remove('history', id);
      this.#index = {};
      await this.saveIndex();
    });
  }
}
