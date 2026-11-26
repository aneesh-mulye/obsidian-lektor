// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md X1: exclusion matching is fail-closed. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileExclusions } from '../../src/core/context/exclusions';

const segment = fc.oneof(
  fc.constantFrom('Private', 'private', 'PRIVATE', 'Work', 'Clients', 'Notes', 'Deep', 'Journal', 'Templates', 'Archive', 'note.md', 'x.secret.md', 'Ünï', 'a b'),
  fc.stringMatching(/^[A-Za-z0-9 _-]{1,8}$/),
);
const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
const pattern = fc.oneof(
  fc.constantFrom('Private', 'private/**', 'Work/Clients', '*.secret.md', 'Arch*', 'Journal/', '/Templates', 'NOTES/deep/**', 'Deep', '**/Clients', '{Work,Journal}'),
  segment,
);
const obsidianFilter = fc.constantFrom('Templates/', 'Archive', '/^Journal\\//', '/secret/i', 'Work/Cl');
const inputs = fc.record({
  patterns: fc.array(pattern, { maxLength: 4 }),
  obsidianFilters: fc.option(fc.array(obsidianFilter, { maxLength: 3 }), { nil: null }),
  configDir: fc.constantFrom('.obsidian', '.config'),
});

const swapCase = (s: string) => s.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

describe('compileExclusions (INVARIANTS.md X1)', () => {
  it('X1: closed under descendants', () => {
    fc.assert(
      fc.property(inputs, path, segment, (cfg, p, child) => {
        const ex = compileExclusions(cfg);
        if (ex.isExcluded(p)) expect(ex.isExcluded(`${p}/${child}`)).toBe(true);
      }),
    );
  });

  it('X1: monotonic in patterns and filters', () => {
    fc.assert(
      fc.property(inputs, pattern, obsidianFilter, path, (cfg, extraPattern, extraFilter, p) => {
        const before = compileExclusions(cfg).isExcluded(p);
        const after = compileExclusions({
          ...cfg,
          patterns: [...cfg.patterns, extraPattern],
          obsidianFilters: [...(cfg.obsidianFilters ?? []), extraFilter],
        }).isExcluded(p);
        if (before) expect(after).toBe(true);
      }),
    );
  });

  it('X1: blind to ASCII case', () => {
    fc.assert(
      fc.property(inputs, path, (cfg, p) => {
        const ex = compileExclusions(cfg);
        expect(ex.isExcluded(swapCase(p))).toBe(ex.isExcluded(p));
      }),
    );
  });

  it('X1: hidden segments, the config folder and .lektor are always excluded', () => {
    fc.assert(
      fc.property(inputs, path, fc.constantFrom('.hidden', '.lektor', '.git', '.trash'), fc.nat({ max: 3 }), (cfg, p, hidden, at) => {
        const parts = p.split('/');
        parts.splice(Math.min(at, parts.length - 1), 0, hidden);
        const ex = compileExclusions(cfg);
        expect(ex.isExcluded(parts.join('/'))).toBe(true);
        expect(ex.isExcluded(`${cfg.configDir}/plugins/x.md`)).toBe(true);
        expect(ex.isExcluded(`.lektor/presets/Proofread.md`)).toBe(true);
      }),
    );
  });

  it('X1: a bare name excludes exactly the paths with a segment of that name', () => {
    fc.assert(
      fc.property(fc.constantFrom('Private', 'Work', 'Deep', 'note.md'), path, (name, p) => {
        const ex = compileExclusions({ patterns: [name], obsidianFilters: null, configDir: '.obsidian' });
        const hasSegment = p.split('/').some((s) => s.toLowerCase() === name.toLowerCase());
        expect(ex.isExcluded(p)).toBe(hasSegment);
      }),
    );
  });

  it('X1: invalid patterns and the unreadable-list sentinel exclude everything', () => {
    fc.assert(
      fc.property(path, fc.constantFrom<[string[], string[] | null]>([['**'], null], [['ok', '**'], null], [[], ['/(unclosed/']], [['[z-a]'], null], [['Private['], null], [['{a,b'], null], [['\\'], null]), (p, [patterns, filters]) => {
        const ex = compileExclusions({ patterns, obsidianFilters: filters, configDir: '.obsidian' });
        expect(ex.isExcluded(p)).toBe(true);
      }),
    );
  });

  it('examples', () => {
    const ex = compileExclusions({ patterns: ['Private', 'Work/Clients', '*.secret.md'], obsidianFilters: ['Templates/', '/^Journal\\//'], configDir: '.obsidian' });
    expect(ex.isExcluded('Private/diary.md')).toBe(true);
    expect(ex.isExcluded('Notes/private/x.md')).toBe(true);
    expect(ex.isExcluded('Work/Clients/acme.md')).toBe(true);
    expect(ex.isExcluded('Other/Work/Clients/acme.md')).toBe(false);
    expect(ex.isExcluded('Work/plan.md')).toBe(false);
    expect(ex.isExcluded('Notes/plan.secret.md')).toBe(true);
    expect(ex.isExcluded('Templates/daily.md')).toBe(true);
    expect(ex.isExcluded('Journal/2026-11-26.md')).toBe(true);
    expect(ex.isExcluded('Notes/Journal.md')).toBe(false);
    expect(ex.isExcluded('README.md')).toBe(false);
    expect(ex.problem).toBeNull();
    expect(compileExclusions({ patterns: [], obsidianFilters: ['/(/'], configDir: '.obsidian' }).problem).toContain('/(/');
    const unreadable = compileExclusions({ patterns: [], obsidianFilters: 'unreadable', configDir: '.obsidian' });
    expect(unreadable.isExcluded('README.md')).toBe(true);
    expect(unreadable.problem).toContain('could not be read');
  });
});
