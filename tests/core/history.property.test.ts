// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md H1–H3: the chat history store. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ChatHistory } from '../../src/core/chat/history';
import type { AssistantMessage, Chat, Message } from '../../src/core/chat/types';
import { type Storage, StorageError, type StorageNamespace, isStorageKey } from '../../src/core/storage';

/** In-memory Storage with the same key rules as PluginStorage. */
class MemStorage implements Storage {
  readonly files = new Map<string, string>();
  private k(ns: StorageNamespace, key: string): string {
    if (!isStorageKey(key)) throw new StorageError(`bad key ${String(key)}`);
    return `${ns}/${key}`;
  }
  read(ns: StorageNamespace, key: string) {
    return Promise.resolve(this.files.get(this.k(ns, key)) ?? null);
  }
  write(ns: StorageNamespace, key: string, data: string) {
    this.files.set(this.k(ns, key), data);
    return Promise.resolve();
  }
  append(ns: StorageNamespace, key: string, data: string) {
    const k = this.k(ns, key);
    this.files.set(k, (this.files.get(k) ?? '') + data);
    return Promise.resolve();
  }
  remove(ns: StorageNamespace, key: string) {
    this.files.delete(this.k(ns, key));
    return Promise.resolve();
  }
  list(ns: StorageNamespace) {
    return Promise.resolve([...this.files.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1)).sort());
  }
}

const id = fc.constantFrom('a1', 'b2', 'c3', 'd4', 'e5');
const ref = fc.record({ provider: fc.constantFrom('ollama', 'none'), model: fc.constantFrom('qwen3.8:27b', 'none', 'm') });
const text = fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }));
const message: fc.Arbitrary<Message> = fc.oneof(
  fc.record({ id: fc.uuid(), role: fc.constant('user' as const), content: text, createdAt: fc.nat() }),
  fc
    .record(
      {
        id: fc.uuid(),
        role: fc.constant('assistant' as const),
        content: text,
        reasoning: text,
        status: fc.constantFrom('streaming' as const, 'complete' as const, 'stopped' as const, 'truncated' as const, 'error' as const),
        error: fc.string(),
        model: ref,
        createdAt: fc.nat(),
        usage: fc.record({ inputTokens: fc.nat(), outputTokens: fc.nat() }, { requiredKeys: [] }),
      },
      { requiredKeys: ['id', 'role', 'content', 'reasoning', 'status', 'model', 'createdAt'] },
    )
    .map((m) => m as AssistantMessage),
);
const chat = (chatId: string): fc.Arbitrary<Chat> =>
  fc.record({
    id: fc.constant(chatId),
    title: text,
    createdAt: fc.nat(),
    updatedAt: fc.nat({ max: 50 }),
    model: fc.option(ref, { nil: null }),
    messages: fc.array(message, { maxLength: 5 }),
  });

const normalised = (c: Chat): Chat => ({
  ...c,
  messages: c.messages.map((m) => (m.role === 'assistant' && m.status === 'streaming' ? { ...m, status: 'stopped' } : m)),
});

const junk = (chatId: string) =>
  fc.oneof(
    fc.string(),
    fc.constantFrom('', '{', 'null', '[]', '{"format":"lektor-chat","version":2,"chat":{}}', '{"format":"other"}'),
    // A valid file stored under the wrong name.
    chat('zz9').map((c) => JSON.stringify({ format: 'lektor-chat', version: 1, chat: c })),
    // A valid file with an extra field.
    chat(chatId).map((c) => JSON.stringify({ format: 'lektor-chat', version: 1, chat: { ...c, extra: 1 } })),
  );

type Model = Map<string, Chat | 'corrupt'>;
interface Real {
  history: ChatHistory;
  storage: MemStorage;
}

async function checkList(m: Model, r: Real): Promise<void> {
  const { chats, unreadable } = await r.history.list();
  const readable = [...m.values()].filter((v): v is Chat => v !== 'corrupt');
  const expected = readable
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length, model: c.model }));
  expect(chats).toEqual(expected);
  expect(unreadable).toBe([...m.values()].filter((v) => v === 'corrupt').length);
}

const c = (name: string, run: (m: Model, r: Real) => Promise<void>): fc.AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (m, r) => {
    await run(m, r);
    await checkList(m, r);
  },
  toString: () => name,
});

const commands = fc.commands(
  [
    id.chain(chat).map((ch) => c(`save(${ch.id})`, async (m, r) => {
      await r.history.save(ch);
      m.set(ch.id, normalised(structuredClone(ch)));
    })),
    fc.tuple(id, id.chain(junk)).map(([k, j]) => c(`corrupt(${k})`, async (m, r) => {
      await r.storage.write('chats', k, j);
      m.set(k, 'corrupt');
    })),
    id.map((k) => c(`load(${k})`, async (m, r) => {
      const v = m.get(k);
      expect(await r.history.load(k)).toEqual(v === undefined || v === 'corrupt' ? null : v);
    })),
    id.map((k) => c(`delete(${k})`, async (m, r) => {
      await r.history.delete(k);
      m.delete(k);
    })),
    fc.constant(c('clearAll()', async (m, r) => {
      await r.history.clearAll();
      m.clear();
    })),
  ],
  { maxCommands: 40, size: 'large' },
);

describe('ChatHistory (INVARIANTS.md H1–H3)', () => {
  it('H1–H3: round-trips, survives corrupt files, clears completely', async () => {
    await fc.assert(
      fc.asyncProperty(commands, async (cmds) => {
        const storage = new MemStorage();
        await fc.asyncModelRun(() => ({ model: new Map(), real: { storage, history: new ChatHistory(storage) } }), cmds);
      }),
    );
  });

  it('H3: refuses to save a chat whose id is not a storage key', async () => {
    const history = new ChatHistory(new MemStorage());
    await expect(history.save({ id: '../x', title: '', createdAt: 0, updatedAt: 0, model: null, messages: [] })).rejects.toBeInstanceOf(StorageError);
  });
});
