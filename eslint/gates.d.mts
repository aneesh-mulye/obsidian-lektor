// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Linter } from 'eslint';

export const CONTEXT_BROKER: string;
export const REVIEW_CONTROLLER: string;
export const PLUGIN_STORAGE: string;
export const GATE_RULES: readonly string[];
export const gateBlocks: Linter.Config[];
export type GateCategory = 'obsidian' | 'core' | 'cli' | 'context-broker' | 'review-controller' | 'plugin-storage';
export function gateCategory(path: string): GateCategory | null;
