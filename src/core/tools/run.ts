// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Builds each reply's tool run: which tools, one budget per message, and the URLs fetch_page may use freely. */

import { type ToolRun, type ToolsDeps, displayModeOf } from '../chat/types';
import type { AttachmentMode, DisplayMode } from '../settings';
import type { ModelRef } from '../providers/types';
import { ToolBudget } from './budget';
import type { ToolRegistry } from './registry';
import { KnownUrls, extractUrls } from './urls';

export interface ToolRunOptions {
  /** Web tools enabled right now (e.g. web_search only once a provider is set up); the chat's globe can turn them off. */
  webNames: () => string[];
  /** Review tools (propose_edit needs an editable note in context; propose_note does not). None in Prose mode. */
  reviewNames: () => string[];
  /** The display mode for chats that never chose one (Settings → Review). */
  displayMode: () => DisplayMode;
  limits: () => { searches: number; fetches: number };
  /**
   * With this set, request_context is offered to every model with native tool calling, in every
   * display mode and whatever the globe says (DESIGN.md § Decided, milestone 7). It is the setting,
   * for chats that never chose an attachment mode.
   */
  attachmentMode?: () => AttachmentMode;
  /** For models without tool calling: the fenced-block fallback for proposing edits. */
  fenced?: (editable: ReadonlySet<string>, model: ModelRef | null) => NonNullable<ToolRun['fenced']>;
}

export const PROSE =
  'The user is reviewing in Prose mode: if you suggest changes to their notes, describe them in words (quote the passage and say what to change). Do not write out a rewritten note; the user will make the changes by hand.';

const PROSE_ONLY: ToolRun = {
  definitions: [],
  execute: () => Promise.resolve({ ok: false, content: 'Tools are not available.', summary: 'no tools' }),
  instructions: PROSE,
};

export function toolRuns(registry: ToolRegistry, options: ToolRunOptions): ToolsDeps {
  return {
    forReply({ chat, capabilities, contextUrls, editable }): ToolRun | null {
      const editableSet = new Set(editable);
      // Prose mode: nothing is proposed, the model is asked to describe changes (INVARIANTS.md B5).
      const prose = displayModeOf(chat, options.displayMode()) === 'prose';
      const reviewNames = prose ? [] : options.reviewNames();
      if (capabilities.toolCalling !== 'native') {
        if (prose) return PROSE_ONLY;
        // No tool calling: edits can still be proposed in fenced blocks.
        if (!options.fenced || editableSet.size === 0 || !reviewNames.includes('propose_edit')) return null;
        return {
          definitions: [],
          execute: () => Promise.resolve({ ok: false, content: 'Tools are not available.', summary: 'no tools' }),
          fenced: options.fenced(editableSet, chat.model),
        };
      }
      const names = [
        ...(chat.toolsDisabled ? [] : options.webNames()),
        ...(options.attachmentMode ? ['request_context'] : []),
        ...reviewNames.filter((n) => n !== 'propose_edit' || editableSet.size > 0),
      ];
      if (names.length === 0) return prose ? PROSE_ONLY : null;
      const enabled = new Set(names);
      const budget = new ToolBudget(options.limits());
      const known = new KnownUrls();
      for (const m of chat.messages) {
        if (m.role === 'user') known.addFrom(m.content);
        else for (const round of m.steps ?? []) for (const c of round.calls) for (const u of c.result?.urls ?? []) known.add(u);
      }
      for (const u of contextUrls) known.add(u);
      return {
        ...(prose ? { instructions: PROSE } : {}),
        definitions: registry.definitions(names),
        async execute(call, signal, approve, extra) {
          const fallbackMode = options.attachmentMode?.() ?? 'ask';
          const result = await registry.execute(call, enabled, budget, {
            signal,
            knownUrls: known,
            approve,
            editable: editableSet,
            model: chat.model,
            ...(extra?.choose ? { choose: extra.choose } : {}),
            ...(extra?.context ? { context: { state: extra.context(), fallbackMode, accepts: { images: capabilities.images } } } : {}),
          });
          for (const u of result.urls ?? []) known.add(u);
          // Shared notes are now in context: the model may propose edits to them, and fetch the URLs they contain.
          for (const p of result.shared?.notes ?? []) editableSet.add(p);
          if (result.shared) for (const u of extractUrls(result.transient?.content ?? '')) known.add(u);
          return result;
        },
      };
    },
  };
}
