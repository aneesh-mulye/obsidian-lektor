// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ContextIndex } from './ContextIndex';
import { type BacklinkList, type Via, planContext } from './plan';
import type { ContextState } from './state';

export interface AssembledNote {
  path: string;
  via: Via;
  content: string;
}

export interface AssembledContext {
  notes: AssembledNote[];
  backlinkLists: BacklinkList[];
  selections: Array<{ path: string; text: string }>;
  /** Excluded notes left out (for the user's "N excluded notes skipped"). */
  excluded: number;
}

/** Read exactly the planned notes, through the filtered index (INVARIANTS.md X2). */
export async function assembleContext(state: ContextState, index: ContextIndex): Promise<AssembledContext> {
  const plan = planContext(state, index);
  const notes: AssembledNote[] = [];
  for (const n of plan.notes) notes.push({ path: n.path, via: n.via, content: await index.read(n.path) });
  return {
    notes,
    backlinkLists: plan.backlinkLists,
    selections: plan.selections.map(({ path, text }) => ({ path, text })),
    excluded: plan.excluded.size,
  };
}
