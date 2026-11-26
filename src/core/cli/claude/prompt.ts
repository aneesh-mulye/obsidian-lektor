// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What Claude Code is given for one reply (DESIGN.md § Decided, before
 * milestone 10): a system-prompt file with Lektor's instructions and every
 * system message (the context, a preset's prompt), and one stdin user message
 * with the visible transcript and any images. stream-json input answers every
 * user line as a new turn, so earlier turns travel inside that one message.
 */

import type { ChatMessage } from '../../providers/types';

export const CLAUDE_CODE_INSTRUCTIONS =
  'You are the assistant in Lektor, a writing companion inside Obsidian, running through Claude Code. ' +
  'You have no access to files or a shell, and none is needed: the notes the user shared are below, and that is all of their vault you can see. ' +
  'If you need more of it, ask with the request_context tool; the user decides what to share. ' +
  'To change a note, propose edits with Lektor’s tools when they are offered; the user reviews every change, and nothing is applied without them. ' +
  'Answer in Markdown.';

/** The system-prompt file's text. */
export function systemPrompt(messages: readonly ChatMessage[]): string {
  const system = messages.flatMap((m) => (m.role === 'system' ? [m.content] : []));
  return [CLAUDE_CODE_INSTRUCTIONS, ...system].join('\n\n');
}

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** The one stream-json line sent on stdin. */
export function userLine(messages: readonly ChatMessage[]): string {
  const turns = messages.filter((m) => m.role !== 'system');
  const lastUser = turns.findLastIndex((m) => m.role === 'user' && !m.images?.length);
  const images: Block[] = turns.flatMap((m) =>
    m.role === 'user' ? (m.images ?? []).map((i): Block => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })) : [],
  );
  const earlier = turns
    .filter((m, i) => i !== lastUser && !(m.role === 'user' && m.images?.length))
    .map((m) =>
      m.role === 'assistant'
        ? { role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })) } : {}) }
        : m.role === 'tool'
          ? { role: 'tool', name: m.toolName, content: m.content }
          : { role: m.role, content: m.content },
    );
  const latest = lastUser === -1 ? '' : (turns[lastUser] as { content: string }).content;
  const imageNote = turns.flatMap((m) => (m.role === 'user' && m.images?.length ? [m.content] : []));
  const parts = [
    ...(earlier.length > 0 ? [`The conversation so far, oldest first (JSON; the assistant turns are yours):\n${JSON.stringify(earlier)}`, 'The user’s new message:'] : []),
    latest,
    ...imageNote,
  ];
  const content: Block[] = [...images, { type: 'text', text: parts.join('\n\n') }];
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}
