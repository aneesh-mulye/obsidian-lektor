// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ContextIndex } from '../../src/core/context/ContextIndex';
import { compileExclusions } from '../../src/core/context/exclusions';
import { prepareContext, recordSent, restoreContext, sha256 } from '../../src/core/context/prepare';
import type { ContextState } from '../../src/core/context/state';
import { FakeRawVault, type VaultSpec } from './vault.fixtures';

function vault(notes: Array<[string, string]>, patterns: string[] = []) {
  const spec: VaultSpec = { notes: notes.map(([path, content]) => ({ path, content, links: [] })), attachments: [], patterns, obsidianFilters: [], respectObsidian: false };
  const raw = new FakeRawVault(spec);
  const index = new ContextIndex(raw, () => compileExclusions({ patterns: spec.patterns, obsidianFilters: null, configDir: '.obsidian' }));
  index.refresh();
  return { spec, raw, index };
}

describe('prepareContext, recordSent, restoreContext', () => {
  it('prepares the message, its token estimate and a manifest of hashes', async () => {
    const { index } = vault([['a.md', 'alpha']]);
    const state: ContextState = { followActive: false, chips: [{ kind: 'note', id: '1', path: 'a.md', depth: 0, backlinkContents: false, current: false }] };
    const p = await prepareContext(state, index);
    expect(p.message).toContain('alpha');
    expect(p.tokens).toBeGreaterThan(0);
    expect(p.manifest.notes).toEqual([{ path: 'a.md', hash: await sha256('alpha') }]);
    expect(JSON.stringify(p.manifest)).not.toContain('alpha');
  });

  it('an empty context sends nothing', async () => {
    const { index } = vault([['a.md', 'alpha']]);
    expect(await prepareContext({ followActive: true, chips: [] }, index)).toEqual({
      message: null,
      images: [],
      tokens: 0,
      manifest: { notes: [], selections: [], attachments: [], backlinkLists: 0, excluded: 0 },
      skipped: [],
      urls: [],
    });
  });

  it('restores chips: drops deleted and newly excluded notes, marks changed ones, checks selections', async () => {
    const { spec, index } = vault([['a.md', 'alpha'], ['b.md', 'bravo'], ['Private/c.md', 'charlie'], ['d.md', 'delta text']]);
    let state: ContextState = {
      followActive: true,
      chips: [
        { kind: 'note', id: '1', path: 'a.md', depth: 0, backlinkContents: false, current: false },
        { kind: 'note', id: '2', path: 'b.md', depth: 0, backlinkContents: false, current: false },
        { kind: 'note', id: '3', path: 'Private/c.md', depth: 0, backlinkContents: false, current: false },
        { kind: 'selection', id: '4', path: 'd.md', from: 0, to: 5, hash: await sha256('delta') },
        { kind: 'selection', id: '5', path: 'd.md', from: 6, to: 10, hash: await sha256('tixt') },
      ],
    };
    state = recordSent(state, (await prepareContext(state, index)).manifest);
    // Later: b changes, Private becomes excluded, a is deleted.
    spec.notes = spec.notes.filter((n) => n.path !== 'a.md');
    spec.notes.find((n) => n.path === 'b.md')!.content = 'bravo two';
    spec.patterns = ['Private'];
    index.refresh();

    const { state: restored, notice } = await restoreContext(state, index);
    expect(restored.chips.map((c) => c.id)).toEqual(['2', '4']);
    expect(restored.chips[0]).toMatchObject({ path: 'b.md', changed: true });
    expect(restored.chips[1]).toMatchObject({ kind: 'selection', text: 'delta' });
    expect(notice).toContain('a.md');
    expect(notice).toContain('Private/c.md');
    expect(notice).toContain('Selections removed because the text changed: d.md');

    // Sending again clears the mark.
    const again = recordSent(restored, (await prepareContext(restored, index)).manifest);
    expect(again.chips[0]).not.toHaveProperty('changed');
  });
});
