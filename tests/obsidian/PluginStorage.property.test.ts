// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md P3: PluginStorage only touches resolved paths and behaves like a map. */

import fc from 'fast-check';
import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { StorageError, type StorageNamespace, keyFromStoragePath } from '../../src/core/storage';
import { PluginStorage } from '../../src/obsidian/PluginStorage';

const ROOT = '.obsidian/plugins/lektor';
const NAMESPACES: StorageNamespace[] = ['chats', 'history'];

/** An in-memory DataAdapter that records every path it is asked about. */
class FakeAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>(['', '.obsidian', '.obsidian/plugins', ROOT, 'Notes', 'Private']);
  readonly touched: string[] = [];

  private parentOf(p: string): string {
    return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  }
  private touch(p: string): void {
    this.touched.push(p);
  }
  exists(p: string): Promise<boolean> {
    this.touch(p);
    return Promise.resolve(this.files.has(p) || this.folders.has(p));
  }
  read(p: string): Promise<string> {
    this.touch(p);
    const v = this.files.get(p);
    return v === undefined ? Promise.reject(new Error(`ENOENT ${p}`)) : Promise.resolve(v);
  }
  write(p: string, data: string): Promise<void> {
    this.touch(p);
    if (!this.folders.has(this.parentOf(p))) return Promise.reject(new Error(`no parent for ${p}`));
    this.files.set(p, data);
    return Promise.resolve();
  }
  append(p: string, data: string): Promise<void> {
    this.touch(p);
    if (!this.folders.has(this.parentOf(p))) return Promise.reject(new Error(`no parent for ${p}`));
    this.files.set(p, (this.files.get(p) ?? '') + data);
    return Promise.resolve();
  }
  remove(p: string): Promise<void> {
    this.touch(p);
    return this.files.delete(p) ? Promise.resolve() : Promise.reject(new Error(`ENOENT ${p}`));
  }
  mkdir(p: string): Promise<void> {
    this.touch(p);
    this.folders.add(p);
    return Promise.resolve();
  }
  list(p: string): Promise<{ files: string[]; folders: string[] }> {
    this.touch(p);
    return Promise.resolve({
      files: [...this.files.keys()].filter((f) => this.parentOf(f) === p),
      folders: [...this.folders].filter((f) => f !== p && this.parentOf(f) === p),
    });
  }
}

/** Files that are not Lektor storage and must never be touched. */
const BYSTANDERS: Record<string, string> = {
  'Notes/secret.md': 'SENTINEL-note',
  'Private/diary.md': 'SENTINEL-private',
  '.obsidian/app.json': '{}',
  [`${ROOT}/data.json`]: '{"version":1}',
  [`${ROOT}/main.js`]: '/* plugin */',
  [`${ROOT}/chats/README.md`]: 'junk',
  [`${ROOT}/chats/UPPER.json`]: 'junk',
  [`${ROOT}/chats/con.json`]: 'junk',
  [`${ROOT}/chats/sub/nested.json`]: 'junk',
  [`${ROOT}/history/wrong-ext.json`]: 'junk',
};
/** Valid entries that already exist when the store opens. */
const PRESEEDED: Record<string, string> = {
  [`${ROOT}/chats/old.json`]: '{"old":true}',
  [`${ROOT}/history/note-1.jsonl`]: '{"hunk":1}\n',
};

function seeded(): FakeAdapter {
  const a = new FakeAdapter();
  for (const f of [`${ROOT}/chats`, `${ROOT}/chats/sub`, `${ROOT}/history`]) a.folders.add(f);
  for (const [p, v] of Object.entries({ ...BYSTANDERS, ...PRESEEDED })) a.files.set(p, v);
  return a;
}

const fakeApp = (adapter: FakeAdapter) => ({ vault: { adapter } }) as unknown as App;

// ---------------------------------------------------------------------------
// Model

type Model = Map<string, string>; // `${ns}/${key}` -> text
interface Real {
  storage: PluginStorage;
  adapter: FakeAdapter;
}

const VALID_KEYS = ['a', 'b', 'chat-1', '0', 'old', 'note-1'];
const BAD_KEYS = ['..', '.', '', 'A', 'a/b', '../../Notes/secret', 'con', '__proto__', '-x', 'a.json', 'x'.repeat(129), 'a\u0000'];
const BAD_NAMESPACES = ['notes', '../chats', '__proto__', 'Chats', ''];

const nsArb = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...NAMESPACES) }, { weight: 1, arbitrary: fc.constantFrom(...BAD_NAMESPACES) });
const keyArb = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...VALID_KEYS) }, { weight: 2, arbitrary: fc.constantFrom(...BAD_KEYS) }, { weight: 1, arbitrary: fc.string() });

const isValid = (ns: string, key: string) =>
  (NAMESPACES as string[]).includes(ns) && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(key) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(key);

function confined(path: string): boolean {
  return NAMESPACES.some((ns) => path === `${ROOT}/${ns}` || keyFromStoragePath(ROOT, ns, path) !== null);
}

function checkInvariants(r: Real): void {
  for (const p of r.adapter.touched) expect(confined(p), `touched ${p}`).toBe(true);
  for (const [p, v] of Object.entries(BYSTANDERS)) expect(r.adapter.files.get(p)).toBe(v);
}

abstract class Op implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly ns: string,
    readonly key: string,
  ) {}
  check = () => true;
  abstract apply(m: Model, r: Real): Promise<void>;
  async run(m: Model, r: Real): Promise<void> {
    const before = r.adapter.touched.length;
    if (!isValid(this.ns, this.key)) {
      await expect(this.apply(m, r)).rejects.toBeInstanceOf(StorageError);
      expect(r.adapter.touched.length, 'invalid input reached the adapter').toBe(before);
    } else {
      await this.apply(m, r);
    }
    checkInvariants(r);
  }
  toString(): string {
    return `${this.constructor.name}(${JSON.stringify(this.ns)}, ${JSON.stringify(this.key)})`;
  }
}

class Write extends Op {
  constructor(ns: string, key: string, readonly data: string) {
    super(ns, key);
  }
  async apply(m: Model, r: Real) {
    await r.storage.write(this.ns as StorageNamespace, this.key, this.data);
    m.set(`${this.ns}/${this.key}`, this.data);
  }
}
class Append extends Op {
  constructor(ns: string, key: string, readonly data: string) {
    super(ns, key);
  }
  async apply(m: Model, r: Real) {
    await r.storage.append(this.ns as StorageNamespace, this.key, this.data);
    m.set(`${this.ns}/${this.key}`, (m.get(`${this.ns}/${this.key}`) ?? '') + this.data);
  }
}
class Read extends Op {
  async apply(m: Model, r: Real) {
    expect(await r.storage.read(this.ns as StorageNamespace, this.key)).toBe(m.get(`${this.ns}/${this.key}`) ?? null);
  }
}
class Remove extends Op {
  async apply(m: Model, r: Real) {
    await r.storage.remove(this.ns as StorageNamespace, this.key);
    m.delete(`${this.ns}/${this.key}`);
  }
}
class List extends Op {
  constructor(ns: string) {
    super(ns, 'a');
  }
  async apply(m: Model, r: Real) {
    const expected = [...m.keys()].filter((k) => k.startsWith(`${this.ns}/`)).map((k) => k.slice(this.ns.length + 1)).sort();
    expect(await r.storage.list(this.ns as StorageNamespace)).toEqual(expected);
  }
}

const commands = fc.commands(
  [
    fc.tuple(nsArb, keyArb, fc.string()).map(([n, k, d]) => new Write(n, k, d)),
    fc.tuple(nsArb, keyArb, fc.string()).map(([n, k, d]) => new Append(n, k, d)),
    fc.tuple(nsArb, keyArb).map(([n, k]) => new Read(n, k)),
    fc.tuple(nsArb, keyArb).map(([n, k]) => new Remove(n, k)),
    nsArb.map((n) => new List(n)),
  ],
  { maxCommands: 60, size: 'large' },
);

describe('PluginStorage (INVARIANTS.md P3)', () => {
  it('P3: touches only resolved paths, never bystanders, and behaves like a map', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), commands, async (fresh, cmds) => {
        const adapter = fresh ? new FakeAdapter() : seeded();
        const model: Model = new Map(
          fresh ? [] : Object.entries(PRESEEDED).map(([p, v]) => {
            const ns = NAMESPACES.find((n) => keyFromStoragePath(ROOT, n, p) !== null)!;
            return [`${ns}/${keyFromStoragePath(ROOT, ns, p)}`, v] as [string, string];
          }),
        );
        if (fresh) for (const [p, v] of Object.entries(BYSTANDERS)) {
          // Bystanders exist even in a fresh vault; namespace folders do not.
          adapter.files.set(p, v);
        }
        await fc.asyncModelRun(() => ({ model, real: { storage: new PluginStorage(fakeApp(adapter), ROOT), adapter } }), cmds);
      }),
    );
  });
});

describe('PluginStorage', () => {
  it('refuses a plugin folder outside the config folder', () => {
    const adapter = new FakeAdapter();
    for (const dir of [undefined, '', 'Notes', 'Notes/plugins/lektor', '.obsidian/plugins/../../Notes', '/abs/.obsidian/plugins/lektor']) {
      expect(() => new PluginStorage(fakeApp(adapter), dir)).toThrow(StorageError);
    }
    expect(adapter.touched).toEqual([]);
  });

  it('creates the namespace folder on first write', async () => {
    const adapter = new FakeAdapter();
    const storage = new PluginStorage(fakeApp(adapter), ROOT);
    await storage.write('chats', 'abc', '{}');
    expect(adapter.folders.has(`${ROOT}/chats`)).toBe(true);
    expect(adapter.files.get(`${ROOT}/chats/abc.json`)).toBe('{}');
    expect(await storage.list('history')).toEqual([]);
  });
});
