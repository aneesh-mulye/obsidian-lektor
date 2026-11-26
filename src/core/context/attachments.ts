// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Attachment converters (DESIGN.md § Embeds and attachments; INVARIANTS.md A2).
 *
 * Every attachment reaches a model through a converter, which turns the
 * file's bytes into something the model can take: text, or an image for
 * models with vision. Each converter names its extensions, what it produces,
 * a size limit and a token estimate. A file with no converter is skipped with
 * a notice, never sent raw.
 *
 * Adding a kind of file is one converter and one registration line. Files that
 * can be reduced to text (PDFs, say) produce `text` and need nothing else:
 * they join the context message like any text attachment.
 */

import { tokensForBytes } from './tokens';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export type ConvertedAttachment =
  | { readonly kind: 'text'; readonly text: string; readonly tokens: number }
  | { readonly kind: 'image'; readonly mime: ImageMime; /** Base64 of the file's exact bytes. */ readonly data: string; readonly tokens: number };

export interface AttachmentConverter {
  readonly id: string;
  /** For notices: "text files", "images". */
  readonly label: string;
  /** Lower-case extensions, without the dot. */
  readonly extensions: readonly string[];
  /** Images need a model with vision; text goes to every model. */
  readonly produces: 'text' | 'image';
  /** Files larger than this are skipped. */
  readonly maxBytes: number;
  /** Estimated tokens from the file size, before the file is read (chips, previews, approval cards). */
  estimate(size: number): number;
  /** Throws AttachmentError if the bytes are not what this converter takes. */
  convert(bytes: Uint8Array): Promise<ConvertedAttachment>;
}

export class AttachmentError extends Error {
  override name = 'AttachmentError';
}

/** What the model can take, from its capabilities. */
export interface ModelAccepts {
  readonly images: boolean;
}

export type Sendability = { readonly ok: true; readonly converter: AttachmentConverter } | { readonly ok: false; readonly reason: string };

export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

const megabytes = (n: number) => `${Math.round((n / 1_000_000) * 10) / 10} MB`;

export class ConverterRegistry {
  readonly #byExtension = new Map<string, AttachmentConverter>();

  register(converter: AttachmentConverter): void {
    for (const ext of converter.extensions) {
      if (ext !== ext.toLowerCase() || ext.startsWith('.') || ext === '') throw new Error(`Bad extension "${ext}" for ${converter.id}.`);
      if (ext === 'md') throw new Error('Markdown files are notes, not attachments.');
      const other = this.#byExtension.get(ext);
      if (other) throw new Error(`.${ext} is already handled by ${other.id}.`);
    }
    for (const ext of converter.extensions) this.#byExtension.set(ext, converter);
  }

  forPath(path: string): AttachmentConverter | null {
    return this.#byExtension.get(extensionOf(path)) ?? null;
  }

  /** Whether a file can be sent to this model, before reading it. */
  check(path: string, size: number, accepts: ModelAccepts): Sendability {
    const converter = this.forPath(path);
    const ext = extensionOf(path);
    if (!converter) return { ok: false, reason: ext ? `Lektor can't send .${ext} files yet` : `Lektor can't send files without an extension` };
    if (converter.produces === 'image' && !accepts.images) return { ok: false, reason: 'this model can’t see images' };
    if (size > converter.maxBytes) return { ok: false, reason: `it is larger than the ${megabytes(converter.maxBytes)} limit for ${converter.label}` };
    return { ok: true, converter };
  }
}

// ---------------------------------------------------------------------------
// Text

const TEXT_EXTENSIONS = [
  'txt', 'text', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'tex', 'bib', 'rst', 'org', 'adoc', 'srt', 'vtt', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'swift', 'sh', 'bash', 'zsh', 'fish', 'sql', 'r', 'lua', 'pl', 'php',
];

export const textConverter: AttachmentConverter = {
  id: 'text',
  label: 'text files',
  extensions: TEXT_EXTENSIONS,
  produces: 'text',
  maxBytes: 1_000_000,
  estimate: tokensForBytes,
  convert(bytes) {
    let text: string;
    try {
      // `fatal`: bytes that are not UTF-8 are refused, never patched with U+FFFD. No BOM is stripped silently either.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return Promise.reject(new AttachmentError('it isn’t valid UTF-8 text'));
    }
    return Promise.resolve({ kind: 'text', text, tokens: tokensForBytes(bytes.length) });
  },
};

// ---------------------------------------------------------------------------
// Images

/** Before an image is read, its token count is unknown; this is what chips and cards show. */
export const IMAGE_TOKENS_GUESS = 1600;
export const IMAGE_TOKENS_MIN = 256;
export const IMAGE_TOKENS_MAX = 16_384;

/** Vision models cut images into patches of about 28 × 28 pixels; one token per patch, within a floor and a cap. */
export function imageTokens(width: number, height: number): number {
  return Math.min(IMAGE_TOKENS_MAX, Math.max(IMAGE_TOKENS_MIN, Math.ceil((width * height) / 784)));
}

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

/** The image's type and size, from its bytes alone (the extension is never trusted). Null if it is not a PNG, JPEG or WebP Lektor can read. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  const ok = (mime: ImageMime, width: number, height: number): ImageInfo | null => (width > 0 && height > 0 ? { mime, width, height } : null);
  // PNG: signature, then the IHDR chunk.
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR')) return ok('image/png', u32be(b, 16), u32be(b, 20));
  // JPEG: SOI, then segments up to a start-of-frame.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // markers without a length
        continue;
      }
      const length = u16be(b, i + 2);
      if (length < 2) return null;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return i + 9 <= b.length ? ok('image/jpeg', u16be(b, i + 7), u16be(b, i + 5)) : null;
      if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data, before any frame header
      i += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk.
  // Each chunk type needs a different number of header bytes: a 1 × 1 lossless image is only 25 bytes long.
  if (b.length >= 16 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    if (b.length >= 30 && ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return ok('image/webp', (b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff);
    }
    if (b.length >= 25 && ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return ok('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (b.length >= 30 && ascii(b, 12, 'VP8X')) return ok('image/webp', u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const imageConverter: AttachmentConverter = {
  id: 'image',
  label: 'images',
  extensions: ['png', 'jpg', 'jpeg', 'webp'],
  produces: 'image',
  maxBytes: 10_000_000,
  estimate: () => IMAGE_TOKENS_GUESS,
  convert(bytes) {
    const info = imageInfo(bytes);
    if (!info) return Promise.reject(new AttachmentError('it isn’t a PNG, JPEG or WebP image Lektor can read'));
    return Promise.resolve({ kind: 'image', mime: info.mime, data: toBase64(bytes), tokens: imageTokens(info.width, info.height) });
  },
};

/** The converters Lektor ships with. */
export function defaultConverters(): ConverterRegistry {
  const registry = new ConverterRegistry();
  registry.register(textConverter);
  registry.register(imageConverter);
  return registry;
}
