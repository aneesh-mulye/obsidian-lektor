// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which vault paths Lektor must never share (INVARIANTS.md X1).
 *
 * - Lektor's own patterns are gitignore-style globs: a pattern without a slash
 *   (`Private`, `*.secret.md`) matches that name at any depth; a pattern with
 *   a slash (`Work/Clients`, `/Templates`) is anchored at the vault root.
 *   Every pattern is tested against the path *and each of its folders*, so
 *   excluding a folder excludes everything inside it.
 * - Obsidian's "Excluded files" entries are path prefixes, or `/regex/`.
 * - Hidden files and folders (any segment starting with "."), the config
 *   folder and `.lektor/` are always excluded.
 * - Matching ignores case. Anything that cannot be understood excludes
 *   everything (fail closed), and `problem` says why.
 */

import picomatch from 'picomatch';

export interface ExclusionInputs {
  /** Lektor's excluded-folder patterns (`['**']` while the stored list is unreadable). */
  patterns: readonly string[];
  /** Obsidian's "Excluded files"; null when not respected; 'unreadable' if the setting exists but could not be read. */
  obsidianFilters: readonly string[] | null | 'unreadable';
  /** The vault's config folder, e.g. `.obsidian`. */
  configDir: string;
}

export interface Exclusions {
  isExcluded(path: string): boolean;
  /** Set when an entry could not be understood; everything is excluded until it is fixed. */
  readonly problem: string | null;
}

type Test = (candidate: string, segment: string) => boolean;

/** The path itself and every folder above it, e.g. `a`, `a/b`, `a/b/c.md`. */
function prefixes(path: string): string[] {
  const parts = path.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function compilePattern(raw: string): Test {
  let p = raw.trim().replace(/\/+$/, '');
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  if (p === '') return () => false;
  // Validate first. picomatch throws on unbalanced brackets, and compiles patterns it cannot
  // make sense of (such as `[z-a]`) to /$^/, which would silently exclude nothing: fail closed.
  if (picomatch.makeRe(p, { nocase: true, dot: true, strictBrackets: true }).source === '$^') {
    throw new Error(`invalid pattern ${p}`);
  }
  const match = picomatch(p, { nocase: true, dot: true, strictBrackets: true });
  return anchored ? (candidate) => match(candidate) : (_candidate, segment) => match(segment);
}

function compileObsidianFilter(raw: string): Test {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(raw);
  if (regex) {
    const flags = regex[2]!.includes('i') ? regex[2]! : `${regex[2]!}i`;
    const re = new RegExp(regex[1]!, flags.replace(/[gy]/g, ''));
    return (candidate) => re.test(candidate);
  }
  const prefix = raw.toLowerCase();
  if (prefix === '') return () => false;
  return (candidate) => candidate.toLowerCase().startsWith(prefix);
}

export function compileExclusions(inputs: ExclusionInputs): Exclusions {
  const tests: Test[] = [];
  let problem: string | null = null;

  for (const p of inputs.patterns) {
    try {
      tests.push(compilePattern(p));
    } catch {
      problem ??= `The excluded-folder pattern ${JSON.stringify(p)} is not a valid pattern.`;
    }
  }
  if (inputs.obsidianFilters === 'unreadable') {
    problem = 'Obsidian\'s "Excluded files" setting could not be read.';
  }
  for (const f of inputs.obsidianFilters === 'unreadable' ? [] : (inputs.obsidianFilters ?? [])) {
    try {
      tests.push(compileObsidianFilter(f));
    } catch {
      problem ??= `Obsidian's excluded-files entry ${JSON.stringify(f)} is not a valid pattern.`;
    }
  }
  const configDir = inputs.configDir.toLowerCase();

  return {
    problem,
    isExcluded(path: string): boolean {
      if (problem !== null) return true;
      const segments = path.split('/');
      // Malformed paths and hidden segments are never shared.
      if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return true;
      if (segments[0]!.toLowerCase() === configDir) return true;
      const candidates = prefixes(path);
      return candidates.some((c, i) => tests.some((t) => t(c, segments[i]!)));
    },
  };
}
