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
import { FROM_LEKTOR, THIS_REPLY, TRANSCRIPT_FORMAT, transcriptBlocks, turnBlock } from '../transcript';

export { FROM_LEKTOR, THIS_REPLY, turnBlock };

export const CLAUDE_CODE_INSTRUCTIONS =
  'You are the assistant in Lektor, a writing companion inside Obsidian, running through Claude Code. ' +
  'You have no access to files or a shell, and none is needed: the notes the user shared are in the conversation, and that is all of their vault you can see. ' +
  'If you need more of it, ask with the request_context tool; the user decides what to share. ' +
  'To change a note, propose edits with Lektor’s tools when they are offered; the user reviews every change, and nothing is applied without them. ' +
  'Answer in Markdown.\n\n' +
  TRANSCRIPT_FORMAT;

/** The system-prompt file's text: always the same (INVARIANTS.md L7, L8). */
export function systemPrompt(): string {
  return CLAUDE_CODE_INSTRUCTIONS;
}

/** The one stream-json line sent on stdin (INVARIANTS.md L7). */
export function userLine(messages: readonly ChatMessage[]): string {
  const content = transcriptBlocks(messages).map((b) => (b.type === 'text' ? b : { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } }));
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}
