// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AttachmentMode } from '../settings';
import { AttachmentError, type ImageMime, type ModelAccepts } from './attachments';
import type { ContextIndex } from './ContextIndex';
import { sha256Bytes } from './hash';
import { type AttachmentList, type BacklinkList, type Via, planContext } from './plan';
import type { ContextState } from './state';

export interface AssembledNote {
  path: string;
  via: Via;
  content: string;
}

/** An attachment converted to text: sent as an item of the context message. */
export interface AssembledText {
  path: string;
  text: string;
  hash: string;
}

/** An image: sent in the request's images, never as text. */
export interface AssembledImage {
  path: string;
  mime: ImageMime;
  /** Base64 of the file's exact bytes. */
  data: string;
  tokens: number;
  hash: string;
}

export interface Skipped {
  path: string;
  /** Why it was not sent, e.g. "this model can’t see images". */
  reason: string;
}

export interface AssembledContext {
  notes: AssembledNote[];
  backlinkLists: BacklinkList[];
  selections: Array<{ path: string; text: string }>;
  texts: AssembledText[];
  images: AssembledImage[];
  /** Attachments in context that could not be sent, with the reason (shown to the user). */
  skipped: Skipped[];
  /** Attachments notes link to that are not sent (paths only). */
  attachmentLists: AttachmentList[];
  /** Excluded notes and files left out (for the user's "N excluded skipped"). */
  excluded: number;
}

export interface AssembleOptions {
  /** The setting, for chats that never chose an attachment mode. */
  attachmentMode?: AttachmentMode;
  /** What the model can take; without vision, images are skipped. */
  accepts?: ModelAccepts;
}

export type ConvertResult =
  | { ok: true; part: { kind: 'text'; text: string } | { kind: 'image'; mime: ImageMime; data: string; tokens: number }; hash: string }
  | { ok: false; reason: string };

/** Read one attachment through the filtered index and convert it, or say why it can't be sent. Nothing is read if it can't be. */
export async function convertAttachment(index: ContextIndex, path: string, accepts: ModelAccepts): Promise<ConvertResult> {
  const meta = index.attachment(path);
  if (!meta) return { ok: false, reason: 'it is excluded or no longer exists' };
  const check = index.converters.check(path, meta.size, accepts);
  if (!check.ok) return check;
  const bytes = await index.readAttachment(path);
  // The size on record may be stale; the limit holds for what was actually read.
  if (bytes.length > check.converter.maxBytes) {
    const again = index.converters.check(path, bytes.length, accepts);
    return { ok: false, reason: again.ok ? 'it changed while Lektor was reading it' : again.reason };
  }
  try {
    const part = await check.converter.convert(bytes);
    return { ok: true, part, hash: await sha256Bytes(bytes) };
  } catch (err) {
    if (err instanceof AttachmentError) return { ok: false, reason: err.message };
    throw err;
  }
}

/** Read exactly the planned notes and attachments, through the filtered index (INVARIANTS.md X2, A1). */
export async function assembleContext(state: ContextState, index: ContextIndex, options: AssembleOptions = {}): Promise<AssembledContext> {
  const plan = planContext(state, index, options.attachmentMode);
  const accepts = options.accepts ?? { images: false };
  const notes: AssembledNote[] = [];
  for (const n of plan.notes) notes.push({ path: n.path, via: n.via, content: await index.read(n.path) });
  const texts: AssembledText[] = [];
  const images: AssembledImage[] = [];
  const skipped: Skipped[] = [];
  for (const a of plan.attachments) {
    const r = await convertAttachment(index, a.path, accepts);
    if (!r.ok) skipped.push({ path: a.path, reason: r.reason });
    else if (r.part.kind === 'text') texts.push({ path: a.path, text: r.part.text, hash: r.hash });
    else images.push({ path: a.path, mime: r.part.mime, data: r.part.data, tokens: r.part.tokens, hash: r.hash });
  }
  return {
    notes,
    backlinkLists: plan.backlinkLists,
    selections: plan.selections.map(({ path, text }) => ({ path, text })),
    texts,
    images,
    skipped,
    attachmentLists: plan.attachmentLists,
    excluded: plan.excluded.size,
  };
}
