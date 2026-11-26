// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * INVARIANTS.md L3, L4: within the CLI bridges (where the gates allow raw
 * file, process and network access), each kind of access lives in one small
 * module, and that module does only what it must.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './harness';

const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const files = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => `src/${f}`);

/** Every module a file imports (static imports and require), by specifier. */
const imports = (code: string): string[] => [...code.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const only = (specs: string[], file: string) => {
  for (const f of files) {
    const hits = imports(source(f)).filter((s) => specs.includes(s));
    if (hits.length > 0) expect(f, `${f} imports ${hits.join(', ')}`).toBe(file);
  }
};

describe('CLI bridge sources (INVARIANTS.md L3, L4)', () => {
  it('L3: fs, os and path only in src/core/cli/fs.ts, which never reads a file’s contents', () => {
    only(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'original-fs', 'os', 'node:os', 'path', 'node:path'], 'src/core/cli/fs.ts');
    const fsCode = source('src/core/cli/fs.ts');
    for (const read of ['readFile', 'createReadStream', 'readSync', 'open(', 'readlink', 'opendir', 'cp(', 'copyFile', 'rename', 'symlink', 'chmod']) expect(fsCode, read).not.toContain(read);
    // What it may do: make the run folder, write the fixed files, list void/, remove its own folders, check an executable.
    const fsCalls = new Set([...fsCode.matchAll(/\b(mkdtemp|mkdir|writeFile|readdir|rm|access|stat)\(/g)].map((m) => m[1]));
    expect(fsCalls).toEqual(new Set(['mkdtemp', 'mkdir', 'writeFile', 'readdir', 'rm', 'access']));
  });

  it('L3: child_process only in src/core/cli/spawn.ts, never with a shell', () => {
    only(['child_process', 'node:child_process'], 'src/core/cli/spawn.ts');
    const spawnCode = source('src/core/cli/spawn.ts');
    expect(spawnCode).toMatch(/shell: false/);
    expect(spawnCode).not.toMatch(/shell: true|exec\(|execSync|execFile|spawnSync/);
  });

  it('L4: http and net only in src/core/cli/mcp.ts, listening on 127.0.0.1 only', () => {
    only(['http', 'node:http', 'net', 'node:net', 'https', 'node:https'], 'src/core/cli/mcp.ts');
    const mcpCode = source('src/core/cli/mcp.ts');
    expect([...mcpCode.matchAll(/\.listen\(/g)]).toHaveLength(1);
    expect(mcpCode).toMatch(/\.listen\(0, '127\.0\.0\.1',/);
    expect(mcpCode).toMatch(/refuse\(/);
  });

  it('L1: Claude Code is started only with arguments from claudeArgs (or --version)', () => {
    const provider = source('src/core/cli/claude/provider.ts');
    const runs = [...provider.matchAll(/spawner\.run\(command, ([^,]+),/g)].map((m) => m[1]!.trim());
    expect(runs.sort()).toEqual(['["--version"]'.replace(/"/g, "'"), 'args', 'args'].sort());
    for (const f of files) if (f !== 'src/core/cli/claude/provider.ts' && f !== 'src/core/cli/spawn.ts') expect(source(f), f).not.toMatch(/spawner\.run\(|nodeSpawner\.run\(/);
  });
});
