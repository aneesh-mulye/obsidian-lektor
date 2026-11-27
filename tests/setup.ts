// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import fc from 'fast-check';

// 1,000 cases per property in CI, 100 locally (DESIGN.md § Testing).
// On failure fast-check prints the seed and path; turn it into a regression test.
// Lektor runs in Obsidian's window, and uses its timers (window.setTimeout) for popout-window
// compatibility, as Obsidian's review rules ask. Under Node the global object stands in for it.
(globalThis as { window?: unknown }).window ??= globalThis;

fc.configureGlobal({ numRuns: process.env.CI ? 1000 : 100 });
