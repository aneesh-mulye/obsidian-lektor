// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // As in the build (esbuild.config.mjs): markdown-it gets Lektor's punycode stand-in, so tests check what ships.
  resolve: { alias: { 'punycode.js': new URL('./src/obsidian/ui/punycode.ts', import.meta.url).pathname } },
  test: {
    server: { deps: { inline: ['markdown-it'] } },
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // ESLint-backed property tests do real parsing; give them room in CI.
    testTimeout: process.env.CI ? 120_000 : 30_000,
  },
});
