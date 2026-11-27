// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings → Codex (DESIGN.md § Backends, § Subscriptions and terms; Decided,
 * before milestone 11): off until the user opts in, having seen the terms;
 * where the `codex` binary is; who does web work; and the lockdown check,
 * which must pass before any chat is sent (there is no override).
 */

import { type App, Notice, Setting } from 'obsidian';
import type { CodexProvider } from '../core/cli/codex/provider';
import type { ReadonlySettings, SettingsPatch } from '../core/settings';
import { confirm } from './ConfirmModal';

export const CODEX_TERMS = 'https://openai.com/policies/terms-of-use/';

export interface CodexSettingsHost {
  settings(): ReadonlySettings;
  apply(patch: SettingsPatch): Promise<void>;
  provider: CodexProvider | null;
}

export function renderCodexSettings(app: App, el: HTMLElement, host: CodexSettingsHost, redisplay: () => void): void {
  const cx = host.settings().cli.codex;
  const set = (patch: Partial<ReadonlySettings['cli']['codex']>) => host.apply({ cli: { codex: { ...host.settings().cli.codex, ...patch } } });

  new Setting(el).setName('Codex').setHeading();
  const intro = new Setting(el).setName('Use Codex').setDesc(
    createFragment((f) => {
      f.appendText('Chat with OpenAI’s models through the Codex CLI installed on this computer, signed in with your own ChatGPT plan. ');
      f.appendText('Lektor runs it locked down: in an empty temporary folder, with its file, shell and patch tools off, your Codex settings and MCP servers ignored, and only Lektor’s own tools for your notes. ');
      f.appendText('It never reads or copies your sign-in. ');
      f.createEl('a', { text: 'OpenAI’s terms', href: CODEX_TERMS });
      f.appendText('.');
    }),
  );
  intro.addToggle((t) =>
    t.setValue(cx.enabled).onChange((on) => {
      if (!on) {
        void set({ enabled: false }).then(redisplay);
        return;
      }
      void confirm(app, {
        title: 'Use Codex with Lektor?',
        body:
          'Lektor will start the official Codex CLI for each reply, signed in as you, so replies count against your ChatGPT plan. ' +
          'Your Codex settings, MCP servers and AGENTS.md files are ignored, and Codex keeps no history of these chats. ' +
          `OpenAI’s terms (${CODEX_TERMS}) cover your use of Codex; read them and decide. ` +
          'Before the first chat each day, Lektor checks that Codex cannot read files (one short request), and checks each model’s tools on this computer, sending nothing.',
        action: 'Use Codex',
      }).then(async (ok) => {
        if (ok) await set({ enabled: true });
        redisplay();
      });
    }),
  );
  if (!cx.enabled) return;

  let pathDraft = cx.path;
  new Setting(el)
    .setName('Codex program')
    .setDesc('Leave empty to look on PATH and in the usual places (~/.local/bin, /usr/local/bin). Only the official Codex CLI is accepted.')
    .addText((t) => t.setPlaceholder('/home/you/.local/bin/codex').setValue(cx.path).onChange((v) => (pathDraft = v.trim())))
    .addButton((b) =>
      b.setButtonText('Save and check').onClick(() => {
        void set({ path: pathDraft }).then(async () => {
          try {
            const found = await host.provider?.installed();
            new Notice(found ? `Lektor: found Codex ${found.version} at ${found.command}.` : 'Lektor: Codex is not available.');
          } catch (err) {
            new Notice(`Lektor: ${err instanceof Error ? err.message : 'Codex was not found.'}`);
          }
          redisplay();
        });
      }),
    );

  new Setting(el)
    .setName('Web')
    .setDesc('Codex searches the web and opens pages itself, as in its own app. Or let Lektor do web work: its own search (set up a search provider) and page fetching, which asks before fetching a page that didn’t come from a search, your messages or your notes.')
    .addDropdown((d) =>
      d
        .addOptions({ codex: 'Codex searches and opens pages itself', lektor: 'Lektor searches and fetches (asks first for unknown pages)' })
        .setValue(cx.web)
        .onChange((v) => void set({ web: v === 'lektor' ? 'lektor' : 'codex' })),
    );

  const check = new Setting(el).setName('Lockdown check');
  check.setDesc('Proves, on the installed version, that Codex can’t read files or run commands, and that each model gets only Lektor’s tools. It runs by itself before the first chat each day; a failed check turns the bridge off until it passes.');
  void host.provider?.lastSelfTest().then((r) => {
    if (!r) return;
    const when = new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    check.descEl.createDiv({ cls: r.ok ? 'lektor-note' : 'lektor-error', text: r.ok ? `Passed for Codex ${r.version}, ${when}.` : `Failed for Codex ${r.version}, ${when}: ${r.reason ?? 'unknown reason'}.` });
  });
  check.addButton((b) =>
    b.setButtonText('Run it now').onClick(() => {
      b.setDisabled(true).setButtonText('Checking…');
      void (host.provider?.selfTest(true) ?? Promise.resolve({ ok: false as const, reason: 'Codex is not available' }))
        .then((v) => new Notice(v.ok ? 'Lektor: the lockdown check passed.' : `Lektor: the lockdown check failed: ${v.reason}`))
        .catch((err: unknown) => new Notice(`Lektor: ${err instanceof Error ? err.message : 'the check could not run.'}`))
        .finally(redisplay);
    }),
  );
}
