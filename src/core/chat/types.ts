// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ContextManifest } from '../context/prepare';
import type { ContextState } from '../context/state';
import type { Capabilities, ChatProvider, ModelRef, ToolCall, ToolDefinition } from '../providers/types';
import type { ApprovalRequest, StepResult } from '../tools/types';

export type ReplyStatus = 'streaming' | 'complete' | 'stopped' | 'truncated' | 'error';

export interface UserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
  readonly createdAt: number;
}

/** One tool call within a reply, and its result once it has run. */
export interface ToolStep {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly result?: StepResult;
}

/** A round of the tool loop: what the model said, then the tools it called. */
export interface ToolRound {
  readonly text: string;
  readonly calls: readonly ToolStep[];
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
  /** Tool rounds before the final answer (`content`). */
  readonly steps?: readonly ToolRound[];
  /** An approval the reply is waiting for (never saved). */
  readonly approval?: { readonly id: string } & ApprovalRequest;
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
  /** The per-chat tools switch (the globe); tools are on unless this is true. */
  readonly toolsDisabled?: boolean;
}

/** The tools available to one reply: definitions to offer, and a way to run calls. One per user message. */
export interface ToolRun {
  definitions: ToolDefinition[];
  execute(call: ToolCall, signal: AbortSignal, approve: (request: ApprovalRequest) => Promise<boolean>): Promise<StepResult>;
}

export interface ToolsDeps {
  /** Null when this chat or model gets no tools. */
  forReply(input: { chat: Chat; capabilities: Capabilities; contextUrls: readonly string[] }): ToolRun | null;
}

export interface Clock {
  now(): number;
}

export interface ProviderLookup {
  get(id: string): ChatProvider | undefined;
}
