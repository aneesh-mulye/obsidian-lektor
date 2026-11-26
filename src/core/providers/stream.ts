// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Wraps a provider's raw event stream so the stream contract (INVARIANTS.md O1)
 * holds whatever the provider does: exactly one `done`, last; nothing after an
 * observed abort except `done: aborted`; a throw or an early end becomes
 * `error` + `done: error`. Every provider's `stream()` returns through this.
 */

import type { ChatEvent, DoneReason } from './types';

export class ProviderError extends Error {
  override name = 'ProviderError';
}

function describe(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  if (err instanceof Error && err.message) return `Connection failed: ${err.message}`;
  return 'Connection failed.';
}

export async function* guardStream(inner: () => AsyncIterable<ChatEvent>, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const done = (reason: DoneReason): ChatEvent => ({ type: 'done', reason: signal.aborted ? 'aborted' : reason });

  function* fail(message: string): Generator<ChatEvent> {
    if (!signal.aborted) yield { type: 'error', message };
    yield done('error');
  }

  if (signal.aborted) {
    yield done('aborted');
    return;
  }

  let iterator: AsyncIterator<ChatEvent> | undefined;
  try {
    iterator = inner()[Symbol.asyncIterator]();
    for (;;) {
      let step: IteratorResult<ChatEvent>;
      try {
        step = await iterator.next();
      } catch (err) {
        yield* fail(describe(err));
        return;
      }
      if (signal.aborted) {
        yield done('aborted');
        return;
      }
      if (step.done) {
        yield* fail('The reply ended before it finished.');
        return;
      }
      const event = step.value;
      if (event.type === 'done') {
        yield done(event.reason);
        return;
      }
      yield event;
      if (signal.aborted) {
        yield done('aborted');
        return;
      }
    }
  } finally {
    try {
      void iterator?.return?.();
    } catch {
      // The inner stream is being abandoned; nothing more to do.
    }
  }
}
