// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for the three mdurl files src/obsidian/ui/mdurl.ts imports directly (mdurl types only its index). */

declare module 'mdurl/lib/decode.mjs' {
  import { decode } from 'mdurl';
  export default decode;
}
declare module 'mdurl/lib/encode.mjs' {
  import { encode } from 'mdurl';
  export default encode;
}
declare module 'mdurl/lib/format.mjs' {
  import { format } from 'mdurl';
  export default format;
}
declare module 'mdurl/lib/parse.mjs' {
  import type { Url } from 'mdurl';
  export default function parse(url: string, slashesDenoteHost?: boolean): Url;
}
