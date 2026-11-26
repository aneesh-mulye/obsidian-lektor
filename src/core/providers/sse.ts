// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server-sent events over a byte stream (the WHATWG format both compatible
 * APIs stream in; INVARIANTS.md E1). Lines end in LF, CRLF or CR, wherever
 * the chunks are cut. A blank line ends an event; `data:` lines join with
 * "\n"; `:` lines are comments. Never throws on input.
 */

export interface SseEvent {
  /** The `event:` field, or "message". */
  event: string;
  data: string;
}

export async function* decodeSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let first = true;

  function* line(raw: string): Generator<SseEvent> {
    let l = raw;
    if (first) {
      if (l.startsWith('\uFEFF')) l = l.slice(1);
      first = false;
    }
    if (l === '') {
      if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    // id, retry and unknown fields are ignored.
  }

  function* drain(final: boolean): Generator<SseEvent> {
    for (;;) {
      const i = buffer.search(/[\r\n]/);
      if (i === -1) return;
      // A CR at the very end may be the first half of a CRLF still to come.
      if (buffer[i] === '\r' && i === buffer.length - 1 && !final) return;
      const end = buffer[i] === '\r' && buffer[i + 1] === '\n' ? i + 2 : i + 1;
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(end);
      yield* line(raw);
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
  // A last line without its line end, then an event without its blank line: both are still delivered.
  if (buffer !== '') yield* line(buffer);
  buffer = '';
  yield* line('');
}
