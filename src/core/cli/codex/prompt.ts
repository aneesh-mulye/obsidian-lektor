// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What Codex is given for one reply (INVARIANTS.md C4): Lektor's fixed
 * instructions in the instructions file, which replace Codex's own, and the
 * conversation as one stdin prompt in the same block format as Claude Code's
 * (src/core/cli/transcript.ts), with context images as files. The prompt for
 * the next message begins with this one's, so Codex's prompt cache covers the
 * earlier conversation.
 */

import type { ChatMessage } from '../../providers/types';
import { TRANSCRIPT_FORMAT, transcriptBlocks } from '../transcript';

export const CODEX_INSTRUCTIONS =
  'You are the assistant in Lektor, a writing companion inside Obsidian, running through Codex. ' +
  'You have no access to files or a shell, and none is needed: the notes the user shared are in the conversation, and that is all of their vault you can see. ' +
  'If you need more of it, ask with the request_context tool; the user decides what to share. ' +
  'To change a note, propose edits with Lektor’s tools when they are offered (call them from code); the user reviews every change, and nothing is applied without them. ' +
  'Answer in Markdown.\n\n' +
  TRANSCRIPT_FORMAT;

export interface CodexPrompt {
  /** The stdin text. */
  text: string;
  /** Context images, in order (written as files and passed with --image). */
  images: Array<{ mime: string; data: string }>;
}

export function codexPrompt(messages: readonly ChatMessage[]): CodexPrompt {
  const blocks = transcriptBlocks(messages);
  return {
    text: blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n'),
    images: blocks.flatMap((b) => (b.type === 'image' ? [{ mime: b.mime, data: b.data }] : [])),
  };
}
