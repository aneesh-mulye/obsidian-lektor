// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md A1 (attachments in context) and A2 (converters). */

import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AttachmentConverter,
  ConverterRegistry,
  IMAGE_TOKENS_MAX,
  IMAGE_TOKENS_MIN,
  defaultConverters,
  extensionOf,
  imageConverter,
  imageInfo,
  imageTokens,
  textConverter,
} from '../../src/core/context/attachments';
import { ContextIndex } from '../../src/core/context/ContextIndex';
import { prepareContext } from '../../src/core/context/prepare';
import {
  type ContextState,
  type Depth,
  EMPTY_CONTEXT,
  addAttachment,
  addNote,
  removeChip,
  setAttachmentMode,
  setDepth,
  withhold,
} from '../../src/core/context/state';
import type { AttachmentMode } from '../../src/core/settings';
import { type World, exclusionsOf, jpegBytes, latin1, openWorld, pngBytes, sendable, webpBytes, world } from './attachments.fixtures';
import { FakeRawVault } from './vault.fixtures';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const MODES: AttachmentMode[] = ['ask', 'allowed', 'upfront'];

// ---------------------------------------------------------------------------
// A1: the model of what a context sends, from the documented rules alone.

interface Real {
  w: World;
  raw: FakeRawVault;
  index: ContextIndex;
  state: ContextState;
  fallback: AttachmentMode;
  vision: boolean;
  n: number;
}

function expected(r: Real) {
  const ex = exclusionsOf(r.raw.spec);
  const notes = r.w.spec.notes;
  const allowedNote = (p: string) => notes.some((n) => n.path === p) && !ex.isExcluded(p);
  const allowedFile = (p: string) => r.w.spec.attachments.includes(p) && !ex.isExcluded(p);
  // Notes whose content is sent: note chips, walked to their depth through allowed notes.
  const content = new Set<string>();
  for (const c of r.state.chips) {
    if (c.kind !== 'note' || !allowedNote(c.path)) continue;
    // Each chip walks on its own, as the link-depth chip does (X2).
    const seen = new Set([c.path]);
    let frontier = [c.path];
    for (let d = 0; d < c.depth; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const t of notes.find((x) => x.path === n)!.links) {
          if (!allowedNote(t) || seen.has(t)) continue;
          seen.add(t);
          next.push(t);
        }
      }
      frontier = next;
    }
    for (const n of seen) content.add(n);
  }
  const linked = new Set<string>();
  for (const n of content) for (const t of notes.find((x) => x.path === n)!.links) if (allowedFile(t)) linked.add(t);
  const mode = r.state.attachmentMode ?? r.fallback;
  const withheld = new Set(r.state.withheld ?? []);
  const inContext = new Set<string>();
  for (const c of r.state.chips) if (c.kind === 'attachment' && allowedFile(c.path)) inContext.add(c.path);
  if (mode === 'upfront') for (const f of linked) if (!withheld.has(f)) inContext.add(f);
  const sent = new Set([...inContext].filter((p) => sendable(r.w.kinds.get(p)!, r.vision)));
  const listed = new Set([...linked].filter((f) => !inContext.has(f)));
  return { inContext, sent, listed, allowedFile };
}

async function check(r: Real): Promise<void> {
  r.raw.reads.length = 0;
  const p = await prepareContext(r.state, r.index, { attachmentMode: r.fallback, accepts: { images: r.vision } });
  const e = expected(r);
  const message = p.message ?? '';
  const imageText = p.images.map((i) => latin1(i.data)).join('\n');
  for (const [path, token] of r.w.sentinels) {
    const kind = r.w.kinds.get(path)!;
    const isImage = kind === 'png' || kind === 'jpeg' || kind === 'webp';
    // The sentinel is in the request if and only if the file is sent; images only as image bytes.
    const inText = message.includes(token);
    const inImages = imageText.includes(token);
    expect(inText || inImages, `${path} (${kind}) ${e.sent.has(path) ? 'missing' : 'leaked'}`).toBe(e.sent.has(path));
    if (isImage) expect(inText, `${path} image bytes in the text`).toBe(false);
    else expect(inImages).toBe(false);
  }
  // Images are the exact bytes, with the right type.
  for (const img of p.images) {
    const bytes = r.raw.spec.bytes![img.path]!;
    expect(img.data).toBe(Buffer.from(bytes).toString('base64'));
    expect(img.mime).toBe({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[r.w.kinds.get(img.path) as 'png' | 'jpeg' | 'webp']);
  }
  // Text attachments are their exact text.
  for (const path of e.sent) {
    if (r.w.kinds.get(path) === 'text') expect(message).toContain(new TextDecoder().decode(r.raw.spec.bytes![path]));
  }
  // Skipped: exactly what is in context but not sent, each with a reason.
  expect(new Set(p.skipped.map((s) => s.path))).toEqual(new Set([...e.inContext].filter((x) => !e.sent.has(x))));
  for (const s of p.skipped) expect(s.reason.length).toBeGreaterThan(0);
  // No excluded file is read.
  const ex = exclusionsOf(r.raw.spec);
  for (const read of r.raw.reads) expect(ex.isExcluded(read), `read excluded ${read}`).toBe(false);
  // Linked attachments not sent are listed by path only.
  for (const path of e.listed) expect(message, `${path} should be listed`).toContain(JSON.stringify(path));
  for (const path of r.w.spec.attachments) if (!e.allowedFile(path)) expect(message.includes(JSON.stringify(path)), `excluded ${path} named`).toBe(false);
  // The manifest: exactly the sent files, with the hash of their bytes.
  expect(new Map((p.manifest.attachments ?? []).map((a) => [a.path, a.hash]))).toEqual(new Map([...e.sent].map((x) => [x, sha(r.raw.spec.bytes![x]!)])));
}

type Cmd = fc.AsyncCommand<Real, Real>;
const cmd = (name: string, run: (r: Real) => void): Cmd => ({
  check: () => true,
  run: async (_m, r) => {
    run(r);
    await check(r);
  },
  toString: () => name,
});
const id = (r: Real) => () => `c${++r.n}`;
const noteAt = (r: Real, i: number) => r.w.spec.notes[i % r.w.spec.notes.length]!.path;
const fileAt = (r: Real, j: number) => r.w.spec.attachments[j % r.w.spec.attachments.length]!;

const commands = fc.commands(
  [
    fc.nat().map((i) => cmd(`addNote(${i})`, (r) => void (r.state = addNote(r.state, r.index, noteAt(r, i), id(r)).state))),
    fc.tuple(fc.nat(), fc.constantFrom<Depth>(0, 1, 2)).map(([k, d]) =>
      cmd(`depth(${k}, ${d})`, (r) => {
        const notes = r.state.chips.filter((c) => c.kind === 'note');
        if (notes.length > 0) r.state = setDepth(r.state, notes[k % notes.length]!.id, d);
      }),
    ),
    fc.nat().map((j) => cmd(`addAttachment(${j})`, (r) => void (r.state = addAttachment(r.state, r.index, fileAt(r, j), id(r)).state))),
    fc.nat().map((k) =>
      cmd(`remove(${k})`, (r) => {
        const c = r.state.chips[k % Math.max(1, r.state.chips.length)];
        if (c) r.state = removeChip(r.state, c.id);
      }),
    ),
    fc.nat().map((j) => cmd(`withhold(${j})`, (r) => void (r.state = withhold(r.state, fileAt(r, j))))),
    fc.option(fc.constantFrom(...MODES), { nil: undefined }).map((m) => cmd(`chatMode(${m})`, (r) => void (r.state = setAttachmentMode(r.state, m)))),
    fc.constantFrom(...MODES).map((m) => cmd(`settingMode(${m})`, (r) => void (r.fallback = m))),
    fc.boolean().map((v) => cmd(`vision(${v})`, (r) => void (r.vision = v))),
    fc.constantFrom('Private', 'Work/**', '*.mp3').map((p) =>
      cmd(`togglePattern(${p})`, (r) => {
        r.raw.spec.patterns = r.raw.spec.patterns.includes(p) ? r.raw.spec.patterns.filter((x) => x !== p) : [...r.raw.spec.patterns, p];
        r.index.refresh();
      }),
    ),
  ],
  { maxCommands: 30, size: 'large' },
);

describe('attachments in context (INVARIANTS.md A1)', () => {
  it('A1: an attachment reaches the model if and only if it is in context and can be sent; never an excluded one', async () => {
    await fc.assert(
      fc.asyncProperty(world, fc.constantFrom(...MODES), fc.boolean(), commands, async (w, fallback, vision, cmds) => {
        const { raw, index } = openWorld(w);
        const real: Real = { w, raw, index, state: EMPTY_CONTEXT, fallback, vision, n: 0 };
        await check(real);
        await fc.asyncModelRun(() => ({ model: real, real }), cmds);
      }),
    );
  });

  it('A1: removing an Upfront attachment keeps it out until it is added again', async () => {
    const w: World = {
      spec: {
        notes: [{ path: 'n.md', content: 'N', links: ['a.png'] }],
        attachments: ['a.png'],
        bytes: { 'a.png': pngBytes(10, 10, [0x51]) },
        patterns: [],
        obsidianFilters: [],
        respectObsidian: false,
      },
      kinds: new Map([['a.png', 'png']]),
      sentinels: new Map(),
      noteSentinels: new Map(),
    };
    const { index } = openWorld(w);
    let n = 0;
    let s = setAttachmentMode(addNote(EMPTY_CONTEXT, index, 'n.md', () => `c${++n}`).state, 'upfront');
    const sent = async () => (await prepareContext(s, index, { accepts: { images: true } })).images.map((i) => i.path);
    expect(await sent()).toEqual(['a.png']);
    s = withhold(s, 'a.png');
    expect(await sent()).toEqual([]);
    s = addAttachment(s, index, 'a.png', () => `c${++n}`).state;
    expect(await sent()).toEqual(['a.png']);
    // Removing the chip withholds it again, so Upfront does not bring it back.
    s = removeChip(s, s.chips.find((c) => c.kind === 'attachment')!.id);
    expect(await sent()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A2: converters

const dims = fc.record({ w: fc.integer({ min: 1, max: 16_384 }), h: fc.integer({ min: 1, max: 16_384 }) });
const tail = fc.array(fc.nat({ max: 255 }), { maxLength: 40 });
const validImage = fc.oneof(
  fc.tuple(dims, tail).map(([d, t]) => ({ ...d, mime: 'image/png', bytes: pngBytes(d.w, d.h, t) })),
  fc.tuple(dims, tail).map(([d, t]) => ({ ...d, mime: 'image/jpeg', bytes: jpegBytes(d.w, d.h, t) })),
  fc.tuple(dims, tail, fc.constantFrom<'VP8X' | 'VP8L'>('VP8X', 'VP8L')).map(([d, t, v]) => ({ ...d, mime: 'image/webp', bytes: webpBytes(v, d.w, d.h, t) })),
  // Lossy WebP stores each side in 14 bits, so 16,383 at most (seed 231711628: 16,384 is not expressible).
  fc
    .tuple(fc.record({ w: fc.integer({ min: 1, max: 16_383 }), h: fc.integer({ min: 1, max: 16_383 }) }), tail)
    .map(([d, t]) => ({ ...d, mime: 'image/webp', bytes: webpBytes('VP8 ', d.w, d.h, t) })),
);

/** Node's decoder replaces invalid UTF-8; valid input survives a round trip byte for byte. */
const isUtf8 = (b: Uint8Array) => Buffer.from(Buffer.from(b).toString('utf8'), 'utf8').equals(Buffer.from(b));

describe('converters (INVARIANTS.md A2)', () => {
  it('A2: text is the exact UTF-8 text, or refused', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ unit: 'grapheme' }).map((s) => new TextEncoder().encode(s)), fc.uint8Array({ maxLength: 64 })), async (bytes) => {
        const r = await textConverter.convert(bytes).then(
          (x) => x,
          () => null,
        );
        if (isUtf8(bytes)) {
          expect(r).toEqual({ kind: 'text', text: Buffer.from(bytes).toString('utf8'), tokens: Math.ceil(bytes.length / 3) });
        } else expect(r).toBeNull();
      }),
    );
  });

  it('A2: images are recognised by their bytes, sent exactly, with a bounded estimate', async () => {
    await fc.assert(
      fc.asyncProperty(validImage, async (img) => {
        expect(imageInfo(img.bytes)).toEqual({ mime: img.mime, width: img.w, height: img.h });
        const r = await imageConverter.convert(img.bytes);
        expect(r).toEqual({ kind: 'image', mime: img.mime, data: Buffer.from(img.bytes).toString('base64'), tokens: imageTokens(img.w, img.h) });
        expect(r.tokens).toBeGreaterThanOrEqual(IMAGE_TOKENS_MIN);
        expect(r.tokens).toBeLessThanOrEqual(IMAGE_TOKENS_MAX);
      }),
    );
    // More pixels never cost fewer tokens.
    fc.assert(
      fc.property(dims, dims, (a, b) => {
        if (a.w * a.h <= b.w * b.h) expect(imageTokens(a.w, a.h)).toBeLessThanOrEqual(imageTokens(b.w, b.h));
      }),
    );
  });

  it('reads a 1 × 1 lossless WebP, which is only 25 bytes (A2, seed -1506384488)', () => {
    const bytes = Uint8Array.from([82, 73, 70, 70, 17, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 5, 0, 0, 0, 47, 0, 0, 0, 0]);
    expect(imageInfo(bytes)).toEqual({ mime: 'image/webp', width: 1, height: 1 });
    // One byte short of the header is not an image.
    expect(imageInfo(bytes.subarray(0, 24))).toBeNull();
  });

  it('A2: anything else is refused as an image, whatever its extension', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 80 }), async (bytes) => {
        const info = imageInfo(bytes);
        const ok = await imageConverter.convert(bytes).then(
          () => true,
          () => false,
        );
        expect(ok).toBe(info !== null);
        if (info) {
          // Only a real signature gets this far.
          const head = Buffer.from(bytes.subarray(0, 12)).toString('latin1');
          expect(head.startsWith('\x89PNG') || (bytes[0] === 0xff && bytes[1] === 0xd8) || (head.startsWith('RIFF') && head.slice(8) === 'WEBP')).toBe(true);
          expect(info.width).toBeGreaterThan(0);
          expect(info.height).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('A2: lookup ignores case and finds one converter or none; none means skipped, never sent raw', () => {
    const registry = defaultConverters();
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), fc.constantFrom('', '.', '.png', '.PNG', '.Txt', '.pdf', '.tar.gz', '.md'), fc.boolean(), (name, ext, vision) => {
        const path = `Folder.d/${name.replace(/[./]/g, '')}${ext}`;
        const c = registry.forPath(path);
        const e = extensionOf(path);
        expect(c === null ? null : c.id).toBe(['png', 'jpg', 'jpeg', 'webp'].includes(e) ? 'image' : textConverter.extensions.includes(e) ? 'text' : null);
        const check = registry.check(path, 10, { images: vision });
        if (c === null) {
          expect(check.ok).toBe(false);
          expect(!check.ok && check.reason).toMatch(/can't send/);
        }
        else if (c.produces === 'image' && !vision) expect(check.ok).toBe(false);
        else expect(check.ok).toBe(true);
      }),
    );
    expect(() => registry.register({ ...textConverter, id: 'other', extensions: ['TXT'] })).toThrow();
    expect(() => registry.register({ ...textConverter, id: 'other', extensions: ['txt'] })).toThrow();
    expect(() => registry.register({ ...textConverter, id: 'other', extensions: ['md'] })).toThrow();
  });

  it('A2: a file is sendable only within its converter\'s size limit (mutant M2)', () => {
    const registry = defaultConverters();
    fc.assert(
      fc.property(fc.constantFrom('a.txt', 'b.png', 'c.JPG'), fc.integer({ min: -2, max: 2 }), (path, delta) => {
        const c = registry.forPath(path)!;
        const check = registry.check(path, c.maxBytes + delta, { images: true });
        expect(check.ok).toBe(delta <= 0);
        if (!check.ok) expect(check.reason).toMatch(/larger than the .* limit/);
      }),
    );
  });

  it('A2: the limit holds for the bytes actually read, even if the size on record is stale (mutant M2)', async () => {
    const spec = { notes: [], attachments: ['big.txt'], bytes: { 'big.txt': new Uint8Array(1_000_001).fill(0x41) }, patterns: [], obsidianFilters: [], respectObsidian: false };
    const raw = new FakeRawVault(spec);
    // The index saw a small file; it grew before it was read.
    raw.files = () => [{ path: 'big.txt', size: 10 }];
    const index = new ContextIndex(raw, () => exclusionsOf(spec));
    index.refresh();
    const p = await prepareContext(addAttachment(EMPTY_CONTEXT, index, 'big.txt', () => 'c').state, index);
    expect(p.message ?? '').not.toContain('AAAA');
    expect(p.skipped).toEqual([{ path: 'big.txt', reason: 'it is larger than the 1 MB limit for text files' }]);
  });

  it('A1: an attachment excluded after the index was built is refused at read time, so nothing is sent (mutant M7)', async () => {
    const spec = { notes: [], attachments: ['Later/a.txt'], bytes: { 'Later/a.txt': new TextEncoder().encode('LATERSENT') }, patterns: [] as string[], obsidianFilters: [], respectObsidian: false };
    const raw = new FakeRawVault(spec);
    const index = new ContextIndex(raw, () => exclusionsOf(spec));
    index.refresh();
    const state = addAttachment(EMPTY_CONTEXT, index, 'Later/a.txt', () => 'c').state;
    spec.patterns.push('Later'); // no refresh yet
    await expect(index.readAttachment('Later/a.txt')).rejects.toThrow(/may not read/);
    // Fail closed: the context can't be prepared, so the request is never sent.
    await expect(prepareContext(state, index)).rejects.toThrow(/may not read/);
    expect(raw.reads).toEqual([]);
  });

  it('A2: a converter registered for a new kind of file joins the same path (a PDF-to-text stand-in)', async () => {
    const pdf: AttachmentConverter = {
      id: 'pdf-test',
      label: 'PDFs',
      extensions: ['pdf'],
      produces: 'text',
      maxBytes: 1000,
      estimate: (size) => size,
      convert: (bytes) => Promise.resolve({ kind: 'text', text: `converted ${Buffer.from(bytes).toString('latin1')}`, tokens: bytes.length }),
    };
    const registry = defaultConverters();
    registry.register(pdf);
    const spec = {
      notes: [{ path: 'n.md', content: 'see ![[doc.pdf]]', links: ['doc.pdf'] }],
      attachments: ['doc.pdf'],
      bytes: { 'doc.pdf': new Uint8Array([...'PDFSENT'].map((c) => c.charCodeAt(0))) },
      patterns: [],
      obsidianFilters: [],
      respectObsidian: false,
    };
    const raw = new FakeRawVault(spec);
    const index = new ContextIndex(raw, () => exclusionsOf(spec), registry);
    index.refresh();
    const s = addNote(EMPTY_CONTEXT, index, 'n.md', () => 'c1').state;
    // Without the converter registered, it is skipped (and in Ask mode only listed).
    const plain = new ContextIndex(raw, () => exclusionsOf(spec));
    plain.refresh();
    const skipped = await prepareContext(setAttachmentMode(s, 'upfront'), plain);
    expect(skipped.message).not.toContain('PDFSENT');
    expect(skipped.skipped).toEqual([{ path: 'doc.pdf', reason: "Lektor can't send .pdf files yet" }]);
    // With it: Upfront sends its text, and so does a chip.
    for (const state of [setAttachmentMode(s, 'upfront'), addAttachment(s, index, 'doc.pdf', () => 'c2').state]) {
      const p = await prepareContext(state, index);
      expect(p.message).toContain('converted PDFSENT');
      expect(p.skipped).toEqual([]);
      expect(p.manifest.attachments?.map((a) => a.path)).toEqual(['doc.pdf']);
    }
  });

  it('A2: an empty registry sends no attachment at all', async () => {
    const spec = {
      notes: [{ path: 'n.md', content: 'x', links: ['a.txt'] }],
      attachments: ['a.txt'],
      bytes: { 'a.txt': new TextEncoder().encode('TXTSENT') },
      patterns: [],
      obsidianFilters: [],
      respectObsidian: false,
    };
    const index = new ContextIndex(new FakeRawVault(spec), () => exclusionsOf(spec), new ConverterRegistry());
    index.refresh();
    const p = await prepareContext(setAttachmentMode(addNote(EMPTY_CONTEXT, index, 'n.md', () => 'c').state, 'upfront'), index);
    expect(p.message).not.toContain('TXTSENT');
    expect(p.skipped.map((x) => x.path)).toEqual(['a.txt']);
  });
});
