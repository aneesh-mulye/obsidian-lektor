// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Lektor's own data (chat history, the AI edit log, presets) lives under the plugin
 * folder, `<config dir>/plugins/<folder>/<namespace>/<key><ext>`. These pure
 * functions are the only way to build such a path; src/obsidian/PluginStorage.ts
 * is lint-gated to pass every adapter call a path from them (INVARIANTS.md G6,
 * P1–P3). Nothing here can name a note.
 */

export const STORAGE_NAMESPACES = {
  chats: '.json',
  history: '.jsonl',
  /** Small bookkeeping files, e.g. the AI edit log's note-id index. */
  meta: '.json',
  /** User presets and edited built-ins (DESIGN.md § Presets): Markdown with frontmatter. */
  presets: '.md',
} as const;

export type StorageNamespace = keyof typeof STORAGE_NAMESPACES;

/**
 * Keys are lowercase so that two keys never share a file on case-insensitive
 * file systems; Windows device names are refused outright.
 */
const KEY = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const BAD_SEGMENT_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

export class StorageError extends Error {
  override name = 'StorageError';
}

/** Lektor's storage, by namespace and key. Implemented by src/obsidian/PluginStorage.ts. */
export interface Storage {
  /** The stored text, or null if there is none. */
  read(ns: StorageNamespace, key: string): Promise<string | null>;
  write(ns: StorageNamespace, key: string, data: string): Promise<void>;
  append(ns: StorageNamespace, key: string, data: string): Promise<void>;
  remove(ns: StorageNamespace, key: string): Promise<void>;
  /** Keys present in a namespace, sorted. Files that are not valid keys are ignored. */
  list(ns: StorageNamespace): Promise<string[]>;
}

export function isStorageKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key) && !RESERVED.test(key);
}

function isNamespace(ns: unknown): ns is StorageNamespace {
  return typeof ns === 'string' && Object.hasOwn(STORAGE_NAMESPACES, ns);
}

function segmentOk(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 255 &&
    s !== '.' &&
    s !== '..' &&
    !BAD_SEGMENT_CHARS.test(s) &&
    s.trim() === s &&
    !s.endsWith('.')
  );
}

/**
 * The plugin folder must be a normalised vault path of the form
 * `.<config>/plugins/<folder>`: inside the hidden config folder, never among notes.
 */
export function assertStorageRoot(root: unknown): string {
  if (typeof root !== 'string') throw new StorageError('Plugin folder is unknown.');
  const parts = root.split('/');
  if (parts.length !== 3 || !parts.every(segmentOk) || !parts[0]!.startsWith('.') || parts[1] !== 'plugins') {
    throw new StorageError(`Not a plugin folder inside the config folder: ${JSON.stringify(root)}`);
  }
  return root;
}

export function resolveStorageDir(root: string, ns: StorageNamespace): string {
  assertStorageRoot(root);
  if (!isNamespace(ns)) throw new StorageError(`Unknown storage namespace: ${JSON.stringify(ns)}`);
  return `${root}/${ns}`;
}

export function resolveStoragePath(root: string, ns: StorageNamespace, key: string): string {
  const dir = resolveStorageDir(root, ns);
  if (!isStorageKey(key)) throw new StorageError(`Invalid storage key: ${JSON.stringify(key)}`);
  return `${dir}/${key}${STORAGE_NAMESPACES[ns]}`;
}

/** The key a path stands for, or null if it is not exactly a resolved path in this namespace. */
export function keyFromStoragePath(root: string, ns: StorageNamespace, path: string): string | null {
  const prefix = `${resolveStorageDir(root, ns)}/`;
  const ext = STORAGE_NAMESPACES[ns];
  if (!path.startsWith(prefix) || !path.endsWith(ext)) return null;
  const key = path.slice(prefix.length, path.length - ext.length);
  return isStorageKey(key) ? key : null;
}
