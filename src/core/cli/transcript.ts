// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How a CLI bridge hands the conversation to its CLI (INVARIANTS.md L7, C4):
 * one block per part, in a fixed order. Lektor's context and standing
 * instructions come first, then every visible turn, then this reply's own
 * instruction (a preset's prompt), if any. Every block is written the same way
 * wherever it sits, so the next message's blocks begin with this message's and
 * the CLI's prompt cache covers the whole earlier conversation.
 */

import type { ChatMessage } from '../providers/types';

/** Labels Lektor's own blocks, so the model never takes them for the user's words. */
export const FROM_LEKTOR = 'From Lektor:\n';
export const THIS_REPLY = 'From Lektor, for this reply only:\n';

/** Explains the layout to the model; part of each bridge's fixed instructions. */
export const TRANSCRIPT_FORMAT =
  'Everything arrives in one message, one block per part, in this order: blocks starting "From Lektor:" hold the notes the user shared and standing instructions; ' +
  'then the conversation so far, oldest first, one block per turn ("User:" blocks are the user’s, "Assistant:" blocks are your earlier replies with any tool calls you made, ' +
  'and "Tool result" blocks are what those tools returned); and last, possibly, a block starting "From Lektor, for this reply only:". ' +
  'Reply to the last "User:" block.';

/** One turn as its block's text: the same wherever the turn sits. */
export function turnBlock(m: ChatMessage): string {
  switch (m.role) {
    case 'system':
      return `${FROM_LEKTOR}${m.content}`;
    case 'user':
      return m.images && m.images.length > 0 ? `Attached images:\n${m.content}` : `User:\n${m.content}`;
    case 'assistant': {
      const calls = (m.toolCalls ?? []).map((c) => `\n[called ${c.name} with ${JSON.stringify(c.arguments ?? null)}]`).join('');
      return `Assistant:\n${m.content}${calls}`;
    }
    case 'tool':
      return `Tool result (${m.toolName}):\n${m.content}`;
  }
}

export type TranscriptBlock = { type: 'text'; text: string } | { type: 'image'; mime: string; data: string };

/**
 * The blocks for one request. System messages after the last turn are this reply's own
 * instructions and go last; every other message keeps its place, one block each (images
 * before their note).
 */
export function transcriptBlocks(messages: readonly ChatMessage[]): TranscriptBlock[] {
  const lastTurn = messages.findLastIndex((m) => m.role !== 'system');
  return messages.flatMap((m, i): TranscriptBlock[] => {
    if (m.role === 'system') return [{ type: 'text', text: i > lastTurn && lastTurn !== -1 ? `${THIS_REPLY}${m.content}` : `${FROM_LEKTOR}${m.content}` }];
    return [...(m.role === 'user' ? (m.images ?? []).map((im): TranscriptBlock => ({ type: 'image', mime: im.mime, data: im.data })) : []), { type: 'text', text: turnBlock(m) }];
  });
}
