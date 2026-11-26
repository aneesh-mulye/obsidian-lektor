// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import fc from 'fast-check';

// 1,000 cases per property in CI, 100 locally (DESIGN.md § Testing).
// On failure fast-check prints the seed and path; turn it into a regression test.
fc.configureGlobal({ numRuns: process.env.CI ? 1000 : 100 });
