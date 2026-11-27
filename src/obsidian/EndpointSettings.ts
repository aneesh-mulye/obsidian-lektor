// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings → Models → Endpoints (DESIGN.md § Decided, before milestone 9):
 * OpenAI- and Anthropic-compatible servers, each with a name, URL, optional
 * key (an Obsidian secret, by name), and capabilities the server doesn't
 * report itself.
 */

import { type App, Modal, Notice, SecretComponent, Setting } from 'obsidian';
import { type Endpoint, EndpointSchema, type EndpointKind, MAX_ENDPOINTS, type ReadonlyEndpoint, normaliseBaseUrl } from '../core/settings';
import { confirm } from './ConfirmModal';
import { issuePath } from '../core/issuePath';

export interface EndpointSettingsHost {
  endpoints(): readonly ReadonlyEndpoint[];
  save(list: Endpoint[]): Promise<boolean>;
  /** Contact the server and describe what it has (or why it can't be reached). */
  check(endpoint: Endpoint): Promise<string>;
}

const KIND_LABELS: Record<EndpointKind, string> = { openai: 'OpenAI-compatible', anthropic: 'Anthropic-compatible' };

const BLANK: Omit<Endpoint, 'id' | 'name' | 'kind' | 'baseUrl'> = { secret: '', contextLength: 32768, tools: true, images: false, maxOutput: 16384, thinking: false, models: [] };

/** Starting points for common servers; every field can be changed afterwards. */
const TEMPLATES: Array<{ label: string; endpoint: Omit<Endpoint, 'id'> }> = [
  { label: 'LM Studio', endpoint: { ...BLANK, name: 'LM Studio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' } },
  { label: 'llama.cpp server', endpoint: { ...BLANK, name: 'llama.cpp', kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' } },
  { label: 'vLLM', endpoint: { ...BLANK, name: 'vLLM', kind: 'openai', baseUrl: 'http://127.0.0.1:8000/v1' } },
  { label: 'Ollama (OpenAI-compatible)', endpoint: { ...BLANK, name: 'Ollama (OpenAI)', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' } },
  { label: 'Anthropic API', endpoint: { ...BLANK, name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', contextLength: 200000, images: true, thinking: true } },
  { label: 'OpenAI API', endpoint: { ...BLANK, name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', contextLength: 128000, images: true } },
  { label: 'Other OpenAI-compatible server', endpoint: { ...BLANK, name: 'My server', kind: 'openai', baseUrl: 'http://127.0.0.1:8000/v1' } },
  { label: 'Other Anthropic-compatible server', endpoint: { ...BLANK, name: 'My server', kind: 'anthropic', baseUrl: 'http://127.0.0.1:8000' } },
];

/** A new endpoint's id from its name: lowercase words joined by "-", unique. */
function idFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/, '') || 'endpoint';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function renderEndpointSettings(app: App, el: HTMLElement, host: EndpointSettingsHost, redisplay: () => void): void {
  const list = host.endpoints();
  new Setting(el)
    .setName('Other servers')
    .setDesc(
      'OpenAI- or Anthropic-compatible servers: LM Studio, vLLM, llama.cpp, gateways, or a cloud API. Their models appear in the model picker. ' +
        'Chats with them are sent only to the address you give; a key, if any, stays in Obsidian’s secret storage.',
    )
    .addDropdown((d) => {
      d.addOption('', list.length >= MAX_ENDPOINTS ? 'No more can be added' : 'Add a server…');
      for (const [i, t] of TEMPLATES.entries()) d.addOption(String(i), t.label);
      d.setValue('').onChange((v) => {
        d.setValue('');
        const t = TEMPLATES[Number(v)];
        if (!t || list.length >= MAX_ENDPOINTS) return;
        const id = idFor(t.endpoint.name, new Set(list.map((e) => e.id)));
        new EndpointModal(app, host, { ...t.endpoint, id, models: [...t.endpoint.models] }, true, redisplay).open();
      });
    });

  for (const e of list) {
    new Setting(el)
      .setName(e.name)
      .setDesc(`${KIND_LABELS[e.kind]} · ${e.baseUrl}${e.secret ? ' · key: ' + e.secret : ''}`)
      .addButton((b) => b.setButtonText('Edit…').onClick(() => new EndpointModal(app, host, { ...e, models: [...e.models] }, false, redisplay).open()))
      .addButton((b) =>
        b
          .setButtonText('Remove')
          .setDestructive()
          .onClick(() => {
            void confirm(app, {
              title: `Remove ${e.name}?`,
              body: 'Its models leave the picker. Chats that used them keep their history but need another model to continue. The key stays in Obsidian’s secret storage.',
              action: 'Remove',
            }).then(async (ok) => {
              if (ok && (await host.save(host.endpoints().filter((x) => x.id !== e.id).map(copy)))) redisplay();
            });
          }),
      );
  }
}

const copy = (e: ReadonlyEndpoint): Endpoint => ({ ...e, models: [...e.models] });

class EndpointModal extends Modal {
  #draft: Endpoint;

  constructor(
    app: App,
    private readonly host: EndpointSettingsHost,
    start: Endpoint,
    private readonly isNew: boolean,
    private readonly saved: () => void,
  ) {
    super(app);
    this.#draft = start;
  }

  override onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.isNew ? 'Add a server' : `Edit ${this.#draft.name}`);
    const d = this.#draft;
    const set = (patch: Partial<Endpoint>) => {
      this.#draft = { ...this.#draft, ...patch };
    };
    const number = (setting: Setting, value: number, onValid: (n: number) => void) =>
      setting.addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(value)).onChange((v) => {
          const n = Number(v);
          if (Number.isInteger(n)) onValid(n);
        });
      });

    new Setting(contentEl).setName('Name').setDesc('Shown in the model picker.').addText((t) => t.setValue(d.name).onChange((v) => set({ name: v.trim() })));
    new Setting(contentEl).setName('Kind').addDropdown((dd) =>
      dd
        .addOptions(KIND_LABELS)
        .setValue(d.kind)
        .onChange((v) => {
          set({ kind: v as EndpointKind });
          this.render();
        }),
    );
    new Setting(contentEl)
      .setName('Address')
      .setDesc(d.kind === 'openai' ? 'The base URL up to and including /v1, as in http://127.0.0.1:1234/v1.' : 'The base URL without /v1, as in https://api.anthropic.com.')
      .addText((t) => t.setValue(d.baseUrl).onChange((v) => set({ baseUrl: v.trim() })));
    new Setting(contentEl)
      .setName('API key')
      .setDesc('Optional. Kept in Obsidian’s secret storage; Lektor stores only the secret’s name.')
      .addComponent((el) => new SecretComponent(this.app, el).setValue(d.secret).onChange((v) => set({ secret: v ?? '' })));
    number(new Setting(contentEl).setName('Context length').setDesc('Tokens per request, unless the server reports its own. Messages are checked against it.'), d.contextLength, (n) => set({ contextLength: n }));
    new Setting(contentEl)
      .setName('Tool calling')
      .setDesc('Turn off for models that can’t call tools; edits then come in fenced blocks.')
      .addToggle((t) => t.setValue(d.tools).onChange((v) => set({ tools: v })));
    new Setting(contentEl)
      .setName('Images')
      .setDesc('Whether its models can see images, unless the server says.')
      .addToggle((t) => t.setValue(d.images).onChange((v) => set({ images: v })));
    if (d.kind === 'anthropic') {
      number(new Setting(contentEl).setName('Output limit').setDesc('max_tokens for each reply, unless the model allows fewer.'), d.maxOutput, (n) => set({ maxOutput: n }));
      new Setting(contentEl)
        .setName('Show thinking')
        .setDesc('Ask Claude models for a readable summary of their thinking. Turn off for servers that reject the "thinking" field.')
        .addToggle((t) => t.setValue(d.thinking).onChange((v) => set({ thinking: v })));
    }
    new Setting(contentEl)
      .setName('Extra models')
      .setDesc('Model names to offer even if the server doesn’t list them, separated by commas.')
      .addText((t) =>
        t.setValue(d.models.join(', ')).onChange((v) =>
          set({
            models: v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          }),
        ),
      );

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('Test connection').onClick(() => {
          const e = this.valid();
          if (e) void this.host.check(e).then((m) => new Notice(`Lektor: ${m}`));
        }),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Save').setCta().onClick(() => void this.save()));
  }

  /** The draft as a valid endpoint, or null (after saying what's wrong). */
  private valid(): Endpoint | null {
    const url = normaliseBaseUrl(this.#draft.baseUrl);
    if (url === null) {
      new Notice('Lektor: enter an http:// or https:// address, without a query or credentials.');
      return null;
    }
    const parsed = EndpointSchema.safeParse({ ...this.#draft, baseUrl: url });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      new Notice(`Lektor: ${issue ? `${issuePath(issue.path) || 'endpoint'}: ${issue.message}` : 'that endpoint is not valid.'}`);
      return null;
    }
    return parsed.data;
  }

  private async save(): Promise<void> {
    const e = this.valid();
    if (!e) return;
    const others = this.host.endpoints().filter((x) => x.id !== e.id).map(copy);
    const list = this.isNew ? [...others, e] : this.host.endpoints().map((x) => (x.id === e.id ? e : copy(x)));
    if (await this.host.save(list)) {
      this.close();
      this.saved();
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
