// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `request_context`: the model asks for more context, and the user decides
 * (DESIGN.md § Model-initiated requests; INVARIANTS.md A3).
 *
 * The request is resolved into a list of files from metadata alone, and the
 * user ticks what to share on a card. Nothing is read until then, except in
 * Allowed mode, where an attachment already linked from a note in context is
 * granted without asking. Approved items are sent in this tool result for the
 * rest of the reply and become chips; chat history keeps only their paths.
 *
 * Denying, ticking nothing and "nothing matched" all give the model the same
 * answer, so it learns nothing about notes it wasn't given.
 */

import { z } from 'zod';
import { convertAttachment } from '../context/assemble';
import type { ContextIndex } from '../context/ContextIndex';
import { sha256 } from '../context/hash';
import { planContext } from '../context/plan';
import { type SharedItem, renderShared } from '../context/render';
import { REQUEST_CAP, type RequestItem, resolveRequest } from '../context/request';
import { type Depth, attachmentModeOf } from '../context/state';
import type { ChatImage } from '../providers/types';
import { type Shared, type Tool, ToolError } from './types';

export const NOTHING_SHARED = 'The user did not share anything for this request. Answer with what you have, or tell the user what you would need.';

const Schema = z
  .strictObject({
    notes: z.array(z.string().min(1).max(500)).max(REQUEST_CAP).optional().describe('Notes by vault path (e.g. "Projects/Plan.md") or by title.'),
    linked_from: z
      .strictObject({ note: z.string().min(1).max(500), depth: z.int().min(1).max(3) })
      .optional()
      .describe('A note and the notes it links to, following links to this depth.'),
    folder: z
      .strictObject({ path: z.string().min(1).max(500), recursive: z.boolean().optional() })
      .optional()
      .describe('Every note in a folder (and its subfolders, if recursive).'),
    search: z.string().min(1).max(200).optional().describe('Words to look for in note titles.'),
    attachments: z.array(z.string().min(1).max(500)).max(REQUEST_CAP).optional().describe('Attachments (images, text files) by vault path or file name.'),
    reason: z.string().max(500).optional().describe('One sentence for the user: why you need these.'),
  })
  .refine((r) => r.notes?.length || r.linked_from || r.folder || r.search || r.attachments?.length, { error: 'Ask for at least one of notes, linked_from, folder, search or attachments.' });

export type RequestArgs = z.infer<typeof Schema>;

export interface RequestContextDeps {
  index: ContextIndex;
  /** The deepest link depth the settings allow. */
  maxDepth: () => Depth;
}

const quoteList = (paths: readonly string[]) => paths.map((p) => JSON.stringify(p)).join(', ');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function requestContextTool(deps: RequestContextDeps): Tool<RequestArgs> {
  return {
    name: 'request_context',
    description:
      'Ask the user to share more of their Obsidian vault: notes by path or title, the notes linked from a note, a folder, notes whose titles match a search, or attachments such as images. ' +
      `The user sees exactly what you asked for and chooses what to share (at most ${REQUEST_CAP} files per request). Ask only for what you need.`,
    schema: Schema,
    approval: 'never', // the tool shows its own card, listing every file (see below)
    touchesVault: true, // through the ContextIndex that ContextBroker supplies
    async run(args, ctx) {
      const scope = ctx.context;
      if (!scope || !ctx.choose) throw new ToolError('request_context is not available here.');
      const { index } = deps;
      const mode = attachmentModeOf(scope.state, scope.fallbackMode);
      const plan = planContext(scope.state, index, scope.fallbackMode);
      const found = resolveRequest(args, index, plan, scope.accepts, deps.maxDepth());
      const alreadyLine = found.already.length > 0 ? ` Already in the context: ${quoteList(found.already)}.` : '';

      if (found.items.length > REQUEST_CAP) {
        throw new ToolError(`That request matches more than ${REQUEST_CAP} files. Ask for fewer: specific notes, a smaller folder or a narrower search.`);
      }
      const nothing = (summary: string) => ({ content: NOTHING_SHARED + alreadyLine, summary });
      if (found.items.length === 0) return nothing(found.already.length > 0 ? 'already in context' : 'nothing matched');

      // Allowed mode: an attachment linked from a note in context is granted without a prompt, unless the user withheld it.
      const withheld = new Set(scope.state.withheld ?? []);
      const linked = new Set(plan.attachmentLists.flatMap((l) => l.paths));
      const auto = (i: RequestItem) => mode === 'allowed' && i.kind === 'attachment' && i.unavailable === undefined && linked.has(i.path) && !withheld.has(i.path);
      const granted = found.items.filter(auto);
      const ask = found.items.filter((i) => !auto(i));
      if (ask.length > 0) {
        const offered = new Map(ask.filter((i) => i.unavailable === undefined).map((i) => [i.path, i]));
        const ticked = await ctx.choose({
          tool: 'request_context',
          title: 'Share with the model?',
          detail: args.reason ?? 'The model asked for more of your vault.',
          items: ask.map((i) => ({ id: i.path, kind: i.kind, label: i.path, tokens: i.tokens, ...(i.unavailable ? { unavailable: i.unavailable } : {}) })),
          ...(found.excluded > 0 ? { note: `${plural(found.excluded, 'excluded item')} not listed` } : {}),
        });
        // Only what was offered and could be sent; anything else the answer names is ignored.
        for (const id of new Set(ticked)) {
          const item = offered.get(id);
          if (item) granted.push(item);
        }
      }
      if (ctx.signal.aborted) throw new ToolError('Stopped by the user.');
      if (granted.length === 0) return nothing('declined');

      // Read what was granted, through the filtered index (which re-checks exclusions now).
      const items: SharedItem[] = [];
      const images: (ChatImage & { path: string })[] = [];
      const shared: { notes: string[]; attachments: string[] } = { notes: [], attachments: [] };
      const manifest: Shared['manifest'] = { notes: [], attachments: [] };
      const failed: string[] = [];
      for (const item of granted) {
        if (item.kind === 'note') {
          const text = await index.read(item.path).catch(() => null);
          if (text === null) {
            failed.push(item.path);
            continue;
          }
          items.push({ kind: 'note', path: item.path, text });
          shared.notes.push(item.path);
          manifest.notes.push({ path: item.path, hash: await sha256(text) });
          continue;
        }
        const r = await convertAttachment(index, item.path, scope.accepts).catch(() => null);
        if (!r?.ok) {
          failed.push(item.path);
          continue;
        }
        if (r.part.kind === 'text') items.push({ kind: 'attachment', path: item.path, text: r.part.text });
        else {
          items.push({ kind: 'image', path: item.path, text: '' });
          images.push({ path: item.path, mime: r.part.mime, data: r.part.data, tokens: r.part.tokens });
        }
        shared.attachments.push(item.path);
        manifest.attachments.push({ path: item.path, hash: r.hash });
      }
      if (items.length === 0) return nothing('could not be read');

      const paths = items.map((i) => i.path);
      const rest = ' Nothing else was shared.' + alreadyLine;
      return {
        // What chat history keeps: paths only. The contents are in the context from the next message on.
        content: `The user shared ${quoteList(paths)} (sent with this result; now in the context).${rest}`,
        summary: `shared ${plural(paths.length, 'item')}${failed.length > 0 ? `, ${failed.length} unreadable` : ''}`,
        transient: { content: renderShared(items) + rest, ...(images.length > 0 ? { images } : {}) },
        shared: { ...shared, manifest },
      };
    },
  };
}
