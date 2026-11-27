// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fenced blocks (```lektor-edit, ```lektor-findings) in a reply from a model without tool calling.
 * As in CommonMark, a block opens and closes only with a fence at the start of a line (up to three
 * spaces before it), never at backticks inside the block: a JSON string can't hold a raw newline,
 * so a line of the block never starts with them, but a value may contain them (an edit to a note
 * with a code block, an explanation quoting one). INVARIANTS.md F1 (CI seed 814839752).
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body of every ```<lang> block, in order. A block without a closing fence line is not a block. */
export function fencedBlocks(reply: string, lang: string): string[] {
  const re = new RegExp('(?:^|\\n)[ ]{0,3}```' + escape(lang) + '[^\\n]*\\n(?:([\\s\\S]*?)\\n)?[ ]{0,3}```[ \\t]*(?=\\n|$)', 'g');
  return [...reply.matchAll(re)].map((m) => m[1] ?? '');
}
