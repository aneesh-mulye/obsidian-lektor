// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { guardStream } from '../../src/core/providers/stream';
import type { ChatEvent } from '../../src/core/providers/types';

describe('guardStream', () => {
  it('ends promptly on abort even if the provider ignores the signal and hangs', async () => {
    async function* hangs(): AsyncGenerator<ChatEvent> {
      yield { type: 'text', text: 'a' };
      await new Promise(() => {}); // never resolves
    }
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const e of guardStream(hangs, controller.signal)) {
      events.push(e);
      controller.abort();
    }
    expect(events).toEqual([{ type: 'text', text: 'a' }, { type: 'done', reason: 'aborted' }]);
  });

  it('drops anything a provider yields after done', async () => {
    async function* chatty(): AsyncGenerator<ChatEvent> {
      await Promise.resolve();
      yield { type: 'done', reason: 'stop' };
      yield { type: 'text', text: 'late' };
    }
    const events: ChatEvent[] = [];
    for await (const e of guardStream(chatty, new AbortController().signal)) events.push(e);
    expect(events).toEqual([{ type: 'done', reason: 'stop' }]);
  });
});
