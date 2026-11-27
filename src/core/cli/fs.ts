// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CLI bridges' only file-system access (INVARIANTS.md L3): a fresh run
 * folder under the system temp directory for every run, with an empty `void/`
 * for the CLI to work in, a few fixed files beside it, and removal afterwards.
 * It never reads a file's contents, and it refuses any path it didn't create.
 * This is the only module that imports `fs`, `os` or `path`.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';

export const RUN_PREFIX = 'lektor-';
/** The only files written, beside `void/` (and the self-test's canaries inside it), plus context images (`image-<hash>.ext`). */
export const RUN_FILES = ['mcp.json', 'system.txt', 'canary.txt', 'models.json'] as const;
/** The self-test's canaries inside `void/`. */
export const VOID_CANARIES = ['canary.txt', 'AGENTS.md'] as const;
export type VoidCanary = (typeof VOID_CANARIES)[number];
/** Image types a context image may be written as, for a CLI that takes images as files. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const MAX_RUN_IMAGES = 20;
export type RunFile = (typeof RUN_FILES)[number];

export interface RunFolder {
  /** `<temp>/lektor-XXXXXX`, mode 0700. */
  readonly root: string;
  /** `<root>/void`: empty, the CLI's working folder. */
  readonly void: string;
}

export class RunFolderError extends Error {
  override name = 'RunFolderError';
}

const created = new Set<string>();

function owned(run: RunFolder): void {
  if (!created.has(run.root) || run.void !== join(run.root, 'void')) throw new RunFolderError('Not a run folder Lektor created.');
}

/** A fresh, private run folder with an empty `void/`. */
export async function createRun(): Promise<RunFolder> {
  const root = await mkdtemp(join(tmpdir(), RUN_PREFIX));
  created.add(root);
  const v = join(root, 'void');
  await mkdir(v, { mode: 0o700 });
  return { root, void: v };
}

/** Write one of the fixed files in the run folder (never over an existing one). */
export async function writeRunFile(run: RunFolder, name: RunFile, content: string): Promise<string> {
  owned(run);
  if (!(RUN_FILES as readonly string[]).includes(name)) throw new RunFolderError(`"${String(name)}" is not a run file.`);
  const path = join(run.root, name);
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  return path;
}

/** A self-test canary, inside `void/` (never in a working folder a chat runs in). */
export async function writeVoidCanary(run: RunFolder, content: string, name: VoidCanary = 'canary.txt'): Promise<string> {
  owned(run);
  if (!(VOID_CANARIES as readonly string[]).includes(name)) throw new RunFolderError(`"${String(name)}" is not a canary.`);
  const path = join(run.void, name);
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  return path;
}

/**
 * Write a context image beside `void/`, for a CLI that takes images as files. It is named by
 * its content, so the same image keeps the same path (the CLI puts the path in its prompt, and a
 * stable prompt start is what its cache matches on); writing one that is already there is a no-op.
 */
export async function writeRunImage(run: RunFolder, mime: string, base64: string): Promise<string> {
  owned(run);
  const ext = IMAGE_EXTENSIONS[mime];
  if (!ext) throw new RunFolderError(`Images of type ${mime.slice(0, 40)} can't be passed on.`);
  const bytes = Buffer.from(base64, 'base64');
  const path = join(run.root, `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`);
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err;
  }
  return path;
}

/** Inside the run folder, for a CLI's own state (it creates the folder itself; removed with the run). */
export function runPath(run: RunFolder, name: 'state' | 'log'): string {
  owned(run);
  return join(run.root, name);
}

/** Whether `void/` is empty (names only; nothing is read). */
export async function voidIsEmpty(run: RunFolder): Promise<boolean> {
  owned(run);
  return (await readdir(run.void)).length === 0;
}

/** Remove a run folder Lektor created. Anything else is refused. */
export async function removeRun(run: RunFolder): Promise<void> {
  owned(run);
  if (!run.root.startsWith(tmpdir() + sep + RUN_PREFIX)) throw new RunFolderError('Not under the temp directory.');
  await rm(run.root, { recursive: true, force: true });
  created.delete(run.root);
}

/** The first of these absolute paths that is an executable file, or null. */
export async function findExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const c of candidates) {
    if (!isAbsolute(c)) continue;
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      // not there, or not executable
    }
  }
  return null;
}

/** Where an installed `name` usually is: the PATH entries, then the common install places. */
export function executableCandidates(name: string, pathVar: string | undefined): string[] {
  const home = homedir();
  const fromPath = (pathVar ?? '').split(delimiter).filter((d) => d !== '' && isAbsolute(d)).map((d) => join(d, name));
  const common = [join(home, '.local', 'bin', name), join(home, '.claude', 'local', name), '/usr/local/bin/' + name, '/opt/homebrew/bin/' + name, '/usr/bin/' + name];
  return [...new Set([...fromPath, ...common])];
}
