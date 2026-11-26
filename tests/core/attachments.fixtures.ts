// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The attachment world shared by the milestone 7 tests (INVARIANTS.md § Milestone 7). */

import fc from 'fast-check';
import { ContextIndex } from '../../src/core/context/ContextIndex';
import { compileExclusions } from '../../src/core/context/exclusions';
import { FakeRawVault, type VaultSpec } from './vault.fixtures';

const enc = new TextEncoder();
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

/** Just enough of each format for its header to be read; the tail is arbitrary. */
export function pngBytes(w: number, h: number, tail: readonly number[] = []): Uint8Array {
  return new Uint8Array([0x89, ...ascii('PNG\r\n\x1a\n'), ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...tail]);
}
export function jpegBytes(w: number, h: number, tail: readonly number[] = []): Uint8Array {
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...tail, 0xff, 0xd9]);
}
export function webpBytes(variant: 'VP8X' | 'VP8L' | 'VP8 ', w: number, h: number, tail: readonly number[] = []): Uint8Array {
  let chunk: number[];
  if (variant === 'VP8X') chunk = [...ascii('VP8X'), ...le32(10), 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)];
  else if (variant === 'VP8L') {
    const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
    chunk = [...ascii('VP8L'), ...le32(5), 0x2f, ...le32(bits >>> 0)];
  } else chunk = [...ascii('VP8 '), ...le32(10), 0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, (w >>> 8) & 0x3f, h & 255, (h >>> 8) & 0x3f];
  const body = [...ascii('WEBP'), ...chunk, ...tail];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
}

export type FileKind = 'text' | 'badutf8' | 'bigtext' | 'png' | 'jpeg' | 'webp' | 'badimage' | 'pdf' | 'mp3' | 'canvas';

const EXT: Record<FileKind, string[]> = {
  text: ['txt', 'csv', 'json', 'TXT', 'Py'],
  badutf8: ['txt'],
  bigtext: ['log'],
  png: ['png', 'PNG'],
  jpeg: ['jpg', 'jpeg', 'JPG'],
  webp: ['webp'],
  badimage: ['png', 'jpg'],
  pdf: ['pdf'],
  mp3: ['mp3'],
  canvas: ['canvas'],
};

export interface World {
  spec: VaultSpec;
  kinds: Map<string, FileKind>;
  /** The token in each attachment's bytes. */
  sentinels: Map<string, string>;
  /** Each note's token. */
  noteSentinels: Map<string, string>;
}

export const fileSentinel = (j: number) => `FILESENT${j}Q`;
export const noteSentinel = (i: number) => `NOTESENT${i}Q`;

function bytesFor(kind: FileKind, token: string, text: string, w: number, h: number): Uint8Array {
  const tail = ascii(` ${token} `);
  switch (kind) {
    case 'text':
      return enc.encode(`${token}\n${text}`);
    case 'badutf8':
      return new Uint8Array([...ascii(token), 0xff, 0xfe, 0xc3]);
    case 'bigtext': {
      const b = new Uint8Array(1_000_001).fill(0x20);
      b.set(ascii(token), 0);
      return b;
    }
    case 'png':
      return pngBytes(w, h, tail);
    case 'jpeg':
      return jpegBytes(w, h, tail);
    case 'webp':
      return webpBytes('VP8X', w, h, tail);
    default:
      return new Uint8Array(ascii(`junk ${token} junk`));
  }
}

const NOTE_FOLDERS = ['', 'Notes', 'Private', 'Work'];
const FILE_FOLDERS = ['attachments', 'Private', 'Notes', ''];
export const WORLD_PATTERNS = ['Private', 'Work/**', '*.mp3'];

export const world: fc.Arbitrary<World> = fc
  .record({
    notes: fc.array(fc.constantFrom(...NOTE_FOLDERS), { minLength: 1, maxLength: 10 }),
    files: fc.array(
      fc.record({
        kind: fc.oneof(
          { weight: 4, arbitrary: fc.constantFrom<FileKind>('text', 'png', 'jpeg', 'webp') },
          { weight: 2, arbitrary: fc.constantFrom<FileKind>('badutf8', 'badimage', 'pdf', 'mp3', 'canvas') },
          { weight: 1, arbitrary: fc.constant<FileKind>('bigtext') },
        ),
        folder: fc.constantFrom(...FILE_FOLDERS),
        ext: fc.nat(),
        text: fc.string({ maxLength: 30, unit: 'grapheme' }),
        w: fc.integer({ min: 1, max: 4000 }),
        h: fc.integer({ min: 1, max: 4000 }),
      }),
      { minLength: 1, maxLength: 10 },
    ),
    edges: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean()), { maxLength: 40, size: 'large' }),
    patterns: fc.subarray(WORLD_PATTERNS),
  })
  .map(({ notes, files, edges, patterns }) => {
    const kinds = new Map<string, FileKind>();
    const sentinels = new Map<string, string>();
    const bytes: Record<string, Uint8Array> = {};
    const attachments: string[] = [];
    files.forEach((f, j) => {
      const exts = EXT[f.kind];
      const path = `${f.folder ? `${f.folder}/` : ''}f${j}.${exts[f.ext % exts.length]}`;
      attachments.push(path);
      kinds.set(path, f.kind);
      sentinels.set(path, fileSentinel(j));
      bytes[path] = bytesFor(f.kind, fileSentinel(j), f.text, f.w, f.h);
    });
    const notePaths = notes.map((folder, i) => `${folder ? `${folder}/` : ''}n${i}.md`);
    const links = notePaths.map(() => [] as string[]);
    for (const [from, to, toFile] of edges) {
      const targets = toFile ? attachments : notePaths;
      const t = targets[to % targets.length]!;
      const l = links[from % notePaths.length]!;
      if (!l.includes(t)) l.push(t);
    }
    const noteSentinels = new Map<string, string>();
    const spec: VaultSpec = {
      notes: notePaths.map((path, i) => {
        noteSentinels.set(path, noteSentinel(i));
        return { path, links: links[i]!, content: `# n${i}\n${noteSentinel(i)}\n${links[i]!.map((l) => `![[${l}]]`).join(' ')}\n` };
      }),
      attachments,
      bytes,
      patterns,
      obsidianFilters: [],
      respectObsidian: false,
    };
    return { spec, kinds, sentinels, noteSentinels };
  });

export const exclusionsOf = (spec: VaultSpec) => compileExclusions({ patterns: spec.patterns, obsidianFilters: null, configDir: '.obsidian' });

export function openWorld(w: World): { raw: FakeRawVault; index: ContextIndex } {
  const raw = new FakeRawVault(structuredClone(w.spec));
  const index = new ContextIndex(raw, () => exclusionsOf(raw.spec));
  index.refresh();
  return { raw, index };
}

/** Whether a file of this kind is sent, by the documented rules alone (INVARIANTS.md A1). */
export function sendable(kind: FileKind, vision: boolean): boolean {
  if (kind === 'text') return true;
  if (kind === 'png' || kind === 'jpeg' || kind === 'webp') return vision;
  return false;
}

export const latin1 = (base64: string) => Buffer.from(base64, 'base64').toString('latin1');
