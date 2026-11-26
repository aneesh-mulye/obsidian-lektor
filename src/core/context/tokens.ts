// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Token estimates. Ollama has no tokenizer endpoint, so Lektor estimates
 * conservatively: one token per 3 bytes of UTF-8 (English text is nearer 4,
 * CJK about one character per token, which is also 3 bytes). The estimate for
 * a note's text equals the estimate from its file size, so the link-depth
 * preview matches what is sent (INVARIANTS.md X4).
 */

const encoder = new TextEncoder();

export function tokensForBytes(bytes: number): number {
  return Math.ceil(bytes / 3);
}

export function estimateTokens(text: string): number {
  return tokensForBytes(encoder.encode(text).length);
}

/** Per-message overhead for chat templates (role markers and the like). */
export const MESSAGE_OVERHEAD = 4;

/** Room kept free for the reply: a fifth of the window, between 1k and 8k tokens. */
export function replyReserve(window: number): number {
  return Math.min(8192, Math.max(1024, Math.round(window * 0.2)));
}

/** Whether a prompt of `estimate` tokens, scaled by `calibration`, leaves room for a reply. */
export function fits(estimate: number, calibration: number, window: number): boolean {
  return Math.ceil(estimate * calibration) + replyReserve(window) <= window;
}

/** `12345` → `12.3k`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}
