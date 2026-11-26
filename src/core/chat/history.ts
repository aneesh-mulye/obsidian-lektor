// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat history in plugin data, one file per chat (INVARIANTS.md H1–H3).
 * Stores the transcript only; from the context milestone on, a context
 * manifest (paths and hashes), never note contents (DESIGN.md § Privacy).
 */

import { z } from 'zod';
import type { ModelRef } from '../providers/types';
import { ModelRefSchema } from '../settings';
import type { Storage } from '../storage';
import type { Chat } from './types';

const UserMessage = z.strictObject({
  id: z.string(),
  role: z.literal('user'),
  content: z.string(),
  createdAt: z.number(),
});

const AssistantMessage = z.strictObject({
  id: z.string(),
  role: z.literal('assistant'),
  content: z.string(),
  reasoning: z.string(),
  status: z.enum(['streaming', 'complete', 'stopped', 'truncated', 'error']),
  error: z.string().optional(),
  model: ModelRefSchema,
  createdAt: z.number(),
  usage: z.strictObject({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
});

const ChatSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  model: ModelRefSchema.nullable(),
  messages: z.array(z.discriminatedUnion('role', [UserMessage, AssistantMessage])),
});

const FileSchema = z.strictObject({
  format: z.literal('lektor-chat'),
  version: z.literal(1),
  chat: ChatSchema,
});

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  model: ModelRef | null;
}

export class ChatHistory {
  constructor(private readonly storage: Storage) {}

  /** Rejects with StorageError if the chat id is not a valid storage key. */
  async save(chat: Chat): Promise<void> {
    await this.storage.write('chats', chat.id, JSON.stringify({ format: 'lektor-chat', version: 1, chat }));
  }

  /** The chat, or null if it is missing or unreadable. A reply saved mid-stream loads as stopped. */
  async load(id: string): Promise<Chat | null> {
    return this.parse(id, await this.storage.read('chats', id));
  }

  /** Readable chats, newest first, and how many files could not be read. */
  async list(): Promise<{ chats: ChatSummary[]; unreadable: number }> {
    const chats: ChatSummary[] = [];
    let unreadable = 0;
    for (const id of await this.storage.list('chats')) {
      const chat = this.parse(id, await this.storage.read('chats', id));
      if (chat === null) {
        unreadable += 1;
        continue;
      }
      chats.push({ id, title: chat.title, updatedAt: chat.updatedAt, messageCount: chat.messages.length, model: chat.model });
    }
    chats.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return { chats, unreadable };
  }

  async delete(id: string): Promise<void> {
    await this.storage.remove('chats', id);
  }

  /** Delete every chat file, readable or not. */
  async clearAll(): Promise<void> {
    for (const id of await this.storage.list('chats')) await this.storage.remove('chats', id);
  }

  private parse(id: string, text: string | null): Chat | null {
    if (text === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = FileSchema.safeParse(value);
    if (!parsed.success || parsed.data.chat.id !== id) return null;
    const chat = parsed.data.chat as Chat;
    return {
      ...chat,
      messages: chat.messages.map((m) => (m.role === 'assistant' && m.status === 'streaming' ? { ...m, status: 'stopped' } : m)),
    };
  }
}
