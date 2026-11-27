// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What Claude Code is given for one reply (DESIGN.md § Decided, after
 * milestone 10): a constant system-prompt file (Lektor's instructions only),
 * and one stdin user message holding everything else, one block each:
 * Lektor's context and standing instructions first, then every visible turn,
 * then this reply's own instruction (a preset's prompt), if any. stream-json
 * input answers every user line as a new turn, so earlier turns travel
 * inside that one message.
 *
 * Every block is written the same way wherever it sits, so the next message's
 * blocks begin with this message's and Claude Code's prompt cache covers the
 * whole earlier conversation (INVARIANTS.md L7). The prompt file never holds a
 * note, so a process started ahead of time is never stale (L8).
 */

import type { ChatMessage } from '../../providers/types';

/** Labels Lektor's own blocks, so the model never takes them for the user's words. */
export const FROM_LEKTOR = 'From Lektor:\n';
export const THIS_REPLY = 'From Lektor, for this reply only:\n';

export const CLAUDE_CODE_INSTRUCTIONS =
  'You are the assistant in Lektor, a writing companion inside Obsidian, running through Claude Code. ' +
  'You have no access to files or a shell, and none is needed: the notes the user shared are in the conversation, and that is all of their vault you can see. ' +
  'If you need more of it, ask with the request_context tool; the user decides what to share. ' +
  'To change a note, propose edits with Lektor’s tools when they are offered; the user reviews every change, and nothing is applied without them. ' +
  'Answer in Markdown.\n\n' +
  'Everything arrives in one message, one block per part, in this order: blocks starting "From Lektor:" hold the notes the user shared and standing instructions; ' +
  'then the conversation so far, oldest first, one block per turn ("User:" blocks are the user’s, "Assistant:" blocks are your earlier replies with any tool calls you made, ' +
  'and "Tool result" blocks are what those tools returned); and last, possibly, a block starting "From Lektor, for this reply only:". ' +
  'Reply to the last "User:" block.';

/** The system-prompt file's text: always the same (INVARIANTS.md L7, L8). */
export function systemPrompt(): string {
  return CLAUDE_CODE_INSTRUCTIONS;
}

/** One turn as its block's text: the same wherever the turn sits (INVARIANTS.md L7). */
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

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * The one stream-json line sent on stdin. System messages after the last turn are this reply's own
 * instructions and go last; every other message keeps its place, one block each (images before
 * their note).
 */
export function userLine(messages: readonly ChatMessage[]): string {
  const lastTurn = messages.findLastIndex((m) => m.role !== 'system');
  const content: Block[] = messages.flatMap((m, i): Block[] => {
    if (m.role === 'system') return [{ type: 'text', text: i > lastTurn && lastTurn !== -1 ? `${THIS_REPLY}${m.content}` : `${FROM_LEKTOR}${m.content}` }];
    return [
      ...(m.role === 'user' ? (m.images ?? []).map((im): Block => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })) : []),
      { type: 'text', text: turnBlock(m) },
    ];
  });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}
