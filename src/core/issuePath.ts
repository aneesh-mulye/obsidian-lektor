// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A validation issue's path as text ("context.excludedFolders.0"), for messages. Built key by key
 * rather than with `.join('.')`: the Community directory's scanner reads an array joined with dots
 * as a domain name assembled at runtime (the 0.1.3 review), and these are setting names.
 */
export function issuePath(path: readonly PropertyKey[]): string {
  let out = '';
  path.forEach((key, i) => {
    out += (i === 0 ? '' : '.') + String(key);
  });
  return out;
}
