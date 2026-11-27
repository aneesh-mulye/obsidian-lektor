// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What Claude Code is given for one reply (DESIGN.md § Decided, before
 * milestone 10): a system-prompt file with Lektor's instructions and every
 * system message (the context, a preset's prompt), and one stdin user message
 * with the visible transcript and any images. stream-json input answers every
 * user line as a new turn, so earlier turns travel inside that one message.
 *
 * Each turn is its own text block, written the same way wherever it sits, so
 * the next message's blocks begin with this message's blocks and Claude
 * Code's prompt cache covers the whole earlier conversation
 * (INVARIANTS.md L7). Nothing about the transcript goes in the system prompt.
 */

import type { ChatMessage } from '../../providers/types';

export const CLAUDE_CODE_INSTRUCTIONS =
  'You are the assistant in Lektor, a writing companion inside Obsidian, running through Claude Code. ' +
  'You have no access to files or a shell, and none is needed: the notes the user shared are below, and that is all of their vault you can see. ' +
  'If you need more of it, ask with the request_context tool; the user decides what to share. ' +
  'To change a note, propose edits with Lektor’s tools when they are offered; the user reviews every change, and nothing is applied without them. ' +
  'Answer in Markdown.\n\n' +
  'The conversation so far arrives in one message, one block per turn, oldest first: "User:" blocks are the user’s, "Assistant:" blocks are your earlier replies ' +
  '(with any tool calls you made), and "Tool result" blocks are what those tools returned. Reply to the last "User:" block.';

/** The system-prompt file's text: Lektor's instructions and the system messages. Never the transcript. */
export function systemPrompt(messages: readonly ChatMessage[]): string {
  const system = messages.flatMap((m) => (m.role === 'system' ? [m.content] : []));
  return [CLAUDE_CODE_INSTRUCTIONS, ...system].join('\n\n');
}

/** One turn as its block's text: the same wherever the turn sits (INVARIANTS.md L7). */
export function turnBlock(m: ChatMessage): string {
  switch (m.role) {
    case 'system':
      return `System:\n${m.content}`;
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

/** The one stream-json line sent on stdin: every visible turn, in order, one block each (images before their note). */
export function userLine(messages: readonly ChatMessage[]): string {
  const content: Block[] = messages
    .filter((m) => m.role !== 'system')
    .flatMap((m): Block[] => [
      ...(m.role === 'user' ? (m.images ?? []).map((i): Block => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })) : []),
      { type: 'text', text: turnBlock(m) },
    ]);
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}
