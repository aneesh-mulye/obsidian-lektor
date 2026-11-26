// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The raw vault the context system is built on. Implemented only by src/obsidian/ContextBroker.ts. */

export interface RawNote {
  /** Vault path, e.g. `Notes/Idea.md`. */
  path: string;
  /** Size in bytes (`TFile.stat.size`). */
  size: number;
}

export interface RawVault {
  /** Every Markdown note. */
  notes(): readonly RawNote[];
  /** Every folder path (no root). */
  folders(): readonly string[];
  /** Obsidian's `metadataCache.resolvedLinks`: source path → target path → count. */
  resolvedLinks(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The note's text, frontmatter included. */
  read(path: string): Promise<string>;
}
