// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** What a preset run sends (DESIGN.md § Presets; INVARIANTS.md PR2): its prompt for that reply, and the user's turn. */

import type { Preset } from './preset';

/** How the reply can deliver what the preset asks for: a tool, fenced blocks, or neither (no note in context, say). */
export type Delivery = 'tool' | 'fenced' | 'none';

/** The system message for a preset's reply: its prompt, plus how to deliver what it asks for. */
export function presetInstructions(p: Preset, delivery: Delivery): string {
  const how: Record<Preset['output'], Record<Delivery, string>> = {
    findings: {
      tool: 'Report your findings with the report_findings tool, in one call if you can. Do not propose edits.',
      fenced: '', // the fenced-block instructions follow
      none: 'There is no note in the context to report on: say so, and ask the user to add the note.',
    },
    edits: {
      tool: 'Propose changes with propose_edit; the user reviews each one.',
      fenced: '',
      none: 'Describe any changes in words; you cannot propose edits here.',
    },
    chat: { tool: 'Answer in the chat; do not propose edits.', fenced: 'Answer in the chat; do not propose edits.', none: 'Answer in the chat; do not propose edits.' },
  };
  const extra = how[p.output][delivery];
  return extra ? `${p.prompt.trim()}\n\n${extra}` : p.prompt.trim();
}

/** The user's turn for a preset run, as the model sees it (in this reply and later ones). */
export function presetRequest(p: Preset, typed: string): string {
  const extra = typed.trim();
  return `Run the “${p.name}” preset on the notes in the context.${extra ? `\n\n${extra}` : ''}`;
}

/** A slash command in the composer: `/id rest`. Returns the preset and the rest, or null. */
export function parseSlash(text: string, presets: readonly Preset[]): { preset: Preset; rest: string } | null {
  const m = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!m) return null;
  const preset = presets.find((p) => p.id === m[1]);
  return preset ? { preset, rest: (m[2] ?? '').trim() } : null;
}
