// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Starting a preset run from the sidebar, a slash command or the command
 * palette (DESIGN.md § Presets): it runs as the next message of the chat that
 * is open. A preset that needs web search, when none is available, asks for
 * one extra click first.
 */

import type { App } from 'obsidian';
import type { ChatManager } from '../core/chat/manager';
import type { Preset } from '../core/presets/preset';
import type { ChatProvider } from '../core/providers/types';
import { confirm } from './ConfirmModal';

export const NO_SEARCH = 'No web search — facts will be checked from the model’s memory only.';

export interface PresetStarter {
  /** Why this preset can't search right now, or null if it can (or doesn't need to). */
  searchProblem(preset: Preset): Promise<string | null>;
  /** Run it in the open chat; false if it didn't start (busy, no model, or the user said no). */
  start(preset: Preset, typed?: string): Promise<boolean>;
}

export function presetStarter(deps: {
  app: App;
  chats: ChatManager;
  providers: readonly ChatProvider[];
  searchConfigured: () => boolean;
  notice: (message: string) => void;
}): PresetStarter {
  const searchProblem = async (preset: Preset): Promise<string | null> => {
    if (!preset.tools.includes('web_search')) return null;
    const chat = deps.chats.session.chat;
    const model = preset.model ?? chat.model;
    if (chat.toolsDisabled) return `${NO_SEARCH} (Tools are off for this chat.)`;
    if (!deps.searchConfigured()) return `${NO_SEARCH} (No search provider is set up in Lektor's settings.)`;
    const provider = model ? deps.providers.find((p) => p.id === model.provider) : undefined;
    if (provider && model) {
      const caps = await provider.capabilities(model.model).catch(() => null);
      if (caps && caps.toolCalling !== 'native') return `${NO_SEARCH} (This model can't call tools.)`;
    }
    return null;
  };
  return {
    searchProblem,
    async start(preset, typed = '') {
      const session = deps.chats.session;
      if (session.busy) {
        deps.notice('Wait for the current reply to finish, or stop it.');
        return false;
      }
      if (!(preset.model ?? session.chat.model)) {
        deps.notice('Choose a model first.');
        return false;
      }
      const problem = await searchProblem(preset);
      if (problem && !(await confirm(deps.app, { title: `Run ${preset.name} without web search?`, body: problem, action: 'Run anyway' }))) return false;
      return deps.chats.session.send(typed, preset);
    },
  };
}
