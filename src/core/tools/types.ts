// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Tools (DESIGN.md § Tools framework). Adding one is one file and one registration line. */

import type { z } from 'zod';
import type { ModelRef } from '../providers/types';
import type { Proposal } from '../review/types';
import type { KnownUrls } from './urls';

export type ToolApproval = 'never' | 'ask' | 'per-session';

export interface ApprovalRequest {
  tool: string;
  /** A short question, e.g. "Fetch a page the model chose?". */
  title: string;
  /** What exactly would happen, e.g. the full URL. */
  detail: string;
}

export interface ToolContext {
  signal: AbortSignal;
  /** URLs seen in this chat's search results, the user's messages and attached notes. */
  knownUrls: KnownUrls;
  /** Show an approval card and wait for the user. */
  approve(request: ApprovalRequest): Promise<boolean>;
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
}
