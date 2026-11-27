// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Codex's model catalog (INVARIANTS.md C2). Lektor reads it from
 * `codex debug models` to list models, and writes a one-model catalog for each
 * run, Codex's own entry with `apply_patch` and the experimental tools taken
 * out. That catalog is also what stops Codex refreshing its list mid-run.
 */

import type { ModelInfo } from '../../providers/types';
import { CliError } from './args';

export interface CodexModelEntry {
  slug: string;
  [key: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `{ models: [...] }` JSON Codex prints. Fails closed on anything else. */
export function parseCatalog(json: string): CodexModelEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new CliError('Codex’s model list could not be read.');
  }
  if (!isObject(raw) || !Array.isArray(raw['models'])) throw new CliError('Codex’s model list could not be read.');
  const models = raw['models'].filter((m): m is CodexModelEntry => isObject(m) && typeof m['slug'] === 'string' && m['slug'] !== '');
  if (models.length === 0) throw new CliError('Codex listed no models.');
  return models;
}

/** Codex's context budget for a model: its window, less the share Codex keeps for itself. */
export function contextWindow(entry: CodexModelEntry | undefined): number {
  const w = entry?.['context_window'];
  const pct = entry?.['effective_context_window_percent'];
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return 200_000;
  return Math.floor((w * (typeof pct === 'number' && pct > 0 && pct <= 100 ? pct : 100)) / 100);
}

/** The models the picker shows: the catalog's visible ones, in its order. */
export function visibleModels(entries: readonly CodexModelEntry[]): ModelInfo[] {
  return entries
    .filter((m) => m['visibility'] === 'list')
    .map((m) => ({ id: m.slug, name: typeof m['display_name'] === 'string' && m['display_name'] ? m['display_name'] : m.slug, contextWindow: contextWindow(m) }));
}

/** The one-model catalog for a run: Codex's own entry, with no apply_patch and no experimental tools. */
export function runCatalog(entries: readonly CodexModelEntry[], slug: string): string {
  const entry = entries.find((m) => m.slug === slug);
  if (!entry) throw new CliError(`Codex doesn’t list the model "${slug.slice(0, 60)}".`);
  return JSON.stringify({ models: [{ ...entry, apply_patch_tool_type: null, experimental_supported_tools: [] }] });
}

/** The model for the daily real check: the first visible "luna" (the smallest), or the first visible model. */
export function checkModel(entries: readonly CodexModelEntry[]): string {
  const visible = entries.filter((m) => m['visibility'] === 'list');
  const pick = visible.find((m) => /-luna$/.test(m.slug)) ?? visible[0] ?? entries[0];
  if (!pick) throw new CliError('Codex listed no models.');
  return pick.slug;
}
