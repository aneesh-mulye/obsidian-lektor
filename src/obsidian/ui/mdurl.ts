// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What markdown-it gets for `import * as mdurl from "mdurl"` (esbuild.config.mjs and
 * vitest.config.mts redirect that one import here): mdurl's own encode, decode and format, and
 * Lektor's copy of its parse, which checks host names without splitting and joining them
 * (see mdurl-parse.ts). The three are imported file by file: mdurl's index also loads its parse,
 * which can't be left out of the bundle once loaded.
 */

import decode from 'mdurl/lib/decode.mjs';
import encode from 'mdurl/lib/encode.mjs';
import format from 'mdurl/lib/format.mjs';

export { decode, encode, format };
export { default as parse } from './mdurl-parse';
