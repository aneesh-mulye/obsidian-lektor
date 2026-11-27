// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings → CLI bridges → Claude Code (DESIGN.md § Backends, § Subscriptions
 * and terms): off until the user opts in, having seen the terms; where the
 * `claude` binary is; who fetches web pages; and the lockdown self-test, which
 * must pass before any chat is sent (there is no override).
 */

import { type App, Notice, Setting } from 'obsidian';
import type { ClaudeCodeProvider } from '../core/cli/claude/provider';
import type { ReadonlySettings, SettingsPatch } from '../core/settings';
import { confirm } from './ConfirmModal';

export const CLAUDE_CODE_TERMS = 'https://code.claude.com/docs/en/legal-and-compliance';

export interface ClaudeCodeSettingsHost {
  settings(): ReadonlySettings;
  apply(patch: SettingsPatch): Promise<void>;
  provider: ClaudeCodeProvider | null;
}

export function renderClaudeCodeSettings(app: App, el: HTMLElement, host: ClaudeCodeSettingsHost, redisplay: () => void): void {
  const cc = host.settings().cli.claudeCode;
  const set = (patch: Partial<ReadonlySettings['cli']['claudeCode']>) => host.apply({ cli: { claudeCode: { ...host.settings().cli.claudeCode, ...patch } } });

  const intro = new Setting(el).setName('Use Claude Code').setDesc(
    createFragment((f) => {
      f.appendText('Chat with Claude through the Claude Code CLI installed on this computer, signed in with your own Claude subscription. ');
      f.appendText('Lektor runs it locked down: in an empty temporary folder, with no file or shell tools, and only Lektor’s own tools for your notes. ');
      f.appendText('It never reads or copies your sign-in. ');
      f.createEl('a', { text: 'Claude Code’s terms', href: CLAUDE_CODE_TERMS });
      f.appendText('.');
    }),
  );
  intro.addToggle((t) =>
    t.setValue(cc.enabled).onChange((on) => {
      if (!on) {
        void set({ enabled: false })
          .then(() => host.provider?.discardSpare())
          .then(redisplay);
        return;
      }
      void confirm(app, {
        title: 'Use Claude Code with Lektor?',
        body:
          'Lektor will start the official Claude Code CLI for each reply, signed in as you, so replies count against your Claude plan. ' +
          `Anthropic’s terms (${CLAUDE_CODE_TERMS}) allow using the unmodified Claude Code with your own subscription; read them and decide. ` +
          'Before the first chat each day, Lektor checks that Claude Code cannot read files (one short request).',
        action: 'Use Claude Code',
      }).then(async (ok) => {
        if (ok) await set({ enabled: true });
        redisplay();
      });
    }),
  );
  if (!cc.enabled) return;

  let pathDraft = cc.path;
  new Setting(el)
    .setName('Claude Code program')
    .setDesc('Leave empty to look on PATH and in the usual places (~/.local/bin, /usr/local/bin). Only the official Claude Code is accepted.')
    .addText((t) => t.setPlaceholder('/home/you/.local/bin/claude').setValue(cc.path).onChange((v) => (pathDraft = v.trim())))
    .addButton((b) =>
      b.setButtonText('Save and check').onClick(() => {
        void set({ path: pathDraft }).then(async () => {
          try {
            const found = await host.provider?.installed();
            new Notice(found ? `Lektor: found Claude Code ${found.version} at ${found.command}.` : 'Lektor: Claude Code is not available.');
          } catch (err) {
            new Notice(`Lektor: ${err instanceof Error ? err.message : 'Claude Code was not found.'}`);
          }
          redisplay();
        });
      }),
    );

  new Setting(el)
    .setName('Web pages')
    .setDesc('Claude Code searches the web itself. Choose who fetches pages: Claude Code, as in its own app, or Lektor, which asks before fetching a page that didn’t come from a search, your messages or your notes.')
    .addDropdown((d) =>
      d
        .addOptions({ claude: 'Claude Code fetches pages itself', lektor: 'Lektor fetches pages (asks first for unknown ones)' })
        .setValue(cc.pages)
        .onChange((v) => void set({ pages: v === 'lektor' ? 'lektor' : 'claude' })),
    );

  new Setting(el)
    .setName('Keep Claude Code ready')
    .setDesc('After each reply, start the next Claude Code process ahead of time, so your next message gets an answer about half a second sooner. It uses about 200 MB of memory while it waits, and stops after 10 idle minutes.')
    .addToggle((t) =>
      t.setValue(cc.warm).onChange((on) => {
        void set({ warm: on }).then(() => (on ? undefined : host.provider?.discardSpare()));
      }),
    );

  const check = new Setting(el).setName('Lockdown check');
  check.setDesc('Proves, on the installed version, that Claude Code can’t read files or run commands. It runs by itself before the first chat each day; a failed check turns the bridge off until it passes.');
  void host.provider?.lastSelfTest().then((r) => {
    if (!r) return;
    const when = new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    check.descEl.createDiv({ cls: r.ok ? 'lektor-note' : 'lektor-error', text: r.ok ? `Passed for Claude Code ${r.version}, ${when}.` : `Failed for Claude Code ${r.version}, ${when}: ${r.reason ?? 'unknown reason'}.` });
  });
  check.addButton((b) =>
    b.setButtonText('Run it now').onClick(() => {
      b.setDisabled(true).setButtonText('Checking…');
      void (host.provider?.selfTest(true) ?? Promise.resolve({ ok: false as const, reason: 'Claude Code is not available' }))
        .then((v) => new Notice(v.ok ? 'Lektor: the lockdown check passed.' : `Lektor: the lockdown check failed: ${v.reason}`))
        .catch((err: unknown) => new Notice(`Lektor: ${err instanceof Error ? err.message : 'the check could not run.'}`))
        .finally(redisplay);
    }),
  );
}
