// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The random vault shared by the context tests (INVARIANTS.md § Milestone 3). */

import fc from 'fast-check';
import type { RawNote, RawVault } from '../../src/core/context/vault';

export interface FakeNote {
  path: string;
  content: string;
  /** Resolved link targets (existing notes or attachments). */
  links: string[];
}

export interface VaultSpec {
  notes: FakeNote[];
  attachments: string[];
  patterns: string[];
  obsidianFilters: string[];
  respectObsidian: boolean;
}

export const sentinel = (i: number) => `SENTINEL${i}X`;
const enc = new TextEncoder();

export const FOLDERS = ['', 'Notes', 'Notes/Deep', 'Private', 'private/Sub', 'Work', 'Work/Clients', 'Archive', 'Journal', 'Templates', '.hidden', '.lektor/presets', '.obsidian'];
export const PATTERNS = ['Private', 'private/**', 'Work/Clients', '*.secret.md', 'Arch*', 'Journal/', '/Templates', 'Deep', 'NOTES/deep/**'];
export const OBSIDIAN_FILTERS = ['Templates/', 'Archive', '/^Journal\\//', '/secret/i'];

export const vaultSpec: fc.Arbitrary<VaultSpec> = fc
  .tuple(
    // Sized large: fast-check's default array size would give tiny vaults with almost no links.
    fc.array(fc.tuple(fc.constantFrom(...FOLDERS), fc.constantFrom('a', 'b', 'c', 'note', 'x.secret', 'Idea', 'idea2')), { minLength: 1, maxLength: 25, size: 'large' }),
    fc.subarray(PATTERNS),
    fc.subarray(OBSIDIAN_FILTERS),
    fc.boolean(),
    fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 60, size: 'large' }),
    fc.array(fc.string({ maxLength: 20 }), { minLength: 25, maxLength: 25 }),
  )
  .map(([entries, patterns, obsidianFilters, respectObsidian, edges, fillers]) => {
    const paths: string[] = [];
    entries.forEach(([folder, name], i) => {
      const path = `${folder ? `${folder}/` : ''}${name}${i}.md`;
      if (!paths.includes(path)) paths.push(path);
    });
    const attachments = ['attachments/image.png'];
    const links: string[][] = paths.map(() => []);
    for (const [from, to] of edges) {
      const src = from % paths.length;
      const targets = [...paths, ...attachments];
      const dst = targets[to % targets.length]!;
      if (!links[src]!.includes(dst)) links[src]!.push(dst); // self-links allowed
    }
    const notes = paths.map((path, i) => ({
      path,
      links: links[i]!,
      content: `---\ntags: [t${i}]\n---\n# ${path}\n${sentinel(i)}\n${fillers[i] ?? ''}\n${links[i]!.map((l) => `[[${l}]]`).join(' ')}\n`,
    }));
    return { notes, attachments, patterns, obsidianFilters, respectObsidian };
  });

/** An in-memory RawVault that records every read. */
export class FakeRawVault implements RawVault {
  readonly reads: string[] = [];
  constructor(public spec: VaultSpec) {}

  notes(): RawNote[] {
    return this.spec.notes.map((n) => ({ path: n.path, size: enc.encode(n.content).length }));
  }
  folders(): string[] {
    const set = new Set<string>();
    for (const n of this.spec.notes) {
      const parts = n.path.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort();
  }
  resolvedLinks(): Record<string, Record<string, number>> {
    return Object.fromEntries(this.spec.notes.map((n) => [n.path, Object.fromEntries(n.links.map((l) => [l, 1]))]));
  }
  read(path: string): Promise<string> {
    this.reads.push(path);
    const note = this.spec.notes.find((n) => n.path === path);
    return note ? Promise.resolve(note.content) : Promise.reject(new Error(`ENOENT ${path}`));
  }
}
