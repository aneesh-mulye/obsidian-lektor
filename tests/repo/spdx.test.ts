// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** CLAUDE.md: every source file carries an SPDX header (AGPL-3.0-or-later, or MIT for lifted files). */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../lint/harness';

const SOURCE = /\.(ts|tsx|mts|mjs|css)$/;

function sources(): string[] {
  const roots = ['src', 'tests', 'eslint'];
  const files = roots.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => SOURCE.test(f))
      .map((f) => `${dir}/${f}`),
  );
  const top = readdirSync(ROOT).filter((f) => SOURCE.test(f));
  return [...files, ...top];
}

describe('SPDX headers', () => {
  it.each(sources())('%s has an SPDX licence identifier', (file) => {
    const head = readFileSync(join(ROOT, file), 'utf8').split('\n').slice(0, 12).join('\n');
    expect(head).toMatch(/SPDX-License-Identifier: (AGPL-3\.0-or-later|MIT)\b/);
    expect(head).toMatch(/SPDX-FileCopyrightText: /);
  });
});
