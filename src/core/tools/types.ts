// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Tools (DESIGN.md § Tools framework). Adding one is one file and one registration line. */

import type { z } from 'zod';
import type { ModelAccepts } from '../context/attachments';
import type { ContextManifest } from '../context/prepare';
import type { ContextState } from '../context/state';
import type { ChatImage, ModelRef } from '../providers/types';
import type { AttachmentMode } from '../settings';
import type { FindingSet } from '../findings/findings';
import type { Proposal } from '../review/types';
import type { KnownUrls } from './urls';

export type ToolApproval = 'never' | 'ask' | 'per-session';

export interface ApprovalRequest {
  tool: string;
  /** A short question, e.g. "Fetch a page the model chose?". */
  title: string;
  /** What exactly would happen, e.g. the full URL. */
  detail: string;
  /** For a choice: the items, each with a checkbox (all ticked unless it can't be sent). */
  items?: readonly ApprovalItem[];
  /** For a choice: a line under the items, e.g. "2 excluded notes skipped". */
  note?: string;
}

export interface ApprovalItem {
  id: string;
  kind: 'note' | 'attachment';
  /** The vault path. */
  label: string;
  /** Estimated tokens. */
  tokens: number;
  /** Why it can't be sent (no tick box), if it can't. */
  unavailable?: string;
}

/** A request_context call's view of the chat's context. */
export interface ContextScope {
  state: ContextState;
  /** The setting, for chats that never chose an attachment mode. */
  fallbackMode: AttachmentMode;
  accepts: ModelAccepts;
}

export interface ToolContext {
  signal: AbortSignal;
  /** URLs seen in this chat's search results, the user's messages and attached notes. */
  knownUrls: KnownUrls;
  /** Show an approval card and wait for the user. */
  approve(request: ApprovalRequest): Promise<boolean>;
  /** Show a card listing items with checkboxes and wait; resolves to the ids the user ticked ([] for Deny or Stop). */
  choose?(request: ApprovalRequest & { items: readonly ApprovalItem[] }): Promise<readonly string[]>;
  /** The chat's context, for request_context. */
  context?: ContextScope;
  /** Notes the model may propose edits to: those in this reply's context (DESIGN.md § Edits). */
  editable: ReadonlySet<string>;
  /** The model this reply comes from. */
  model: ModelRef | null;
}

export interface ToolOutcome {
  /** What the model is sent. */
  content: string;
  /** One line for the chat, e.g. `"skerryvore height" · 5 results`. */
  summary: string;
  /** URLs this result makes known (search results). */
  urls?: string[];
  /** A proposal for the user to review (propose_edit, propose_note). */
  proposal?: Proposal;
  /** Findings to show in the note and the chat (report_findings). */
  findings?: FindingSet;
  /**
   * What the model is sent for the rest of this reply instead of `content`, which is what chat
   * history keeps (request_context: the shared text, while history keeps only the paths).
   */
  transient?: Transient;
  /** Notes and attachments the user shared, which become chips. */
  shared?: Shared;
}

export interface Transient {
  content: string;
  /** Images, sent in a user message after the round's tool results. */
  images?: readonly (ChatImage & { path: string })[];
}

export interface Shared {
  notes: readonly string[];
  attachments: readonly string[];
  /** For the reply's manifest. */
  manifest: Pick<ContextManifest, 'notes'> & { attachments: NonNullable<ContextManifest['attachments']> };
}

export interface Tool<A = unknown> {
  name: string;
  /** Shown to the model. */
  description: string;
  /** Validated before `run` is ever called (INVARIANTS.md T1). */
  schema: z.ZodType<A>;
  approval: ToolApproval;
  /** If true, the tool must go through ContextBroker; no milestone-4 tool does. */
  touchesVault: boolean;
  /** Which per-message cap a call counts against. */
  cap?: 'searches' | 'fetches';
  run(args: A, ctx: ToolContext): Promise<ToolOutcome>;
}

/** A failure the model should hear about (its message is sent as the tool result). */
export class ToolError extends Error {
  override name = 'ToolError';
}

export interface StepResult {
  ok: boolean;
  content: string;
  summary: string;
  /** The call was refused because a per-message cap was reached. */
  limit?: boolean;
  urls?: string[];
  /** The proposal this call made, kept in the chat (`Chat.proposals`). */
  proposalId?: string;
  /** Only in flight: the session moves it into the chat and keeps `proposalId`. */
  proposal?: Proposal;
  /** The findings this call reported, kept in the chat (`Chat.findings`). */
  findingsId?: string;
  /** Only in flight: the session moves them into the chat and keeps `findingsId`. */
  findings?: FindingSet;
  /** Only in flight: what the model gets this reply (never saved). */
  transient?: Transient;
  /** Only in flight: the session turns these into chips and adds them to the reply's manifest. */
  shared?: Shared;
  /** With "store full transcripts" on: key into Chat.sentContext for the transient text. */
  contextHash?: string;
}
