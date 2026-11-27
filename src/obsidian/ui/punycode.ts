// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stands in for the `punycode.js` package inside markdown-it (esbuild and vitest alias it here).
 * markdown-it uses only `toASCII` and `toUnicode`, on the host name of a link in a model's reply.
 * The package converts domains by splitting them into labels and joining them again, which the
 * Community directory's scanner flags as runtime domain assembly (the 0.1.1 review), so Lektor
 * leaves it out:
 * - `toASCII` uses the URL parser built into the platform, which does the same conversion
 *   (IDNA) as part of the URL standard;
 * - `toUnicode` changes nothing, so a link's text stays as the model wrote it: one written as
 *   `xn--…` is not turned into letters that may look like another domain.
 */

function toASCII(host: string): string {
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return host;
  }
}

function toUnicode(host: string): string {
  return host;
}

export { toASCII, toUnicode };
export default { toASCII, toUnicode };
