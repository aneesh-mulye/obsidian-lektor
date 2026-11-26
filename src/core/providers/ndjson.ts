// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Newline-delimited JSON over a byte stream (INVARIANTS.md N1). */

export type NdjsonItem = { ok: true; value: unknown } | { ok: false; line: string };

function parse(line: string): NdjsonItem | null {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed.trim() === '') return null;
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, line: trimmed };
  }
}

/** Yields one item per non-blank line. Bad lines become `{ ok: false }`; never throws on input. */
export async function* decodeNdjson(body: AsyncIterable<Uint8Array>): AsyncGenerator<NdjsonItem> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const item = parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (item) yield item;
    }
  }
  buffer += decoder.decode();
  const last = parse(buffer);
  if (last) yield last;
}
