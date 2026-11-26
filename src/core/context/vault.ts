// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The raw vault the context system is built on. Implemented only by src/obsidian/ContextBroker.ts. */

export interface RawNote {
  /** Vault path, e.g. `Notes/Idea.md`. */
  path: string;
  /** Size in bytes (`TFile.stat.size`). */
  size: number;
}

/** Any other file in the vault (an attachment): images, text files, PDFs, … */
export type RawFile = RawNote;

export interface RawVault {
  /** Every Markdown note. */
  notes(): readonly RawNote[];
  /** Every file that is not a Markdown note. */
  files(): readonly RawFile[];
  /** Every folder path (no root). */
  folders(): readonly string[];
  /** Obsidian's `metadataCache.resolvedLinks`: source path → target path (note or attachment) → count. */
  resolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The note's text, frontmatter included. */
  read(path: string): Promise<string>;
  /** An attachment's bytes. */
  readBytes(path: string): Promise<Uint8Array>;
}
