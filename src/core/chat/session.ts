// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One chat: the transcript, the reply being streamed, stop and regenerate
 * (INVARIANTS.md C1–C5). The model sees exactly the visible transcript; there
 * is never more than one live stream; a stopped reply is final.
 */

import type { ChatEvent, ModelRef } from '../providers/types';
import { titleFrom, toRequestMessages } from './transcript';
import type { AssistantMessage, Chat, Clock, Message, ProviderLookup } from './types';

export interface SessionDeps {
  providers: ProviderLookup;
  clock: Clock;
  newId: () => string;
  /** Persist the chat. Called after every user action and when a reply ends. */
  save: (chat: Chat) => Promise<void>;
  onSaveError?: (err: unknown) => void;
}

export class ChatSession {
  #chat: Chat;
  /** Bumped whenever the live stream is abandoned; events from older runs are ignored. */
  #run = 0;
  #busy = false;
  #controller: AbortController | null = null;
  #saving: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();

  constructor(
    chat: Chat,
    private readonly deps: SessionDeps,
  ) {
    this.#chat = chat;
  }

  get chat(): Chat {
    return this.#chat;
  }

  get busy(): boolean {
    return this.#busy;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Send a user message. Returns false (and does nothing) while busy or for blank text. */
  send(text: string): boolean {
    if (this.#busy || text.trim() === '') return false;
    const user: Message = { id: this.deps.newId(), role: 'user', content: text, createdAt: this.deps.clock.now() };
    if (this.#chat.messages.length === 0) this.#set({ ...this.#chat, title: titleFrom(text) });
    this.#start([...this.#chat.messages, user]);
    return true;
  }

  /** Replace the last reply with a new one. Returns false while busy or if the last message is not a reply. */
  regenerate(): boolean {
    if (this.#busy || this.#chat.messages.at(-1)?.role !== 'assistant') return false;
    this.#start(this.#chat.messages.slice(0, -1));
    return true;
  }

  /** Stop the live reply. It keeps what it has so far and never changes again. */
  stop(): void {
    if (!this.#busy) return;
    this.#run += 1;
    this.#controller?.abort();
    this.#controller = null;
    this.#updateReply((r) => (r.status === 'streaming' ? { ...r, status: 'stopped' } : r));
    this.#busy = false;
    this.#emit();
    this.#persist();
  }

  /** Use another model from the next message on. */
  setModel(model: ModelRef): void {
    this.#set({ ...this.#chat, model });
    this.#emit();
    if (this.#chat.messages.length > 0) this.#persist();
  }

  // -------------------------------------------------------------------------

  #start(history: readonly Message[]): void {
    const model = this.#chat.model;
    const reply: AssistantMessage = {
      id: this.deps.newId(),
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
      model: model ?? { provider: 'none', model: 'none' },
      createdAt: this.deps.clock.now(),
    };
    this.#set({ ...this.#chat, messages: [...history, reply] });
    this.#busy = true;
    const run = ++this.#run;
    const controller = new AbortController();
    this.#controller = controller;
    this.#emit();
    this.#persist();
    void this.#pump(run, model, history, controller.signal);
  }

  async #pump(run: number, model: ModelRef | null, history: readonly Message[], signal: AbortSignal): Promise<void> {
    const live = () => run === this.#run && this.#busy;
    let iterator: AsyncIterator<ChatEvent> | undefined;
    let pendingError: string | undefined;
    try {
      if (!model) throw new Error('Pick a model first.');
      const provider = this.deps.providers.get(model.provider);
      if (!provider) throw new Error(`The ${model.provider} backend is not available.`);
      // Fail closed: no stream unless the model's capabilities are known (DESIGN.md § The two hard rules).
      await provider.capabilities(model.model);
      if (!live()) return;

      iterator = provider.stream({ model: model.model, messages: toRequestMessages(history) }, signal)[Symbol.asyncIterator]();
      for (;;) {
        const step = await iterator.next();
        if (!live()) return;
        if (step.done) {
          this.#end('error', pendingError ?? 'The reply ended before it finished.');
          return;
        }
        const event = step.value;
        switch (event.type) {
          case 'text':
            this.#updateReply((r) => ({ ...r, content: r.content + event.text }));
            break;
          case 'reasoning':
            this.#updateReply((r) => ({ ...r, reasoning: r.reasoning + event.text }));
            break;
          case 'usage':
            this.#updateReply((r) => ({
              ...r,
              usage: {
                ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
                ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              },
            }));
            break;
          case 'error':
            pendingError = event.message;
            break;
          case 'done':
            if (event.reason === 'stop') this.#end('complete');
            else if (event.reason === 'length') this.#end('truncated');
            else if (event.reason === 'aborted') this.#end('stopped');
            else this.#end('error', pendingError ?? 'The reply failed.');
            return;
        }
        this.#emit();
      }
    } catch (err) {
      if (live()) this.#end('error', err instanceof Error && err.message ? err.message : 'The reply failed.');
    } finally {
      // The stream is finished or abandoned; let it clean up, but never wait on it.
      try {
        void iterator?.return?.();
      } catch {
        // ignore
      }
    }
  }

  #end(status: AssistantMessage['status'], error?: string): void {
    this.#updateReply((r) => ({ ...r, status, ...(error !== undefined ? { error } : {}) }));
    this.#busy = false;
    this.#controller = null;
    this.#emit();
    this.#persist();
  }

  #updateReply(fn: (r: AssistantMessage) => AssistantMessage): void {
    const messages = this.#chat.messages;
    const last = messages.at(-1);
    if (last?.role !== 'assistant') return;
    this.#set({ ...this.#chat, messages: [...messages.slice(0, -1), fn(last)] });
  }

  #set(chat: Chat): void {
    this.#chat = { ...chat, updatedAt: this.deps.clock.now() };
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }

  #persist(): void {
    if (this.#chat.messages.length === 0) return;
    const snapshot = this.#chat;
    this.#saving = this.#saving
      .then(() => this.deps.save(snapshot))
      .catch((err: unknown) => this.deps.onSaveError?.(err));
  }
}
