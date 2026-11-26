// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Builds each reply's tool run: which tools (a preset's output and tools included), one budget per message, and the URLs fetch_page may use freely. */

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
  /** For models without tool calling, findings presets: findings in fenced `lektor-findings` blocks. */
  fencedFindings?: (editable: ReadonlySet<string>, known: KnownUrls, model: ModelRef | null) => NonNullable<ToolRun['fenced']>;
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
    forReply({ chat, capabilities, contextUrls, editable, preset }): ToolRun | null {
      const editableSet = new Set(editable);
      const model = preset?.model ?? chat.model;
      const output = preset?.output;
      // Prose mode: nothing is proposed, the model is asked to describe changes (INVARIANTS.md B5).
      const prose = displayModeOf(chat, options.displayMode()) === 'prose';
      // A findings preset reports findings and proposes nothing; a chat preset proposes nothing (INVARIANTS.md PR2).
      const reviewNames = output === 'findings' ? ['report_findings'] : output === 'chat' || prose ? [] : options.reviewNames();
      const proseNote = prose && output !== 'findings' && output !== 'chat';
      const known = new KnownUrls();
      for (const m of chat.messages) {
        if (m.role === 'user') known.addFrom(m.content);
        else for (const round of m.steps ?? []) for (const c of round.calls) for (const u of c.result?.urls ?? []) known.add(u);
      }
      for (const u of contextUrls) known.add(u);
      const none = () => Promise.resolve({ ok: false, content: 'Tools are not available.', summary: 'no tools' });

      if (capabilities.toolCalling !== 'native') {
        // No tool calling: findings and edits can still come in fenced blocks.
        if (output === 'findings') {
          if (!options.fencedFindings || editableSet.size === 0) return null;
          return { definitions: [], execute: none, fenced: options.fencedFindings(editableSet, known, model) };
        }
        if (proseNote) return PROSE_ONLY;
        if (!options.fenced || editableSet.size === 0 || !reviewNames.includes('propose_edit')) return null;
        return { definitions: [], execute: none, fenced: options.fenced(editableSet, model) };
      }
      // A preset uses only the web tools it lists, and only those available anyway.
      const web = chat.toolsDisabled ? [] : options.webNames().filter((n) => !preset || (preset.tools as readonly string[]).includes(n));
      const names = [
        ...web,
        ...(options.attachmentMode ? ['request_context'] : []),
        ...reviewNames.filter((n) => (n !== 'propose_edit' && n !== 'report_findings') || editableSet.size > 0),
      ];
      if (names.length === 0) return proseNote ? PROSE_ONLY : null;
      const enabled = new Set(names);
      const limits = options.limits();
      const budget = new ToolBudget({ searches: preset?.searches ?? limits.searches, fetches: preset?.fetches ?? limits.fetches });
      return {
        ...(proseNote ? { instructions: PROSE } : {}),
        definitions: registry.definitions(names),
        async execute(call, signal, approve, extra) {
          const fallbackMode = options.attachmentMode?.() ?? 'ask';
          const result = await registry.execute(call, enabled, budget, {
            signal,
            knownUrls: known,
            approve,
            editable: editableSet,
            model,
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
