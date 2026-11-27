// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings → Presets (DESIGN.md § Presets): the list, and a form for one
 * preset (name, icon, model, tools, display mode, output, caps, prompt) that
 * reads and writes the same files as a text editor would. Built-ins can be
 * edited (saved as a file that takes precedence), reset, or hidden.
 */

import { type App, Modal, Notice, Setting, setIcon } from 'obsidian';
import type { PresetEntry, PresetLibrary } from '../core/presets/library';
import { BUILTIN_PRESETS } from '../core/presets/builtins';
import {
  DEFAULT_ICON,
  PRESET_CAP_MAX,
  type Preset,
  type PresetOutput,
  type PresetTool,
  presetIdFor,
  presetProblem,
} from '../core/presets/preset';
import { DISPLAY_MODES, type DisplayMode } from '../core/settings';
import { confirm } from './ConfirmModal';

const SOURCE: Record<PresetEntry['source'], string> = { builtin: 'Built-in', edited: 'Built-in, edited', file: 'Yours' };
const OUTPUT_LABELS: Record<PresetOutput, string> = {
  findings: 'Findings (highlighted in the note)',
  edits: 'Edits (proposed for review)',
  chat: 'Chat (an answer only)',
};
const DISPLAY_LABELS: Record<DisplayMode, string> = { prose: 'Prose', sidebar: 'Sidebar diff', inline: 'Inline' };
const TOOL_LABELS: Record<PresetTool, string> = { web_search: 'Web search', fetch_page: 'Fetch pages' };

export interface PresetSettingsHost {
  presets: PresetLibrary;
  /** Where the files are, for the description. */
  folder: string;
  hidden(): readonly string[];
  setHidden(ids: readonly string[]): Promise<void>;
}

export function renderPresetSettings(app: App, el: HTMLElement, host: PresetSettingsHost, redisplay: () => void): void {
  new Setting(el)
    .setDesc(
      `Presets are Markdown files in ${host.folder}: settings at the top, the prompt below. Edit them here, or in any text editor and then click Reload. ` +
        'Run one from the row above the message box, by typing / and its name, or from the command palette.',
    )
    .addButton((b) => b.setButtonText('New preset…').setCta().onClick(() => new PresetModal(app, host, null, redisplay).open()))
    .addButton((b) =>
      b.setButtonText('Reload').onClick(() => {
        void host.presets.load().then(() => {
          new Notice('Lektor: presets reloaded.');
          redisplay();
        });
      }),
    );

  for (const entry of host.presets.entries()) {
    const name = entry.preset?.name ?? entry.id;
    const row = new Setting(el).setName(name);
    const iconEl = row.nameEl.createSpan({ cls: 'lektor-preset-settings-icon' });
    row.nameEl.prepend(iconEl);
    setIcon(iconEl, entry.preset?.icon ?? 'alert-triangle');
    const desc = `${SOURCE[entry.source]} · /${entry.id}${entry.preset ? ` · ${OUTPUT_LABELS[entry.preset.output].split(' (')[0]}` : ''}${entry.hidden ? ' · hidden' : ''}`;
    row.setDesc(desc);
    if (entry.error) row.descEl.createDiv({ cls: 'lektor-error', text: `This file can't be used: ${entry.error}` });

    const base = entry.preset ?? BUILTIN_PRESETS.find((b) => b.id === entry.id) ?? null;
    if (base) row.addButton((b) => b.setButtonText('Edit…').onClick(() => new PresetModal(app, host, { ...base, id: entry.id }, redisplay).open()));
    if (entry.source !== 'file') {
      row.addToggle((t) =>
        t
          .setTooltip(entry.hidden ? 'Hidden: click to show' : 'Shown: click to hide')
          .setValue(!entry.hidden)
          .onChange((on) => {
            const hidden = new Set(host.hidden());
            if (on) hidden.delete(entry.id);
            else hidden.add(entry.id);
            void host.setHidden([...hidden]).then(redisplay);
          }),
      );
    }
    if (entry.source === 'edited') {
      row.addButton((b) =>
        b.setButtonText('Reset').onClick(() => {
          void confirm(app, { title: `Reset ${name}?`, body: 'This deletes your edited version and brings back the built-in preset.', action: 'Reset' }).then(async (ok) => {
            if (ok) await host.presets.remove(entry.id);
            redisplay();
          });
        }),
      );
    }
    if (entry.source === 'file') {
      row.addButton((b) =>
        b
          .setButtonText('Delete')
          .setDestructive()
          .onClick(() => {
            void confirm(app, { title: `Delete ${name}?`, body: 'This deletes the preset file. It cannot be undone.', action: 'Delete' }).then(async (ok) => {
              if (ok) await host.presets.remove(entry.id);
              redisplay();
            });
          }),
      );
    }
  }
}

/** The form for one preset; `start` is null for a new one. */
class PresetModal extends Modal {
  #draft: Preset;
  readonly #isNew: boolean;

  constructor(
    app: App,
    private readonly host: PresetSettingsHost,
    start: Preset | null,
    private readonly saved: () => void,
  ) {
    super(app);
    this.#isNew = start === null;
    this.#draft = start ?? { id: '', name: '', icon: DEFAULT_ICON, tools: [], output: 'findings', prompt: '' };
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.#isNew ? 'New preset' : `Edit preset: ${this.#draft.name}`);
    contentEl.addClass('lektor-preset-modal');
    const set = (patch: Partial<Preset>) => {
      this.#draft = { ...this.#draft, ...patch };
    };
    const without = (key: 'model' | 'display' | 'searches' | 'fetches') => {
      const { [key]: _gone, ...rest } = this.#draft;
      this.#draft = rest;
    };

    new Setting(contentEl).setName('Name').addText((t) => t.setValue(this.#draft.name).onChange((v) => set({ name: v.trim() })));
    const iconRow = new Setting(contentEl).setName('Icon').setDesc('A Lucide icon name, such as spell-check, signpost or badge-check.');
    const preview = iconRow.controlEl.createSpan({ cls: 'lektor-preset-settings-icon' });
    setIcon(preview, this.#draft.icon);
    iconRow.addText((t) =>
      t.setValue(this.#draft.icon).onChange((v) => {
        set({ icon: v.trim() });
        preview.empty();
        setIcon(preview, v.trim() || DEFAULT_ICON);
      }),
    );
    new Setting(contentEl)
      .setName('Model')
      .setDesc('Leave empty to use the chat’s model. Otherwise provider:model, such as ollama:qwen3.8:27b.')
      .addText((t) =>
        t.setValue(this.#draft.model ? `${this.#draft.model.provider}:${this.#draft.model.model}` : '').onChange((v) => {
          const text = v.trim();
          const colon = text.indexOf(':');
          if (text === '') without('model');
          else set({ model: { provider: colon === -1 ? text : text.slice(0, colon), model: colon === -1 ? '' : text.slice(colon + 1) } });
        }),
      );
    new Setting(contentEl)
      .setName('Output')
      .addDropdown((d) => d.addOptions(OUTPUT_LABELS).setValue(this.#draft.output).onChange((v) => set({ output: v as PresetOutput })));
    for (const tool of ['web_search', 'fetch_page'] as const) {
      new Setting(contentEl).setName(TOOL_LABELS[tool]).addToggle((t) =>
        t.setValue(this.#draft.tools.includes(tool)).onChange((on) => {
          const tools = new Set(this.#draft.tools);
          if (on) tools.add(tool);
          else tools.delete(tool);
          set({ tools: (['web_search', 'fetch_page'] as const).filter((x) => tools.has(x)) });
        }),
      );
    }
    new Setting(contentEl)
      .setName('Display mode')
      .setDesc('The chat switches to this mode when the preset runs.')
      .addDropdown((d) =>
        d
          .addOption('', 'Don’t change')
          .addOptions(Object.fromEntries(DISPLAY_MODES.map((m) => [m, DISPLAY_LABELS[m]])))
          .setValue(this.#draft.display ?? '')
          .onChange((v) => (v === '' ? without('display') : set({ display: v as DisplayMode }))),
      );
    for (const cap of ['searches', 'fetches'] as const) {
      new Setting(contentEl)
        .setName(cap === 'searches' ? 'Searches per run' : 'Page fetches per run')
        .setDesc(`Leave empty to use the global limit. At most ${PRESET_CAP_MAX}.`)
        .addText((t) =>
          t.setValue(this.#draft[cap]?.toString() ?? '').onChange((v) => {
            const text = v.trim();
            if (text === '') without(cap);
            else set({ [cap]: /^\d+$/.test(text) ? Number(text) : Number.NaN });
          }),
        );
    }
    const promptRow = new Setting(contentEl).setName('Prompt').setDesc('What the model is asked to do. It applies to the run’s reply only.');
    promptRow.settingEl.addClass('lektor-preset-prompt-row');
    const area = contentEl.createEl('textarea', { cls: 'lektor-preset-prompt', attr: { rows: '12', spellcheck: 'true' } });
    area.value = this.#draft.prompt;
    area.oninput = () => set({ prompt: area.value });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Save').setCta().onClick(() => void this.save()));
  }

  private async save(): Promise<void> {
    const taken = new Set([...this.host.presets.entries().map((e) => e.id)]);
    const id = this.#isNew ? presetIdFor(this.#draft.name, taken) : this.#draft.id;
    const preset: Preset = { ...this.#draft, id };
    for (const cap of ['searches', 'fetches'] as const) {
      const v = preset[cap];
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > PRESET_CAP_MAX)) {
        new Notice(`Lektor: ${cap === 'searches' ? 'searches' : 'page fetches'} per run must be a whole number from 0 to ${PRESET_CAP_MAX}.`);
        return;
      }
    }
    const problem = presetProblem(preset);
    if (problem) {
      new Notice(`Lektor: ${problem}`);
      return;
    }
    try {
      await this.host.presets.save(preset);
    } catch (err) {
      console.error('Lektor: saving a preset failed', err);
      new Notice('Lektor: could not save the preset.');
      return;
    }
    new Notice(`Lektor: saved ${preset.name} (/${id}).`);
    this.close();
    this.saved();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
