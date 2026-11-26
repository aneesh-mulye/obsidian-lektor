// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One chat: the transcript, the reply being streamed, stop and regenerate
 * (INVARIANTS.md C1–C5). The model sees exactly the visible transcript; there
 * is never more than one live stream; a stopped reply is final.
 */

import { type ContextManifest, type PreparedContext, recordSent, sha256 } from '../context/prepare';
import type { ContextState } from '../context/state';
import { MESSAGE_OVERHEAD, estimateTokens, fits, formatTokens } from '../context/tokens';
import type { ChatEvent, ChatMessage, ModelRef } from '../providers/types';
import { titleFrom, toRequestMessages } from './transcript';
import type { AssistantMessage, Chat, Clock, Message, ProviderLookup } from './types';

export interface SessionDeps {
  providers: ProviderLookup;
  clock: Clock;
  newId: () => string;
  /** Persist the chat. Called after every user action and when a reply ends. */
  save: (chat: Chat) => Promise<void>;
  onSaveError?: (err: unknown) => void;
  /** Build the context message for the chat's chips (INVARIANTS.md X2). Failure means nothing is sent. */
  prepare?: (state: ContextState) => Promise<PreparedContext>;
  /** Whether to keep the context text sent with each reply ("store full transcripts"). */
  storeFullTranscripts?: () => boolean;
}

/** Calibration is the ratio of real to estimated prompt tokens, kept between 1 and 4. */
const clampCalibration = (r: number) => Math.min(4, Math.max(1, r));

export class ChatSession {
  #chat: Chat;
  /** Bumped whenever the live stream is abandoned; events from older runs are ignored. */
  #run = 0;
  #busy = false;
  #controller: AbortController | null = null;
  #saving: Promise<void> = Promise.resolve();
  /** Real ÷ estimated prompt tokens from the last finished reply (INVARIANTS.md C6). */
  #calibration = 1;
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

  /** Replace the chat's context (the chips). */
  setContext(context: ContextState): void {
    if (context === this.#chat.context) return;
    this.#set({ ...this.#chat, context });
    this.#emit();
    if (this.#chat.messages.length > 0) this.#persist();
  }

  get calibration(): number {
    return this.#calibration;
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
      const caps = await provider.capabilities(model.model);
      if (!live()) return;
      const window = caps.contextWindow;
      // The context is read fresh for every message; if it can't be, nothing is sent.
      const prepared = this.deps.prepare ? await this.deps.prepare(this.#chat.context) : null;
      if (!live()) return;

      const transcript = toRequestMessages(history);
      const estimate = (prepared?.tokens ?? 0) + transcript.reduce((t, m) => t + estimateTokens(m.content) + MESSAGE_OVERHEAD, 0);
      if (!fits(estimate, this.#calibration, window)) {
        this.#end('error', tooLong(Math.ceil(estimate * this.#calibration), window));
        return;
      }
      const messages: ChatMessage[] = prepared?.message ? [{ role: 'system', content: prepared.message }, ...transcript] : transcript;
      await this.#recordContext(prepared, estimate);
      if (!live()) return;

      iterator = provider.stream({ model: model.model, messages }, signal)[Symbol.asyncIterator]();
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
            if (event.reason === 'stop' || event.reason === 'length') this.#calibrate(window);
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

  /** Note on the reply what it was sent with; with full transcripts on, keep the text too. */
  async #recordContext(prepared: PreparedContext | null, estimate: number): Promise<void> {
    let contextHash: string | undefined;
    if (prepared?.message && this.deps.storeFullTranscripts?.()) {
      contextHash = await sha256(prepared.message);
      this.#set({ ...this.#chat, sentContext: { ...(this.#chat.sentContext ?? {}), [contextHash]: prepared.message } });
    }
    const manifest: ContextManifest | undefined = prepared?.manifest;
    this.#updateReply((r) => ({
      ...r,
      promptEstimate: estimate,
      ...(manifest ? { context: manifest } : {}),
      ...(contextHash ? { contextHash } : {}),
    }));
    if (manifest) this.#set({ ...this.#chat, context: recordSent(this.#chat.context, manifest) });
    this.#emit();
  }

  /** Learn from the real prompt size the backend reported; warn if the context was full. */
  #calibrate(window: number): void {
    const reply = this.#chat.messages.at(-1);
    if (reply?.role !== 'assistant') return;
    const input = reply.usage?.inputTokens;
    if (input === undefined || !reply.promptEstimate) return;
    this.#calibration = clampCalibration(input / reply.promptEstimate);
    if (input + (reply.usage?.outputTokens ?? 0) >= window * 0.98) {
      this.#updateReply((r) => ({ ...r, notice: 'This filled the model’s context length, so the model may not have seen all of the conversation.' }));
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

function tooLong(tokens: number, window: number): string {
  return (
    `This message and its context come to about ${formatTokens(tokens)} tokens, which, with room for the reply, ` +
    `doesn't fit the model's context length of ${formatTokens(window)}. Remove some context, start a new chat, ` +
    'or raise the context length in Lektor’s settings.'
  );
}
