// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ChatHistory } from '../../src/core/chat/history';
import { ChatManager } from '../../src/core/chat/manager';
import type { ChatEvent, ChatProvider, ModelRef } from '../../src/core/providers/types';
import { type Storage, type StorageNamespace } from '../../src/core/storage';

class MemStorage implements Storage {
  readonly files = new Map<string, string>();
  read(ns: StorageNamespace, k: string) { return Promise.resolve(this.files.get(`${ns}/${k}`) ?? null); }
  write(ns: StorageNamespace, k: string, d: string) { this.files.set(`${ns}/${k}`, d); return Promise.resolve(); }
  append(ns: StorageNamespace, k: string, d: string) { this.files.set(`${ns}/${k}`, (this.files.get(`${ns}/${k}`) ?? '') + d); return Promise.resolve(); }
  remove(ns: StorageNamespace, k: string) { this.files.delete(`${ns}/${k}`); return Promise.resolve(); }
  list(ns: StorageNamespace) { return Promise.resolve([...this.files.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1))); }
}

/** Replies "ok" to everything, or hangs if `hang` is set. */
function provider(hang = false): ChatProvider {
  return {
    id: 'fake',
    label: 'Fake',
    capabilities: () => Promise.resolve({ toolCalling: 'none', nativeWebSearch: false, images: false, contextWindow: 32768 }),
    listModels: () => Promise.resolve([]),
    async *stream(): AsyncGenerator<ChatEvent> {
      await Promise.resolve();
      if (hang) await new Promise(() => {});
      yield { type: 'text', text: 'ok' };
      yield { type: 'done', reason: 'stop' };
    },
  };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function setup(hang = false) {
  const storage = new MemStorage();
  let n = 0;
  let defaultModel: ModelRef | null = { provider: 'fake', model: 'm' };
  const errors: string[] = [];
  const p = provider(hang);
  const manager = new ChatManager({
    providers: { get: (id) => (id === 'fake' ? p : undefined) },
    clock: { now: () => ++n },
    newId: () => `id${++n}`,
    history: new ChatHistory(storage),
    defaultModel: () => defaultModel,
    setDefaultModel: (m) => {
      defaultModel = m;
      return Promise.resolve();
    },
    onError: (msg) => errors.push(msg),
  });
  return { manager, storage, errors, getDefault: () => defaultModel };
}

describe('ChatManager', () => {
  it('saves a finished chat and lists it', async () => {
    const { manager } = setup();
    manager.session.send('hello');
    await settle();
    const { chats } = await manager.list();
    expect(chats).toEqual([expect.objectContaining({ title: 'hello', messageCount: 2 })]);
    expect(manager.snapshot().chat.messages[1]).toMatchObject({ content: 'ok', status: 'complete' });
  });

  it('new chat stops a reply in progress and keeps it as stopped', async () => {
    const { manager } = setup(true);
    manager.session.send('hello');
    await settle();
    const firstId = manager.snapshot().chat.id;
    manager.newChat();
    await settle();
    expect(manager.snapshot().chat.messages).toEqual([]);
    expect(manager.snapshot().busy).toBe(false);
    await manager.open(firstId);
    expect(manager.snapshot().chat.messages[1]).toMatchObject({ status: 'stopped' });
  });

  it('a new chat starts with the model picked last', async () => {
    const { manager, getDefault } = setup();
    await manager.pickModel({ provider: 'fake', model: 'other' });
    expect(getDefault()).toEqual({ provider: 'fake', model: 'other' });
    manager.newChat();
    expect(manager.snapshot().chat.model).toEqual({ provider: 'fake', model: 'other' });
  });

  it('picking a model updates the snapshot at once', async () => {
    const { manager } = setup();
    const before = manager.snapshot();
    await manager.pickModel({ provider: 'fake', model: 'other' });
    expect(manager.snapshot()).not.toBe(before);
    expect(manager.snapshot().chat.model?.model).toBe('other');
  });

  it('deleting the open chat starts a new one; clear all removes everything', async () => {
    const { manager, storage } = setup();
    manager.session.send('one');
    await settle();
    const id = manager.snapshot().chat.id;
    await manager.delete(id);
    expect(manager.snapshot().chat.id).not.toBe(id);
    manager.session.send('two');
    await settle();
    storage.files.set('chats/junk', '{');
    await manager.clearAll();
    expect(await manager.list()).toEqual({ chats: [], unreadable: 0 });
  });

  it('reports a chat that cannot be opened', async () => {
    const { manager, errors } = setup();
    expect(await manager.open('missing')).toBe(false);
    expect(errors).toEqual(['That chat could not be read.']);
  });
});
