// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChatMessage } from '../providers/types';
import type { Message } from './types';

/**
 * What the model is sent for a transcript (INVARIANTS.md C1): user messages,
 * plus assistant replies with visible text that finished, were stopped or were
 * cut off. Failed replies and reasoning are never sent back.
 */
export function toRequestMessages(messages: readonly Message[]): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === 'user') return [{ role: 'user', content: m.content }];
    if (m.content !== '' && (m.status === 'complete' || m.status === 'stopped' || m.status === 'truncated')) {
      return [{ role: 'assistant', content: m.content }];
    }
    return [];
  });
}

/** A chat title from its first message: first line, at most 50 characters, cut at a word. */
export function titleFrom(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').trim();
  if (line.length <= 50) return line;
  const head = line.slice(0, 51);
  const space = head.lastIndexOf(' ');
  return `${(space > 20 ? head.slice(0, space) : line.slice(0, 50)).trimEnd()}…`;
}
