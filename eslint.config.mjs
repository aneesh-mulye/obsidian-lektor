// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { gateBlocks } from './eslint/gates.mjs';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
};

export default tseslint.config(
  { name: 'lektor/ignores', ignores: ['main.js', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,

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
