// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The sidebar's chat state: the open chat, starting and switching chats, history. */

import { prepareContext } from '../context/prepare';
import { EMPTY_CONTEXT } from '../context/state';
import { type ContextDeps, ContextController } from './ContextController';
import type { ModelRef } from '../providers/types';
import type { ChatHistory, ChatSummary } from './history';
import { ChatSession } from './session';
import type { Chat, Clock, ProviderLookup, ToolsDeps } from './types';

export interface ManagerDeps {
  providers: ProviderLookup;
  clock: Clock;
  newId: () => string;
  history: ChatHistory;
  defaultModel: () => ModelRef | null;
  setDefaultModel: (model: ModelRef) => Promise<void>;
  onError: (message: string, err?: unknown) => void;
  /** The context system; without it, chats carry no context. */
  context?: ContextDeps;
  /** Whether to keep the context text sent with each reply ("store full transcripts"). */
  storeFullTranscripts?: () => boolean;
  /** Tools for each reply. */
  tools?: ToolsDeps;
}

export interface ChatSnapshot {
  readonly chat: Chat;
  readonly busy: boolean;
}

export class ChatManager {
  #session: ChatSession;
  #unsubscribe: () => void = () => {};
  #snapshot: ChatSnapshot;
  readonly #listeners = new Set<() => void>();
  /** Chips for the open chat; null when there is no context system. */
  readonly context: ContextController | null;

  constructor(private readonly deps: ManagerDeps) {
    this.#session = this.#attach(this.#blank());
    this.context = deps.context ? new ContextController(() => this.#session, deps.context) : null;
    this.#snapshot = this.#take();
    this.context?.activeChanged();
  }

  get session(): ChatSession {
    return this.#session;
  }

  /** Stable between changes, for React's useSyncExternalStore. */
  readonly snapshot = (): ChatSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Start an empty chat with the default model. A reply in progress is stopped and kept. */
  newChat(): void {
    this.#session.stop();
    this.#switch(this.#blank());
    this.context?.activeChanged();
  }

  async open(id: string): Promise<boolean> {
    const chat = await this.deps.history.load(id);
    if (!chat) {
      this.deps.onError('That chat could not be read.');
      return false;
    }
    this.#session.stop();
    this.#switch(chat);
    await this.context?.restore();
    return true;
  }

  list(): Promise<{ chats: ChatSummary[]; unreadable: number }> {
    return this.deps.history.list();
  }

  async delete(id: string): Promise<void> {
    if (this.#session.chat.id === id) this.newChat();
    await this.deps.history.delete(id);
  }

  async clearAll(): Promise<void> {
    this.newChat();
    await this.deps.history.clearAll();
  }

  /** Use a model for this chat, and remember it for new chats. */
  async pickModel(model: ModelRef): Promise<void> {
    this.#session.setModel(model);
    await this.deps.setDefaultModel(model);
  }

  dispose(): void {
    this.#session.stop();
    this.#unsubscribe();
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------

  #blank(): Chat {
    const now = this.deps.clock.now();
    return { id: this.deps.newId(), title: '', createdAt: now, updatedAt: now, model: this.deps.defaultModel(), messages: [], context: EMPTY_CONTEXT };
  }

  #attach(chat: Chat): ChatSession {
    const session = new ChatSession(chat, {
      providers: this.deps.providers,
      clock: this.deps.clock,
      newId: this.deps.newId,
      save: (c) => this.deps.history.save(c),
      onSaveError: (err) => this.deps.onError('Could not save the chat.', err),
      ...(this.deps.context ? { prepare: (state) => prepareContext(state, this.deps.context!.index) } : {}),
      ...(this.deps.storeFullTranscripts ? { storeFullTranscripts: this.deps.storeFullTranscripts } : {}),
      ...(this.deps.tools ? { tools: this.deps.tools } : {}),
    });
    this.#unsubscribe();
    this.#unsubscribe = session.subscribe(() => this.#changed());
    return session;
  }

  #switch(chat: Chat): void {
    this.#session = this.#attach(chat);
    this.#changed();
  }

  #take(): ChatSnapshot {
    return { chat: this.#session.chat, busy: this.#session.busy };
  }

  #changed(): void {
    this.#snapshot = this.#take();
    for (const l of this.#listeners) l();
  }
}
