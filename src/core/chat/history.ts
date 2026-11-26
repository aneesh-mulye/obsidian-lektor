// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat history in plugin data, one file per chat (INVARIANTS.md H1–H3).
 * Stores the transcript only; from the context milestone on, a context
 * manifest (paths and hashes), never note contents (DESIGN.md § Privacy).
 */

import { z } from 'zod';
import { type Chip, EMPTY_CONTEXT } from '../context/state';
import type { ModelRef } from '../providers/types';
import { ATTACHMENT_MODES, DISPLAY_MODES, ModelRefSchema } from '../settings';
import type { Storage } from '../storage';
import type { Chat } from './types';

const UserMessage = z.strictObject({
  id: z.string(),
  role: z.literal('user'),
  content: z.string(),
  createdAt: z.number(),
});

const Manifest = z.strictObject({
  notes: z.array(z.strictObject({ path: z.string(), hash: z.string() })),
  selections: z.array(z.strictObject({ path: z.string(), hash: z.string() })),
  attachments: z.array(z.strictObject({ path: z.string(), hash: z.string() })).optional(),
  backlinkLists: z.number(),
  excluded: z.number(),
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
  context: Manifest.optional(),
  promptEstimate: z.number().optional(),
  contextHash: z.string().optional(),
  notice: z.string().optional(),
  steps: z
    .array(
      z.strictObject({
        text: z.string(),
        calls: z.array(
          z.strictObject({
            id: z.string(),
            name: z.string(),
            arguments: z.unknown(),
            result: z
              .strictObject({
                ok: z.boolean(),
                content: z.string(),
                summary: z.string(),
                limit: z.boolean().optional(),
                urls: z.array(z.string()).optional(),
                proposalId: z.string().optional(),
                contextHash: z.string().optional(),
              })
              .optional(),
          }),
        ),
      }),
    )
    .optional(),
  fencedProposals: z.array(z.string()).optional(),
});

const Proposal = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('edit'),
    id: z.string(),
    path: z.string(),
    edits: z.array(z.strictObject({ find: z.string(), replace: z.string(), reason: z.string().optional() })),
    anchors: z.array(z.number()),
    expect: z.string(),
    settled: z.array(z.string()).optional(),
    hunks: z.array(
      z.strictObject({
        id: z.string(),
        edit: z.number(),
        start: z.number(),
        end: z.number(),
        after: z.string(),
        status: z.enum(['pending', 'accepted', 'rejected', 'dropped']),
        dropReason: z.string().optional(),
      }),
    ),
    createdAt: z.number(),
    model: ModelRefSchema,
  }),
  z.strictObject({
    kind: z.literal('note'),
    id: z.string(),
    path: z.string(),
    content: z.string(),
    status: z.enum(['pending', 'created', 'dismissed']),
    createdAt: z.number(),
    model: ModelRefSchema,
  }),
]);

/** Chips as stored: selections are a path, range and hash, never text (INVARIANTS.md H4). */
const ChipRecord = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('note'),
    id: z.string(),
    path: z.string(),
    depth: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    backlinkContents: z.boolean(),
    current: z.boolean(),
    lastHash: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('folder'), id: z.string(), path: z.string(), recursive: z.boolean() }),
  z.strictObject({
    kind: z.literal('selection'),
    id: z.string(),
    path: z.string(),
    from: z.int().min(0),
    to: z.int().min(0),
    hash: z.string(),
  }),
  z.strictObject({ kind: z.literal('attachment'), id: z.string(), path: z.string(), lastHash: z.string().optional() }),
]);

const ContextRecord = z.strictObject({
  followActive: z.boolean(),
  chips: z.array(ChipRecord),
  attachmentMode: z.enum(ATTACHMENT_MODES).optional(),
  withheld: z.array(z.string()).optional(),
});

const ChatV1 = z.strictObject({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  model: ModelRefSchema.nullable(),
  messages: z.array(z.discriminatedUnion('role', [UserMessage, AssistantMessage])),
});

const ChatV2 = ChatV1.extend({
  context: ContextRecord,
  sentContext: z.record(z.string(), z.string()).optional(),
  toolsDisabled: z.boolean().optional(),
  proposals: z.record(z.string(), Proposal).optional(),
  displayMode: z.enum(DISPLAY_MODES).optional(),
});

const FileSchema = z.discriminatedUnion('version', [
  z.strictObject({ format: z.literal('lektor-chat'), version: z.literal(1), chat: ChatV1 }),
  z.strictObject({ format: z.literal('lektor-chat'), version: z.literal(2), chat: ChatV2 }),
]);

/** What is written to disk: selection text and "changed" marks are left out. */
function toRecord(chat: Chat): unknown {
  const chips = chat.context.chips.map((c): unknown => {
    if (c.kind === 'selection') {
      const { text: _text, ...rest } = c;
      return rest;
    }
    if (c.kind === 'note' || c.kind === 'attachment') {
      const { changed: _changed, ...rest } = c;
      return rest;
    }
    return c;
  });
  // A pending approval is never saved: it can only be answered in the session that asked.
  const messages = chat.messages.map((m) => {
    if (m.role !== 'assistant' || m.approval === undefined) return m;
    const { approval: _a, ...rest } = m;
    return rest;
  });
  const { attachmentMode, withheld } = chat.context;
  return {
    ...chat,
    messages,
    context: { followActive: chat.context.followActive, chips, ...(attachmentMode ? { attachmentMode } : {}), ...(withheld ? { withheld } : {}) },
  };
}

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
    await this.storage.write('chats', chat.id, JSON.stringify({ format: 'lektor-chat', version: 2, chat: toRecord(chat) }));
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

  /** Chats that sent this note or attachment to a model (from their replies' context manifests). */
  async chatsSending(path: string): Promise<string[]> {
    const out: string[] = [];
    const sent = (m: Chat['messages'][number]) =>
      m.role === 'assistant' && (m.context?.notes.some((n) => n.path === path) || m.context?.attachments?.some((a) => a.path === path));
    for (const id of await this.storage.list('chats')) {
      const chat = this.parse(id, await this.storage.read('chats', id));
      if (chat?.messages.some(sent)) out.push(id);
    }
    return out;
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
    const file = parsed.data;
    const chat = (file.version === 1 ? { ...file.chat, context: EMPTY_CONTEXT } : { ...file.chat, context: { ...file.chat.context, chips: file.chat.context.chips as Chip[] } }) as Chat;
    return {
      ...chat,
      messages: chat.messages.map((m) => (m.role === 'assistant' && m.status === 'streaming' ? { ...m, status: 'stopped' } : m)),
    };
  }
}
