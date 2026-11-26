// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md G5: the project config applies the gates unchanged. */

import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { GATE_RULES, gateBlocks, gateCategory } from '../../eslint/gates.mjs';
import { ROOT, categoryOf } from './harness';

const PATHS = [
  'src/main.ts',
  'src/obsidian/LektorView.tsx',
  'src/obsidian/SettingsTab.ts',
  'src/obsidian/ui/Sidebar.tsx',
  'src/obsidian/ContextBroker.ts',
  'src/obsidian/ReviewController.ts',
  'src/obsidian/ContextBroker.tsx',
  'src/core/settings.ts',
  'src/core/deep/nested/thing.ts',
  'src/core/cli/claude.ts',
  'src/core/cli/codex/args.ts',
];

const project = new ESLint({ cwd: ROOT });
const gatesOnly = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: gateBlocks });

function gateRules(config: Linter.Config): Record<string, unknown> {
  const rules = config.rules ?? {};
  return Object.fromEntries(GATE_RULES.map((r) => [r, rules[r]]));
}

describe('eslint.config.mjs (INVARIANTS.md G5)', () => {
  it.each(PATHS)('applies the gates unchanged to %s', async (path) => {
    const actual = (await project.calculateConfigForFile(`${ROOT}${path}`)) as Linter.Config;
    const expected = (await gatesOnly.calculateConfigForFile(`${ROOT}${path}`)) as Linter.Config;
    expect(gateRules(expected)['no-restricted-syntax']).toBeDefined();
    expect(gateRules(actual)).toEqual(gateRules(expected));
  });

  it.each(PATHS)('gateCategory() agrees with the reference classifier for %s', (path) => {
    expect(gateCategory(path)).toBe(categoryOf(path));
  });

  it('gates every source file, so none falls through to an ungated config', async () => {
    const files = await import('node:fs').then((fs) =>
      fs.readdirSync(`${ROOT}src`, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|tsx)$/.test(f)),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const config = (await project.calculateConfigForFile(`${ROOT}src/${f}`)) as Linter.Config;
      expect(gateRules(config)['no-restricted-syntax'], `src/${f}`).toBeDefined();
    }
  });
});
