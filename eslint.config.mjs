// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { gateBlocks } from './eslint/gates.mjs';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
};

export default tseslint.config(
  { name: 'lektor/ignores', ignores: ['main.js', 'node_modules/**', 'coverage/**'] },

  { ...js.configs.recommended, files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'] },

  // The rules Obsidian's automated directory review uses (docs/PUBLISHING.md). Lektor's own blocks below
  // add to them, and the hard-rule gates stay last. One rule is left to the gates: no-restricted-globals,
  // which they set for every file (INVARIANTS.md G5 requires their exact config). Obsidian's version would
  // add `app`, `fetch` and `localStorage`. Lektor uses neither global `app` nor `localStorage`, and `fetch`
  // is the gates' business (allowed only in src/obsidian/Http.ts).
  ...obsidianmd.configs.recommended.map((block) => {
    if (!block.rules || !('no-restricted-globals' in block.rules)) return block;
    const { 'no-restricted-globals': _gated, ...rules } = block.rules;
    return { ...block, rules };
  }),

  {
    name: 'lektor/typescript',
    files: ['**/*.{ts,tsx,mts}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  {
    name: 'lektor/scripts',
    files: ['**/*.mjs'],
    languageOptions: { globals: nodeGlobals },
  },

  // The hard-rule gates. Must stay last: see eslint/gates.mjs and INVARIANTS.md G5.
  ...gateBlocks,
);
