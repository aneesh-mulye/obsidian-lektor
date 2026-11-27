// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // As in the build (esbuild.config.mjs): markdown-it gets Lektor's punycode stand-in, so tests check what ships.
  resolve: { alias: { 'punycode.js': new URL('./src/obsidian/ui/punycode.ts', import.meta.url).pathname } },
  // As in the build: markdown-it's own import of mdurl gets Lektor's copy of its parse.
  plugins: [
    {
      name: 'lektor-markdown-it-mdurl',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === 'mdurl' && importer && /[\\/]node_modules[\\/]markdown-it[\\/]/.test(importer)) return new URL('./src/obsidian/ui/mdurl.ts', import.meta.url).pathname;
        return null;
      },
    },
  ],
  test: {
    server: { deps: { inline: ['markdown-it'] } },
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // ESLint-backed property tests do real parsing; give them room in CI.
    testTimeout: process.env.CI ? 120_000 : 30_000,
  },
});
