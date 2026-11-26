// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * URL provenance for fetch_page (DESIGN.md § Fetch provenance; INVARIANTS.md T3).
 * A URL is "known" if it appeared verbatim in this chat's search results, the
 * user's messages or attached notes. Matching is exact after normalisation,
 * which only lower-cases the scheme and host and drops the fragment, so no
 * data can be appended to a known URL without the user seeing it.
 */

/** The canonical form of an http(s) URL, or null for anything else (including URLs with credentials). */
export function normaliseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  return url.href;
}

const TRAILING = /[.,;:!?'"*_>]+$/;

/** http(s) URLs written in a piece of text, as a reader would see them. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`[\]]+/gi)) {
    let url = m[0].replace(TRAILING, '');
    // Drop a closing bracket that belongs to the surrounding text, e.g. "(https://x.example)" or "[a](https://x.example)".
    while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) {
      url = url.slice(0, -1).replace(TRAILING, '');
    }
    if (url.length > 'https://'.length) out.push(url);
  }
  return out;
}

export class KnownUrls {
  readonly #urls = new Set<string>();

  add(url: string): void {
    const n = normaliseUrl(url);
    if (n !== null) this.#urls.add(n);
  }

  addFrom(text: string): void {
    for (const u of extractUrls(text)) this.add(u);
  }

  has(url: string): boolean {
    const n = normaliseUrl(url);
    return n !== null && this.#urls.has(n);
  }
}
