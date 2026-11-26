// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared by the review tests (INVARIANTS.md W2–W6, B6): in-memory storage, a proposal host, and note text. */

import fc from 'fast-check';
import type { Chat } from '../../src/core/chat/types';
import { EMPTY_CONTEXT } from '../../src/core/context/state';
import type { ProposalHost } from '../../src/core/review/manager';
import type { Proposal } from '../../src/core/review/types';
import { type Storage, type StorageNamespace, isStorageKey } from '../../src/core/storage';

export const MODEL = { provider: 'ollama', model: 'm' };

export class MemStorage implements Storage {
  readonly files = new Map<string, string>();
  private k(ns: StorageNamespace, key: string) {
    if (!isStorageKey(key)) throw new Error(`bad key ${String(key)}`);
    return `${ns}/${key}`;
  }
  read(ns: StorageNamespace, key: string) { return Promise.resolve(this.files.get(this.k(ns, key)) ?? null); }
  write(ns: StorageNamespace, key: string, data: string) { this.files.set(this.k(ns, key), data); return Promise.resolve(); }
  append(ns: StorageNamespace, key: string, data: string) { const k = this.k(ns, key); this.files.set(k, (this.files.get(k) ?? '') + data); return Promise.resolve(); }
  remove(ns: StorageNamespace, key: string) { this.files.delete(this.k(ns, key)); return Promise.resolve(); }
  list(ns: StorageNamespace) { return Promise.resolve([...this.files.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1))); }
}

export class Host implements ProposalHost {
  chat: Chat;
  constructor(id = 'chat1') {
    this.chat = { id, title: '', createdAt: 0, updatedAt: 0, model: MODEL, messages: [], context: EMPTY_CONTEXT, proposals: {} };
  }
  updateProposal(id: string, fn: (p: Proposal) => Proposal) {
    const p = this.chat.proposals![id];
    if (p) this.chat = { ...this.chat, proposals: { ...this.chat.proposals, [id]: fn(p) } };
  }
  add(p: Proposal) {
    this.chat = { ...this.chat, proposals: { ...this.chat.proposals, [p.id]: p } };
  }
}

export const word = fc.constantFrom('the', 'teh', 'cat', 'sat', 'on', 'mat', 'keeper', 'light', 'its', "it's", 'their', 'there', '1844', 'naïve', '日本');
export const sep = fc.constantFrom(' ', ' ', ', ', '. ', '\n');
export const text = fc.array(fc.tuple(word, sep), { minLength: 3, maxLength: 40 }).map((ws) => ws.map(([w, s]) => w + s).join(''));
