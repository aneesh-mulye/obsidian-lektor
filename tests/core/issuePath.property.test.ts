// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** issuePath gives the dotted text a join on dots would (src/core/issuePath.ts). */

import fc from 'fast-check';
import { expect, it } from 'vitest';
import { issuePath } from '../../src/core/issuePath';

it('issuePath is the keys separated by dots, in order', () => {
  fc.assert(
    fc.property(fc.array(fc.oneof(fc.string(), fc.nat(), fc.constantFrom('', '.', 'a.b'))), (path) => {
      expect(issuePath(path)).toBe(path.map(String).join('.'));
    }),
  );
  expect(issuePath(['context', 'excludedFolders', 0])).toBe('context.excludedFolders.0');
  expect(issuePath([])).toBe('');
});
