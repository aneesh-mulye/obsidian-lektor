// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Builds each reply's tool run: which tools, one budget per message, and the URLs fetch_page may use freely. */

import type { ToolRun, ToolsDeps } from '../chat/types';
import type { ModelRef } from '../providers/types';
import { ToolBudget } from './budget';
import type { ToolRegistry } from './registry';
import { KnownUrls } from './urls';

export interface ToolRunOptions {
  /** Web tools enabled right now (e.g. web_search only once a provider is set up); the chat's globe can turn them off. */
  webNames: () => string[];
  /** Review tools (propose_edit needs an editable note in context; propose_note does not). */
  reviewNames: () => string[];
  limits: () => { searches: number; fetches: number };
  /** For models without tool calling: the fenced-block fallback for proposing edits. */
  fenced?: (editable: ReadonlySet<string>, model: ModelRef | null) => NonNullable<ToolRun['fenced']>;
}

export function toolRuns(registry: ToolRegistry, options: ToolRunOptions): ToolsDeps {
  return {
    forReply({ chat, capabilities, contextUrls, editable }): ToolRun | null {
      const editableSet = new Set(editable);
      if (capabilities.toolCalling !== 'native') {
        // No tool calling: edits can still be proposed in fenced blocks.
        if (!options.fenced || editableSet.size === 0 || !options.reviewNames().includes('propose_edit')) return null;
        return {
          definitions: [],
          execute: () => Promise.resolve({ ok: false, content: 'Tools are not available.', summary: 'no tools' }),
          fenced: options.fenced(editableSet, chat.model),
        };
      }
      const names = [
        ...(chat.toolsDisabled ? [] : options.webNames()),
        ...options.reviewNames().filter((n) => n !== 'propose_edit' || editableSet.size > 0),
      ];
      if (names.length === 0) return null;
      const enabled = new Set(names);
      const budget = new ToolBudget(options.limits());
      const known = new KnownUrls();
      for (const m of chat.messages) {
        if (m.role === 'user') known.addFrom(m.content);
        else for (const round of m.steps ?? []) for (const c of round.calls) for (const u of c.result?.urls ?? []) known.add(u);
      }
      for (const u of contextUrls) known.add(u);
      return {
        definitions: registry.definitions(names),
        async execute(call, signal, approve) {
          const result = await registry.execute(call, enabled, budget, { signal, knownUrls: known, approve, editable: editableSet, model: chat.model });
          for (const u of result.urls ?? []) known.add(u);
          return result;
        },
      };
    },
  };
}
