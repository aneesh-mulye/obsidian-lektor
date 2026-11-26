// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

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
}

export type Message = UserMessage | AssistantMessage;

export interface Chat {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly model: ModelRef | null;
  readonly messages: readonly Message[];
}

export interface Clock {
  now(): number;
}

export interface ProviderLookup {
  get(id: string): ChatProvider | undefined;
}
