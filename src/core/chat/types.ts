// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ContextManifest } from '../context/prepare';
import type { ContextState } from '../context/state';
import type { ChatProvider, ModelRef } from '../providers/types';

export type ReplyStatus = 'streaming' | 'complete' | 'stopped' | 'truncated' | 'error';

export interface UserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
  readonly createdAt: number;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: 'assistant';
  readonly content: string;
  readonly reasoning: string;
  readonly status: ReplyStatus;
  readonly error?: string;
  readonly model: ModelRef;
  readonly createdAt: number;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  /** What context this reply was sent with: paths and hashes, never text. */
  readonly context?: ContextManifest;
  /** Lektor's estimate of the prompt, in tokens (before calibration). */
  readonly promptEstimate?: number;
  /** Key into Chat.sentContext, when full transcripts are stored. */
  readonly contextHash?: string;
  /** Something the user should know about this reply (e.g. the context was full). */
  readonly notice?: string;
}

export type Message = UserMessage | AssistantMessage;

export interface Chat {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly model: ModelRef | null;
  readonly messages: readonly Message[];
  /** The chips: what the model is sent with each message. */
  readonly context: ContextState;
  /** Context text actually sent, by hash. Only kept with "store full transcripts" on. */
  readonly sentContext?: Readonly<Record<string, string>>;
}

export interface Clock {
  now(): number;
}

export interface ProviderLookup {
  get(id: string): ChatProvider | undefined;
}
