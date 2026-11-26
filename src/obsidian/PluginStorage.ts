// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Lektor's own data (chats, the AI edit log) under the plugin folder.
 *
 * This file is lint-gated (eslint/gates.mjs, INVARIANTS.md G6): the adapter may
 * only be used as `this.app.vault.adapter.<read|write|append|remove|exists|list|mkdir>`
 * with a path from `resolveStoragePath` / `resolveStorageDir` as the first
 * argument, so it cannot name a note. It never sees the vault's notes, and
 * nothing it stores is sent to a model by this module.
 */

import type { App } from 'obsidian';
import {
  type Storage,
  type StorageNamespace,
  assertStorageRoot,
  keyFromStoragePath,
  resolveStorageDir,
  resolveStoragePath,
} from '../core/storage';

export class PluginStorage implements Storage {
  readonly #root: string;

  /** `pluginDir` is the plugin manifest's `dir`. Throws StorageError unless it is inside the config folder. */
  constructor(
    private readonly app: App,
    pluginDir: string | undefined,
  ) {
    this.#root = assertStorageRoot(pluginDir);
  }

  async read(ns: StorageNamespace, key: string): Promise<string | null> {
    if (!(await this.app.vault.adapter.exists(resolveStoragePath(this.#root, ns, key)))) return null;
    return this.app.vault.adapter.read(resolveStoragePath(this.#root, ns, key));
  }

  async write(ns: StorageNamespace, key: string, data: string): Promise<void> {
    resolveStoragePath(this.#root, ns, key); // validate before touching anything
    await this.ensureDir(ns);
    await this.app.vault.adapter.write(resolveStoragePath(this.#root, ns, key), data);
  }

  async append(ns: StorageNamespace, key: string, data: string): Promise<void> {
    resolveStoragePath(this.#root, ns, key);
    await this.ensureDir(ns);
    await this.app.vault.adapter.append(resolveStoragePath(this.#root, ns, key), data);
  }

  async remove(ns: StorageNamespace, key: string): Promise<void> {
    if (await this.app.vault.adapter.exists(resolveStoragePath(this.#root, ns, key))) {
      await this.app.vault.adapter.remove(resolveStoragePath(this.#root, ns, key));
    }
  }

  async list(ns: StorageNamespace): Promise<string[]> {
    if (!(await this.app.vault.adapter.exists(resolveStorageDir(this.#root, ns)))) return [];
    const { files } = await this.app.vault.adapter.list(resolveStorageDir(this.#root, ns));
    return files
      .map((path) => keyFromStoragePath(this.#root, ns, path))
      .filter((key): key is string => key !== null)
      .sort();
  }

  private async ensureDir(ns: StorageNamespace): Promise<void> {
    if (!(await this.app.vault.adapter.exists(resolveStorageDir(this.#root, ns)))) {
      await this.app.vault.adapter.mkdir(resolveStorageDir(this.#root, ns));
    }
  }
}
