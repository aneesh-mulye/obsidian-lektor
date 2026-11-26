// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Builds each reply's tool run: which tools, one budget per message, and the URLs fetch_page may use freely. */

import type { ToolRun, ToolsDeps } from '../chat/types';
import { ToolBudget } from './budget';
import type { ToolRegistry } from './registry';
import { KnownUrls } from './urls';

export interface ToolRunOptions {
  /** Tools enabled right now (e.g. web_search only once a provider is set up). */
  enabledNames: () => string[];
  limits: () => { searches: number; fetches: number };
}

export function toolRuns(registry: ToolRegistry, options: ToolRunOptions): ToolsDeps {
  return {
    forReply({ chat, capabilities, contextUrls }): ToolRun | null {
      // Tools only when the chat's switch is on and the model can call them natively.
      if (chat.toolsDisabled || capabilities.toolCalling !== 'native') return null;
      const names = options.enabledNames();
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
          const result = await registry.execute(call, enabled, budget, { signal, knownUrls: known, approve });
          for (const u of result.urls ?? []) known.add(u);
          return result;
        },
      };
    },
  };
}
