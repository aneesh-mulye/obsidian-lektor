// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md P1–P2: storage paths are confined to the plugin data folder and never collide. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  StorageError,
  keyFromStoragePath,
  resolveStorageDir,
  resolveStoragePath,
} from '../../src/core/storage';

// Independent reference model.
const EXT: Record<string, string> = { chats: '.json', history: '.jsonl' };
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const BAD_SEGMENT_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;
const modelKeyOk = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k) && !RESERVED.test(k);
const modelSegmentOk = (s: string) =>
  s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && !BAD_SEGMENT_CHARS.test(s) && s.trim() === s && !s.endsWith('.');
function modelRootOk(r: unknown): r is string {
  if (typeof r !== 'string') return false;
  const parts = r.split('/');
  return parts.length === 3 && parts.every(modelSegmentOk) && parts[0]!.startsWith('.') && parts[1] === 'plugins';
}
const modelNsOk = (n: unknown): n is string => typeof n === 'string' && Object.hasOwn(EXT, n);

// Generators: mostly valid, with adversarial mixes.
const segment = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9 ._-]{1,12}$/),
  fc.constantFrom('.', '..', '', ' x', 'x ', 'x.', 'a\\b', 'a:b', 'nul\u0000', '%2e%2e', 'ü'),
);
// Weighted towards valid roots and namespaces so that adversarial keys are tested against them.
const root = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('.obsidian/plugins/lektor', '.config/plugins/lektor-dev', '.obsidian/plugins/x y') },
  fc.tuple(fc.stringMatching(/^\.[a-z]{1,8}$/), fc.constantFrom('plugins', 'Plugins', 'plugin'), segment).map((p) => p.join('/')),
  fc.array(segment, { maxLength: 5 }).map((p) => p.join('/')),
  fc.constantFrom(
    '', '/', '/.obsidian/plugins/lektor', '.obsidian/plugins/lektor/', '.obsidian//plugins/lektor',
    '.obsidian/plugins/../../Notes', '.obsidian/plugins/..', 'Notes/plugins/lektor', '.obsidian\\plugins\\lektor',
    '.obsidian/plugins/lektor/chats', 'C:/.obsidian/plugins/lektor',
  ),
  fc.anything(),
);
const namespace = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('chats', 'history') },
  fc.constantFrom('Chats', 'chats/', '../chats', '__proto__', 'constructor', 'toString', '', 'void'),
  fc.anything(),
);
const key = fc.oneof(
  { weight: 3, arbitrary: fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,20}$/) },
  // Near-valid: one rule broken at a time.
  {
    weight: 3,
    arbitrary: fc.oneof(
      fc.constantFrom('con', 'prn', 'aux', 'nul', 'com0', 'com9', 'lpt1', 'lpt9'),
      fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,10}$/).chain((k) =>
        fc.nat({ max: k.length - 1 }).chain((i) =>
          fc.constantFrom('A', 'Z', '/', '.', ' ', '\\', '\u0000', 'é').map((c) => k.slice(0, i) + c + k.slice(i + 1)),
        ),
      ),
      fc.stringMatching(/^[a-z0-9_-]{0,10}$/).map((k) => `-${k}`),
      fc.stringMatching(/^[a-z0-9]{128}$/).map((k) => `${k}x`),
    ),
  },
  fc.uuid().map((u) => u.toLowerCase()),
  fc.constantFrom(
    '..', '.', '', 'a/b', '../a', 'a\\b', '/etc/passwd', '%2e%2e', 'a\u0000b', 'A', 'Chat', '-a', '_a',
    'con', 'nul', 'com1', 'lpt9', 'x'.repeat(128), 'x'.repeat(129), 'a.json', 'a b',
  ),
  fc.string(),
  fc.anything(),
);

function attempt<T>(f: () => T): T | StorageError {
  try {
    return f();
  } catch (e) {
    if (e instanceof StorageError) return e;
    throw e; // anything else is a bug
  }
}

const segmentsOk = (p: string) => !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

describe('storage paths (INVARIANTS.md P1–P2)', () => {
  it('P1: resolveStoragePath returns the exact confined path, or throws StorageError', () => {
    fc.assert(
      fc.property(root, namespace, key, (r, n, k) => {
        const out = attempt(() => resolveStoragePath(r as string, n as never, k as string));
        const valid = modelRootOk(r) && modelNsOk(n) && modelKeyOk(k);
        if (!valid) return out instanceof StorageError;
        return out === `${r}/${n}/${k}${EXT[n]}` && segmentsOk(out) && out.split('/').length === 5;
      }),
    );
  });

  it('P1: resolveStorageDir returns the exact confined folder, or throws StorageError', () => {
    fc.assert(
      fc.property(root, namespace, (r, n) => {
        const out = attempt(() => resolveStorageDir(r as string, n as never));
        if (!(modelRootOk(r) && modelNsOk(n))) return out instanceof StorageError;
        return out === `${r}/${n}` && segmentsOk(out) && out.split('/').length === 4;
      }),
    );
  });

  it('P1: keyFromStoragePath inverts resolveStoragePath and rejects every other path', () => {
    const validRoot = root.filter(modelRootOk);
    const validNs = fc.constantFrom<'chats' | 'history'>('chats', 'history');
    fc.assert(
      fc.property(validRoot, validNs, key, (r, n, k) => {
        if (modelKeyOk(k)) return keyFromStoragePath(r, n, resolveStoragePath(r, n, k)) === k;
        return true;
      }),
    );
    // Arbitrary paths: the result is null or a valid key whose resolved path is exactly that input.
    const somePath = fc.oneof(
      fc.tuple(validRoot, fc.constantFrom('chats', 'history', 'other'), fc.string(), fc.constantFrom('.json', '.jsonl', '', '.md'))
        .map(([r, n, k, e]) => `${r}/${n}/${k}${e}`),
      fc.string(),
    );
    fc.assert(
      fc.property(validRoot, validNs, somePath, (r, n, p) => {
        const k = keyFromStoragePath(r, n, p);
        return k === null || (modelKeyOk(k) && resolveStoragePath(r, n, k) === p);
      }),
    );
  });

  it('P2: distinct keys never collide, even case-insensitively', () => {
    const pair = fc.tuple(fc.constantFrom<'chats' | 'history'>('chats', 'history'), key.filter(modelKeyOk));
    fc.assert(
      fc.property(pair, pair, ([n1, k1], [n2, k2]) => {
        fc.pre(n1 !== n2 || k1 !== k2);
        const r = '.obsidian/plugins/lektor';
        expect(resolveStoragePath(r, n1, k1).toLowerCase()).not.toBe(resolveStoragePath(r, n2, k2).toLowerCase());
      }),
    );
  });
});
