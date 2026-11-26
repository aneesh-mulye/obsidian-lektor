// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';
import { GATE_RULES, gateBlocks } from '../../eslint/gates.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export type Category = 'obsidian' | 'core' | 'cli' | 'context-broker' | 'review-controller';
export const ALL: readonly Category[] = ['obsidian', 'core', 'cli', 'context-broker', 'review-controller'];

/**
 * The test's own path classifier: the reference model for which gate applies.
 * Deliberately written separately from gateCategory() in eslint/gates.mjs.
 */
export function categoryOf(path: string): Category {
  if (path === 'src/obsidian/ContextBroker.ts') return 'context-broker';
  if (path === 'src/obsidian/ReviewController.ts') return 'review-controller';
  const parts = path.split('/');
  if (parts[1] === 'core' && parts[2] === 'cli' && parts.length > 3) return 'cli';
  if (parts[1] === 'core') return 'core';
  return 'obsidian';
}

/** Gates only, with a plain (non-type-aware) TS parser, so snippets lint without a tsconfig. */
const gatesOnly = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } },
    ...gateBlocks,
  ],
});

export interface GateResult {
  errors: Linter.LintMessage[];
}

export async function lintGates(code: string, path: string): Promise<GateResult> {
  const [result] = await gatesOnly.lintText(code, { filePath: `${ROOT}${path}` });
  if (!result) throw new Error('ESLint returned no result');
  const fatal = result.messages.find((m) => m.fatal);
  if (fatal) throw new Error(`Snippet failed to parse (${path}): ${fatal.message}\n${code}`);
  const unmatched = result.messages.find((m) => m.ruleId === null);
  if (unmatched) throw new Error(`ESLint did not lint ${path}: ${unmatched.message}`);
  return { errors: result.messages.filter((m) => m.ruleId !== null && GATE_RULES.includes(m.ruleId)) };
}
