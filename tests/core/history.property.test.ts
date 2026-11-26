// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md H1–H3: the chat history store. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ChatHistory } from '../../src/core/chat/history';
import type { AssistantMessage, Chat, Message } from '../../src/core/chat/types';
import { type Chip, EMPTY_CONTEXT } from '../../src/core/context/state';
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
        steps: fc.array(
          fc.record({
            text,
            calls: fc.array(
              fc.record(
                {
                  id: fc.string(),
                  name: fc.constantFrom('web_search', 'fetch_page'),
                  arguments: fc.jsonValue(),
                  result: fc.record(
                    { ok: fc.boolean(), content: text, summary: fc.string(), limit: fc.boolean(), urls: fc.array(fc.webUrl(), { maxLength: 2 }) },
                    { requiredKeys: ['ok', 'content', 'summary'] },
                  ),
                },
                { requiredKeys: ['id', 'name', 'arguments'] },
              ),
              { maxLength: 3 },
            ),
          }),
          { maxLength: 2 },
        ),
        approval: fc.record({ id: fc.string(), tool: fc.constant('fetch_page'), title: fc.string(), detail: fc.string() }),
        context: fc.record({
          notes: fc.array(fc.record({ path: fc.constantFrom('a.md', 'b.md', 'Private/c.md'), hash: fc.constant('h') }), { maxLength: 2 }),
          selections: fc.constant([] as Array<{ path: string; hash: string }>),
          backlinkLists: fc.nat({ max: 3 }),
          excluded: fc.nat({ max: 3 }),
        }),
      },
      { requiredKeys: ['id', 'role', 'content', 'reasoning', 'status', 'model', 'createdAt'] },
    )
    .map((m) => m as AssistantMessage),
);
/** Selection text and sentContext values may carry this token; nothing else does. */
const SECRET = 'QQSENTQQ';

const chip: fc.Arbitrary<Chip> = fc.oneof(
  fc
    .record(
      {
        kind: fc.constant('note' as const),
        id: fc.uuid(),
        path: fc.string({ minLength: 1 }),
        depth: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
        backlinkContents: fc.boolean(),
        current: fc.boolean(),
        lastHash: fc.stringMatching(/^[0-9a-f]{64}$/),
        changed: fc.boolean(),
      },
      { requiredKeys: ['kind', 'id', 'path', 'depth', 'backlinkContents', 'current'] },
    )
    .map((c) => c as Chip),
  fc.record({ kind: fc.constant('folder' as const), id: fc.uuid(), path: fc.string({ minLength: 1 }), recursive: fc.boolean() }),
  fc
    .record(
      {
        kind: fc.constant('selection' as const),
        id: fc.uuid(),
        path: fc.string({ minLength: 1 }),
        from: fc.nat(),
        to: fc.nat(),
        hash: fc.stringMatching(/^[0-9a-f]{64}$/),
        text: fc.oneof(text, fc.constant(`picked ${SECRET} words`)),
      },
      { requiredKeys: ['kind', 'id', 'path', 'from', 'to', 'hash'] },
    )
    .map((c) => c as Chip),
);

const chat = (chatId: string): fc.Arbitrary<Chat> =>
  fc
    .record({
      id: fc.constant(chatId),
      title: text,
      createdAt: fc.nat(),
      updatedAt: fc.nat({ max: 50 }),
      model: fc.option(ref, { nil: null }),
      messages: fc.array(message, { maxLength: 5 }),
      context: fc.record({ followActive: fc.boolean(), chips: fc.array(chip, { maxLength: 4 }) }),
      sentContext: fc.option(fc.dictionary(fc.string(), fc.oneof(text, fc.constant(`ctx ${SECRET}`)), { maxKeys: 3 }), { nil: undefined }),
      proposals: fc.option(
        fc.dictionary(
          fc.string({ minLength: 1 }),
          fc.oneof(
            fc.record({
              kind: fc.constant('edit' as const),
              id: fc.string(),
              path: fc.string(),
              edits: fc.array(fc.record({ find: text, replace: text, reason: fc.string() }, { requiredKeys: ['find', 'replace'] }), { maxLength: 2 }),
              anchors: fc.array(fc.nat(), { maxLength: 2 }),
              expect: fc.string(),
              settled: fc.array(fc.string(), { maxLength: 2 }),
              hunks: fc.array(
                fc.record(
                  {
                    id: fc.string(),
                    edit: fc.nat(),
                    start: fc.nat(),
                    end: fc.nat(),
                    after: text,
                    status: fc.constantFrom('pending' as const, 'accepted' as const, 'rejected' as const, 'dropped' as const),
                    dropReason: fc.string(),
                  },
                  { requiredKeys: ['id', 'edit', 'start', 'end', 'after', 'status'] },
                ),
                { maxLength: 3 },
              ),
              createdAt: fc.nat(),
              model: ref,
            }, { requiredKeys: ['kind', 'id', 'path', 'edits', 'anchors', 'expect', 'hunks', 'createdAt', 'model'] }),
            fc.record({ kind: fc.constant('note' as const), id: fc.string(), path: fc.string(), content: text, status: fc.constantFrom('pending' as const, 'created' as const, 'dismissed' as const), createdAt: fc.nat(), model: ref }),
          ),
          { maxKeys: 2 },
        ),
        { nil: undefined },
      ),
      displayMode: fc.option(fc.constantFrom('prose' as const, 'sidebar' as const, 'inline' as const), { nil: undefined }),
    })
    .map(({ sentContext, proposals, displayMode, ...c }) => ({
      ...c,
      ...(sentContext === undefined ? {} : { sentContext }),
      ...(proposals === undefined ? {} : { proposals }),
      ...(displayMode === undefined ? {} : { displayMode }),
    }));

/** What a load gives back: mid-stream replies as stopped; selection text and "changed" marks never stored. */
const normalised = (c: Chat): Chat => ({
  ...c,
  messages: c.messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const { approval: _a, ...rest } = m; // never saved
    return rest.status === 'streaming' ? { ...rest, status: 'stopped' } : rest;
  }),
  context: {
    ...c.context,
    chips: c.context.chips.map((x): Chip => {
      if (x.kind === 'selection') {
        const { text: _t, ...rest } = x;
        return rest;
      }
      if (x.kind === 'note') {
        const { changed: _c, ...rest } = x;
        return rest;
      }
      return x;
    }),
  },
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
    await expect(history.save({ id: '../x', title: '', createdAt: 0, updatedAt: 0, model: null, messages: [], context: EMPTY_CONTEXT })).rejects.toBeInstanceOf(StorageError);
  });

  it('H4: note text reaches the file only as stored full-transcript context', async () => {
    await fc.assert(
      fc.asyncProperty(chat('a1'), async (c) => {
        const storage = new MemStorage();
        await new ChatHistory(storage).save(c);
        const file = storage.files.get('chats/a1')!;
        const kept = Object.values(c.sentContext ?? {}).some((v) => v.includes(SECRET));
        expect(file.includes(SECRET)).toBe(kept);
      }),
    );
  });

  it('H5: chatsSending finds exactly the chats whose replies sent the note', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.constantFrom('a1', 'b2', 'c3', 'd4'), { maxLength: 4 }).chain((ids) => fc.tuple(...ids.map((id) => chat(id)))), fc.constantFrom('a.md', 'b.md', 'Private/c.md'), async (chats, path) => {
        const storage = new MemStorage();
        const history = new ChatHistory(storage);
        for (const c of chats) await history.save(c);
        storage.files.set('chats/zz9', '{broken');
        const expected = chats.filter((c) => c.messages.some((m) => m.role === 'assistant' && m.context?.notes.some((n) => n.path === path))).map((c) => c.id).sort();
        expect((await history.chatsSending(path)).sort()).toEqual(expected);
      }),
    );
  });

  it('loads a version-1 file with an empty context', async () => {
    const storage = new MemStorage();
    const v1 = { id: 'a1', title: 't', createdAt: 1, updatedAt: 2, model: null, messages: [] };
    storage.files.set('chats/a1', JSON.stringify({ format: 'lektor-chat', version: 1, chat: v1 }));
    expect(await new ChatHistory(storage).load('a1')).toEqual({ ...v1, context: EMPTY_CONTEXT });
  });
});
