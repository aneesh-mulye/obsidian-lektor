// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ContextManifest } from '../context/prepare';
import type { FindingSet } from '../findings/findings';
import type { Preset } from '../presets/preset';
import type { ContextState } from '../context/state';
import type { Capabilities, ChatProvider, ModelRef, ToolCall, ToolDefinition } from '../providers/types';
import type { Proposal } from '../review/types';
import type { DisplayMode } from '../settings';
import type { ApprovalItem, ApprovalRequest, StepResult } from '../tools/types';

export type ReplyStatus = 'streaming' | 'complete' | 'stopped' | 'truncated' | 'error';

export interface UserMessage {
  readonly id: string;
  readonly role: 'user';
  /** What the user typed (for a preset run, anything typed after the slash command; may be empty). */
  readonly content: string;
  readonly createdAt: number;
  /** A preset run: the preset as it was when it ran, so regenerating sends the same request (DESIGN.md § Presets). */
  readonly preset?: Preset;
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
  /** Proposals made through fenced `lektor-edit` blocks in this reply (models without tool calling). */
  readonly fencedProposals?: readonly string[];
  /** Findings reported through fenced `lektor-findings` blocks in this reply. */
  readonly fencedFindings?: readonly string[];
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
  /** Proposals made in this chat, by id; their cards appear where the model made them. */
  readonly proposals?: Readonly<Record<string, Proposal>>;
  /** How this chat shows proposals (the header toggle). Chats saved before milestone 6 use the setting. */
  readonly displayMode?: DisplayMode;
  /** Findings reported in this chat, by id; their lists appear where the model reported them. */
  readonly findings?: Readonly<Record<string, FindingSet>>;
}

/** The chat's display mode, or the setting's default for chats that never chose one. */
export function displayModeOf(chat: Chat, fallback: DisplayMode): DisplayMode {
  return chat.displayMode ?? fallback;
}

/** The tools available to one reply: definitions to offer, and a way to run calls. One per user message. */
export interface ToolRun {
  definitions: ToolDefinition[];
  execute(call: ToolCall, signal: AbortSignal, approve: (request: ApprovalRequest) => Promise<boolean>, extra?: ToolExtras): Promise<StepResult>;
  /**
   * For models without tool calling: instructions for proposing edits (or reporting findings) in
   * fenced blocks, and a way to turn a finished reply's blocks into proposals and findings.
   */
  fenced?: {
    instructions: string;
    extract(reply: string): Promise<{ proposals: Proposal[]; findings?: FindingSet[]; problems: string[] }>;
  };
  /** A system instruction for this reply (Prose mode: describe changes in words). */
  instructions?: string;
}

/** What a reply's tools can use beyond a yes/no card (request_context). */
export interface ToolExtras {
  /** A card with checkboxes; resolves to the ids the user ticked ([] for Deny or Stop). */
  choose?: (request: ApprovalRequest & { items: readonly ApprovalItem[] }) => Promise<readonly string[]>;
  /** The chat's chips as they are now (they grow as the user shares more during the reply). */
  context?: () => ContextState;
}

export interface ToolsDeps {
  /** Null when this chat or model gets no tools. */
  forReply(input: {
    chat: Chat;
    capabilities: Capabilities;
    contextUrls: readonly string[];
    /** Notes in this reply's context, which the model may propose edits to. */
    editable: readonly string[];
    /** The preset this reply runs, if any: its output decides the review tools, and its tools and caps apply. */
    preset?: Preset;
  }): ToolRun | null;
}

export interface Clock {
  now(): number;
}

export interface ProviderLookup {
  get(id: string): ChatProvider | undefined;
}
