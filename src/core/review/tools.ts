// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** propose_edit and propose_note, and the fenced `lektor-edit` fallback (DESIGN.md § Proposal format). */

import { fencedBlocks } from '../tools/fence';
import type { ToolRun } from '../chat/types';
import type { ModelRef } from '../providers/types';
import { type Tool, ToolError } from '../tools/types';
import { ProposeEditArgs, ProposeNoteArgs, newNotePathProblem, proposeEdit, proposeNote } from './proposals';
import type { EditProposal, Proposal } from './types';

export interface ReviewToolDeps {
  /** The note's current text (through ContextBroker). */
  readNote: (path: string) => Promise<string>;
  isExcluded: (path: string) => boolean;
  /** Whether any file exists at the path (excluded ones included). */
  exists: (path: string) => boolean;
  newId: () => string;
  now: () => number;
}

const NO_MODEL: ModelRef = { provider: 'none', model: 'none' };

async function makeEditProposal(args: ProposeEditArgs, editable: ReadonlySet<string>, model: ModelRef | null, deps: ReviewToolDeps): Promise<EditProposal> {
  if (!editable.has(args.path)) {
    const list = [...editable].join(', ');
    throw new ToolError(`You can only propose edits to notes in the context${list ? `: ${list}` : ', and there are none'}. Use the path exactly as given.`);
  }
  let text: string;
  try {
    text = await deps.readNote(args.path);
  } catch {
    throw new ToolError(`Lektor could not read ${args.path}.`);
  }
  const v = proposeEdit(args, { text, id: deps.newId(), hunkId: deps.newId, createdAt: deps.now(), model: model ?? NO_MODEL });
  if (!v.ok) throw new ToolError(v.error);
  return v.proposal;
}

export function proposeEditTool(deps: ReviewToolDeps): Tool<ProposeEditArgs> {
  return {
    name: 'propose_edit',
    description:
      'Propose changes to a note in the context. Each edit replaces text copied exactly from the note (it must occur exactly once) with new text. ' +
      'Keep each edit small and focused, give a short reason, and never paste the whole note. The user reviews every change; nothing is applied without them.',
    schema: ProposeEditArgs,
    approval: 'never', // nothing is written: the user reviews the proposal
    touchesVault: true, // reads the note through ContextBroker, to check the edits
    async run(args, ctx) {
      const proposal = await makeEditProposal(args, ctx.editable, ctx.model, deps);
      const n = proposal.hunks.length;
      return {
        content: `Proposed ${n} change${n === 1 ? '' : 's'} to ${args.path}. The user will review them; do not repeat the edits in your reply.`,
        summary: `${args.path}: ${n} change${n === 1 ? '' : 's'} proposed`,
        proposal,
      };
    },
  };
}

export function proposeNoteTool(deps: ReviewToolDeps): Tool<ProposeNoteArgs> {
  return {
    name: 'propose_note',
    description: 'Propose a new note (path ending in .md, and its full text). The user decides whether to create it. Use propose_edit to change existing notes.',
    schema: ProposeNoteArgs,
    approval: 'never', // nothing is written until the user clicks Create
    touchesVault: true,
    run(args, ctx) {
      const problem = newNotePathProblem(args.path, deps.isExcluded, deps.exists);
      if (problem) return Promise.reject(new ToolError(problem));
      const proposal = proposeNote(args, { id: deps.newId(), createdAt: deps.now(), model: ctx.model ?? NO_MODEL });
      return Promise.resolve({
        content: `Proposed a new note at ${args.path}. The user will decide whether to create it.`,
        summary: `${args.path}: new note proposed`,
        proposal,
      });
    },
  };
}


/** For models without tool calling: edits proposed in fenced `lektor-edit` blocks in the reply. */
export function fencedEdits(deps: ReviewToolDeps, editable: ReadonlySet<string>, model: ModelRef | null): NonNullable<ToolRun['fenced']> {
  const list = [...editable].map((p) => `- ${p}`).join('\n');
  return {
    instructions:
      'You can propose changes to these notes:\n' +
      `${list}\n` +
      'To propose changes, include a fenced block like this in your reply (the user reviews each change; nothing is applied without them):\n' +
      '```lektor-edit\n{"path": "Folder/Note.md", "edits": [{"find": "text copied exactly from the note", "replace": "new text", "reason": "why"}]}\n```\n' +
      'Each "find" must occur exactly once in the note. Keep edits small and never paste the whole note.',
    async extract(reply) {
      const proposals: Proposal[] = [];
      const problems: string[] = [];
      for (const [i, body] of fencedBlocks(reply, 'lektor-edit').entries()) {
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          problems.push(`Block ${i + 1} is not valid JSON.`);
          continue;
        }
        const args = ProposeEditArgs.safeParse(value);
        if (!args.success) {
          problems.push(`Block ${i + 1} is not a valid edit (it needs "path" and "edits" with "find" and "replace").`);
          continue;
        }
        try {
          proposals.push(await makeEditProposal(args.data, editable, model, deps));
        } catch (err) {
          problems.push(`Block ${i + 1}: ${err instanceof Error ? err.message : 'invalid'}`);
        }
      }
      return { proposals, problems };
    },
  };
}
