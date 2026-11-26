// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Per-message caps on searches and fetches (DESIGN.md § Caps; INVARIANTS.md T2). One budget per user message. */
export class ToolBudget {
  readonly used = { searches: 0, fetches: 0 };

  constructor(private readonly limits: { searches: number; fetches: number }) {}

  /** Count one use; false (and nothing counted) if the cap is reached. */
  take(kind: 'searches' | 'fetches'): boolean {
    if (this.used[kind] >= this.limits[kind]) return false;
    this.used[kind] += 1;
    return true;
  }
}
