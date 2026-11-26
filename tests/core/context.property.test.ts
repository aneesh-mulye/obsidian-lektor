// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md X2–X4: context containment, backlink lists, and the link-depth preview. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assembleContext } from '../../src/core/context/assemble';
import { ContextIndex } from '../../src/core/context/ContextIndex';
import { compileExclusions } from '../../src/core/context/exclusions';
import { BACKLINK_LIST_CAP, previewDepths } from '../../src/core/context/plan';
import { renderContext } from '../../src/core/context/render';
import {
  type ContextState,
  type Depth,
  EMPTY_CONTEXT,
  type NoteChip,
  addFolder,
  addNote,
  addSelection,
  pinChip,
  removeChip,
  renamePath,
  revalidate,
  setActive,
  setBacklinkContents,
  setDepth,
  setFollow,
  setRecursive,
} from '../../src/core/context/state';
import { estimateTokens } from '../../src/core/context/tokens';
import { FOLDERS, FakeRawVault, OBSIDIAN_FILTERS, PATTERNS, type VaultSpec, vaultSpec } from './vault.fixtures';

const exclusionsFor = (spec: VaultSpec) =>
  compileExclusions({ patterns: spec.patterns, obsidianFilters: spec.respectObsidian ? spec.obsidianFilters : null, configDir: '.obsidian' });

// ---------------------------------------------------------------------------
// The independent model of what a context state sends.

interface Expected {
  content: Set<string>;
  excluded: Set<string>;
  selections: Set<string>;
}

function expectedFor(spec: VaultSpec, state: ContextState): Expected {
  const ex = exclusionsFor(spec);
  const notes = new Set(spec.notes.map((n) => n.path));
  const valid = (p: string) => notes.has(p) && !ex.isExcluded(p);
  const out = (p: string) => (spec.notes.find((n) => n.path === p)?.links ?? []).filter((t) => notes.has(t));
  const back = (p: string) => spec.notes.filter((n) => n.links.includes(p)).map((n) => n.path);
  const content = new Set<string>();
  const excluded = new Set<string>();
  const selections = new Set<string>();
  const take = (p: string) => (ex.isExcluded(p) ? excluded.add(p) : content.add(p));

  for (const chip of state.chips) {
    if (chip.kind === 'note') {
      if (!valid(chip.path)) continue;
      const seen = new Set([chip.path]);
      let frontier = [chip.path];
      for (let level = 0; level < chip.depth; level++) {
        const next: string[] = [];
        for (const n of frontier) {
          for (const t of out(n)) {
            if (ex.isExcluded(t)) excluded.add(t);
            else if (!seen.has(t)) {
              seen.add(t);
              next.push(t);
            }
          }
        }
        frontier = next;
      }
      for (const n of seen) content.add(n);
      if (chip.backlinkContents) for (const n of seen) for (const b of back(n)) take(b);
    } else if (chip.kind === 'folder') {
      if (!notes.has(chip.path) && !spec.notes.some((n) => n.path.startsWith(`${chip.path}/`))) continue;
      if (ex.isExcluded(chip.path)) continue;
      for (const n of spec.notes) {
        const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
        if (parent === chip.path || (chip.recursive && n.path.startsWith(`${chip.path}/`))) take(n.path);
      }
    } else if (chip.kind === 'selection' && chip.text !== undefined && valid(chip.path)) {
      selections.add(chip.id);
    }
  }
  // Every note in context lists its backlinks; excluded backlinkers are counted, not listed.
  for (const n of content) for (const b of back(n)) if (ex.isExcluded(b)) excluded.add(b);
  return { content, excluded, selections };
}

// ---------------------------------------------------------------------------
// Stateful run

interface Real {
  spec: VaultSpec;
  raw: FakeRawVault;
  index: ContextIndex;
  state: ContextState;
  active: string | null;
  n: number;
  selectionText: Map<string, string>;
}

const newId = (r: Real) => () => `c${++r.n}`;

async function checkAll(r: Real): Promise<void> {
  const ex = exclusionsFor(r.spec);
  r.raw.reads.length = 0;
  const assembled = await assembleContext(r.state, r.index);
  const text = renderContext(assembled) ?? '';
  const expected = expectedFor(r.spec, r.state);

  // X2: a note's text is in the request if and only if the model says so.
  for (const note of r.spec.notes) {
    // Each note's own token (positions shift when notes are deleted).
    const token = /SENTINEL\d+X/.exec(note.content)![0];
    expect(text.includes(token), `${note.path} ${expected.content.has(note.path) ? 'missing' : 'leaked'}`).toBe(expected.content.has(note.path));
  }
  // X2: no excluded note is even read.
  for (const p of r.raw.reads) expect(ex.isExcluded(p), `read excluded ${p}`).toBe(false);
  // X2: selections only while their source is allowed.
  for (const [id, sel] of r.selectionText) expect(text.includes(sel), `selection ${id}`).toBe(expected.selections.has(id));
  // X2: the count shown to the user.
  expect(assembled.excluded).toBe(expected.excluded.size);

  // Chip-state invariants.
  const current = r.state.chips.filter((c) => c.kind === 'note' && c.current);
  expect(current.length).toBeLessThanOrEqual(1);
  const notePaths = r.state.chips.filter((c): c is NoteChip => c.kind === 'note').map((c) => c.path);
  expect(new Set(notePaths).size).toBe(notePaths.length);
  for (const c of r.state.chips) if (c.kind === 'note') expect(r.index.note(c.path)).not.toBeNull();
  const activeOk = r.active !== null && r.index.note(r.active) !== null;
  if (r.state.followActive && activeOk) expect(notePaths).toContain(r.active);
  if (!r.state.followActive || !activeOk) expect(current).toEqual([]);
}

type Cmd = fc.AsyncCommand<Real, Real>;
const cmd = (name: string, run: (r: Real) => void): Cmd => ({
  check: () => true,
  run: async (_m, r) => {
    run(r);
    // As the controller does after every change: keep following the active note.
    r.state = setActive(r.state, r.index, r.active, newId(r));
    await checkAll(r);
  },
  toString: () => name,
});

const pickChip = (r: Real, k: number) => r.state.chips[k % Math.max(1, r.state.chips.length)];
const pickNote = (r: Real, i: number) => r.spec.notes[i % Math.max(1, r.spec.notes.length)]?.path;

function vaultChanged(r: Real): void {
  r.index.refresh();
  r.state = revalidate(r.state, r.index).state;
  r.state = setActive(r.state, r.index, r.active, newId(r));
}

const commands = fc.commands(
  [
    fc.nat().map((i) => cmd(`addNote(${i})`, (r) => {
      const p = pickNote(r, i);
      if (p) r.state = addNote(r.state, r.index, p, newId(r)).state;
    })),
    fc.tuple(fc.constantFrom(...FOLDERS.filter(Boolean)), fc.boolean()).map(([f, rec]) => cmd(`addFolder(${f}, ${rec})`, (r) => {
      r.state = addFolder(r.state, r.index, f, rec, newId(r)).state;
    })),
    fc.nat().map((i) => cmd(`addSelection(${i})`, (r) => {
      const p = pickNote(r, i);
      if (!p) return;
      const before = r.state.chips.length;
      const text = `quoted SELSENT${r.n + 1}X`;
      r.state = addSelection(r.state, r.index, { path: p, text, from: 0, to: text.length, hash: 'h' }, newId(r)).state;
      if (r.state.chips.length > before) r.selectionText.set(r.state.chips.at(-1)!.id, text);
    })),
    fc.nat().map((k) => cmd(`remove(${k})`, (r) => {
      const c = pickChip(r, k);
      if (c) r.state = removeChip(r.state, c.id);
    })),
    fc.tuple(fc.nat(), fc.constantFrom<Depth>(0, 1, 2, 3)).map(([k, d]) => cmd(`depth(${k}, ${d})`, (r) => {
      const c = pickChip(r, k);
      if (c) r.state = setDepth(r.state, c.id, d);
    })),
    fc.tuple(fc.nat(), fc.boolean()).map(([k, b]) => cmd(`backlinks(${k}, ${b})`, (r) => {
      const c = pickChip(r, k);
      if (c) r.state = setBacklinkContents(r.state, c.id, b);
    })),
    fc.tuple(fc.nat(), fc.boolean()).map(([k, b]) => cmd(`recursive(${k}, ${b})`, (r) => {
      const c = pickChip(r, k);
      if (c) r.state = setRecursive(r.state, c.id, b);
    })),
    fc.nat().map((k) => cmd(`pin(${k})`, (r) => {
      const c = pickChip(r, k);
      if (c) r.state = pinChip(r.state, c.id);
    })),
    fc.boolean().map((b) => cmd(`follow(${b})`, (r) => {
      r.state = setFollow(r.state, r.index, b, r.active, newId(r));
    })),
    fc.option(fc.nat(), { nil: null }).map((i) => cmd(`active(${i})`, (r) => {
      r.active = i === null ? null : (pickNote(r, i) ?? null);
      r.state = setActive(r.state, r.index, r.active, newId(r));
    })),
    fc.constantFrom(...PATTERNS, '**').map((p) => cmd(`togglePattern(${p})`, (r) => {
      r.spec.patterns = r.spec.patterns.includes(p) ? r.spec.patterns.filter((x) => x !== p) : [...r.spec.patterns, p];
      vaultChanged(r);
    })),
    fc.constantFrom(...OBSIDIAN_FILTERS).map((f) => cmd(`toggleFilter(${f})`, (r) => {
      r.spec.obsidianFilters = r.spec.obsidianFilters.includes(f) ? r.spec.obsidianFilters.filter((x) => x !== f) : [...r.spec.obsidianFilters, f];
      vaultChanged(r);
    })),
    fc.constant(cmd('toggleRespectObsidian', (r) => {
      r.spec.respectObsidian = !r.spec.respectObsidian;
      vaultChanged(r);
    })),
    fc.nat().map((i) => cmd(`deleteNote(${i})`, (r) => {
      const p = pickNote(r, i);
      if (!p) return;
      r.spec.notes = r.spec.notes.filter((n) => n.path !== p);
      for (const n of r.spec.notes) n.links = n.links.filter((l) => l !== p);
      vaultChanged(r);
    })),
    fc.tuple(fc.nat(), fc.constantFrom(...FOLDERS)).map(([i, folder]) => cmd(`renameNote(${i} → ${folder})`, (r) => {
      const p = pickNote(r, i);
      if (!p) return;
      const name = p.slice(p.lastIndexOf('/') + 1);
      const to = `${folder ? `${folder}/` : ''}moved-${name}`;
      if (r.spec.notes.some((n) => n.path === to)) return;
      for (const n of r.spec.notes) {
        if (n.path === p) n.path = to;
        n.links = n.links.map((l) => (l === p ? to : l));
      }
      if (r.active === p) r.active = to;
      const followed = r.state.chips.filter((c) => c.kind !== 'folder' && c.path === p).map((c) => c.id);
      r.state = renamePath(r.state, p, to);
      vaultChanged(r);
      // Chips follow a renamed note (unless it moved somewhere excluded).
      if (r.index.note(to)) for (const id of followed) expect(r.state.chips.find((c) => c.id === id)?.path).toBe(to);
    })),
  ],
  { maxCommands: 40, size: 'large' },
);

function setup(spec: VaultSpec): Real {
  const copy: VaultSpec = structuredClone(spec);
  const raw = new FakeRawVault(copy);
  const index = new ContextIndex(raw, () => exclusionsFor(raw.spec));
  index.refresh();
  return { spec: copy, raw, index, state: EMPTY_CONTEXT, active: null, n: 0, selectionText: new Map() };
}

describe('context (INVARIANTS.md X2–X4)', () => {
  it('X2: the request contains a note if and only if the context includes it, and never an excluded one', async () => {
    await fc.assert(
      fc.asyncProperty(vaultSpec, commands, async (spec, cmds) => {
        const real = setup(spec);
        await fc.asyncModelRun(() => ({ model: real, real }), cmds);
      }),
    );
  });

  it('X3: backlink lists carry paths, never content, and are capped at 50 with an exact remainder', async () => {
    // A hub note with many backlinkers, plus a random vault around it.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 80 }), vaultSpec, async (k, spec) => {
        const backers = Array.from({ length: k }, (_, j) => ({ path: `Back/b${j}.md`, content: `BACKER${j}X`, links: ['Hub.md'] }));
        const s: VaultSpec = { ...spec, notes: [{ path: 'Hub.md', content: 'HUB', links: [] }, ...backers, ...spec.notes], patterns: [], obsidianFilters: [] };
        const r = setup(s);
        r.state = addNote(r.state, r.index, 'Hub.md', newId(r)).state;
        const assembled = await assembleContext(r.state, r.index);
        const text = renderContext(assembled)!;
        const list = assembled.backlinkLists.find((l) => l.of === 'Hub.md')!;
        expect(list.total).toBe(k);
        expect(list.paths.length).toBe(Math.min(k, BACKLINK_LIST_CAP));
        for (let j = 0; j < k; j++) expect(text.includes(`BACKER${j}X`)).toBe(false);
        for (const p of list.paths) expect(text).toContain(JSON.stringify(p));
        if (k > BACKLINK_LIST_CAP) expect(text).toContain(`and ${k - BACKLINK_LIST_CAP} more`);
        else expect(text).not.toMatch(/and \d+ more/);
      }),
    );
  });

  it('X4: the link-depth preview matches what is assembled at each depth', async () => {
    await fc.assert(
      fc.asyncProperty(vaultSpec, fc.nat(), async (spec, i) => {
        const r = setup(spec);
        const candidates = r.index.notes();
        fc.pre(candidates.length > 0);
        const root = candidates[i % candidates.length]!.path;
        const chip: NoteChip = { kind: 'note', id: 'x', path: root, depth: 0, backlinkContents: false, current: false };
        const previews = previewDepths(chip, r.index, 3);
        expect(previews.map((p) => p.depth)).toEqual([0, 1, 2, 3]);
        for (const p of previews) {
          for (const bc of [false, true]) {
            const state: ContextState = { followActive: false, chips: [{ ...chip, depth: p.depth, backlinkContents: bc }] };
            const a = await assembleContext(state, r.index);
            const tokens = a.notes.reduce((t, n) => t + estimateTokens(n.content), 0);
            if (!bc) {
              expect(a.notes.length - 1).toBe(p.notes);
              expect(tokens).toBe(p.tokens);
              expect(a.backlinkLists.reduce((t, l) => t + l.paths.length, 0)).toBe(p.backlinksListed);
              expect(a.excluded).toBe(p.excluded);
            } else {
              expect(tokens).toBe(p.tokens + p.backlinkContentTokens);
            }
          }
        }
      }),
    );
  });
});
