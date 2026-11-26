// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChatImage, ChatMessage } from '../providers/types';
import type { Transient } from '../tools/types';
import type { Message, ToolRound } from './types';

/**
 * What the model is sent for a transcript (INVARIANTS.md C1): user messages,
 * plus assistant replies with visible text that finished, were stopped or were
 * cut off. Failed replies and reasoning are never sent back.
 */
export function toRequestMessages(messages: readonly Message[]): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === 'user') return [{ role: 'user', content: m.content }];
    if (m.status !== 'complete' && m.status !== 'stopped' && m.status !== 'truncated') return [];
    const out = roundMessages(m.steps ?? []);
    if (m.content !== '') out.push({ role: 'assistant', content: m.content });
    return out;
  });
}

/**
 * Tool rounds as the model saw them (INVARIANTS.md C7): each round's text with
 * the calls that finished, then one tool message per finished call. Calls
 * that never got a result (the user stopped) are left out.
 */
export function roundMessages(rounds: readonly ToolRound[], live?: ReadonlyMap<string, Transient>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const round of rounds) {
    const done = round.calls.filter((c) => c.result !== undefined);
    if (done.length === 0) {
      if (round.text !== '') out.push({ role: 'assistant', content: round.text });
      continue;
    }
    out.push({ role: 'assistant', content: round.text, toolCalls: done.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) });
    // Within the reply that made them, results such as shared notes are sent in full (INVARIANTS.md A4).
    for (const c of done) out.push({ role: 'tool', content: live?.get(c.id)?.content ?? c.result!.content, toolName: c.name, toolCallId: c.id });
    const images = done.flatMap((c) => live?.get(c.id)?.images ?? []);
    if (images.length > 0) out.push(imagesMessage(images));
  }
  return out;
}

/** Images from the vault, in one user message after the context or the tool results that mention them. */
export function imagesMessage(images: readonly (ChatImage & { path: string })[]): ChatMessage {
  return {
    role: 'user',
    content: `The images from the vault named above, in this order: ${images.map((i) => JSON.stringify(i.path)).join(', ')}.`,
    images: images.map(({ mime, data, tokens }) => ({ mime, data, tokens })),
  };
}

/** Estimated tokens of a list of request messages, images included. */
export function messagesTokens(messages: readonly ChatMessage[], estimate: (s: string) => number, overhead: number): number {
  return messages.reduce((t, m) => {
    const calls = m.role === 'assistant' && m.toolCalls ? estimate(JSON.stringify(m.toolCalls)) : 0;
    const images = m.role === 'user' && m.images ? m.images.reduce((n, i) => n + i.tokens, 0) : 0;
    return t + estimate(m.content) + calls + images + overhead;
  }, 0);
}

/** A chat title from its first message: first line, at most 50 characters, cut at a word. */
export function titleFrom(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').trim();
  if (line.length <= 50) return line;
  const head = line.slice(0, 51);
  const space = head.lastIndexOf(' ');
  return `${(space > 20 ? head.slice(0, space) : line.slice(0, 50)).trimEnd()}…`;
}
