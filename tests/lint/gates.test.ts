// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Worked examples of the gates; the exhaustive checks are in gates.property.test.ts. */

import { describe, expect, it } from 'vitest';
import { lintGates } from './harness';

async function blocked(code: string, path: string): Promise<boolean> {
  return (await lintGates(code, path)).errors.length > 0;
}

describe('lint gates: examples', () => {
  it('stops the core importing obsidian', async () => {
    expect(await blocked("import { Notice } from 'obsidian';", 'src/core/settings.ts')).toBe(true);
    expect(await blocked("import type { App } from 'obsidian';", 'src/core/chat/session.ts')).toBe(true);
    expect(await blocked("import { Notice } from 'obsidian';", 'src/obsidian/SettingsTab.ts')).toBe(false);
  });

  it('lets only ContextBroker read notes', async () => {
    const read = 'export async function f(file: unknown) { return this.app.vault.cachedRead(file); }';
    expect(await blocked(read, 'src/obsidian/ContextBroker.ts')).toBe(false);
    expect(await blocked(read, 'src/obsidian/ReviewController.ts')).toBe(true);
    expect(await blocked(read, 'src/obsidian/LektorView.tsx')).toBe(true);
    expect(await blocked(read, 'src/main.ts')).toBe(true);
    expect(await blocked(read, 'src/obsidian/ui/ContextBroker.ts')).toBe(true);
  });

  it('lets only ReviewController write notes', async () => {
    const write = "export async function f(file: unknown) { await this.app.vault.modify(file, 'x'); }";
    expect(await blocked(write, 'src/obsidian/ReviewController.ts')).toBe(false);
    expect(await blocked(write, 'src/obsidian/ContextBroker.ts')).toBe(true);
    expect(await blocked(write, 'src/obsidian/SettingsTab.ts')).toBe(true);

    const replace = "editor.replaceRange('x', { line: 0, ch: 0 });";
    expect(await blocked(replace, 'src/obsidian/ReviewController.ts')).toBe(false);
    expect(await blocked(replace, 'src/obsidian/ContextBroker.ts')).toBe(true);
  });

  it('keeps raw fs and child_process inside the CLI bridges', async () => {
    const spawn = "import { spawn } from 'node:child_process';";
    expect(await blocked(spawn, 'src/core/cli/claude.ts')).toBe(false);
    expect(await blocked(spawn, 'src/core/providers/ollama.ts')).toBe(true);
    expect(await blocked("import { readFile } from 'node:fs/promises';", 'src/obsidian/LektorView.tsx')).toBe(true);
  });

  it('allows ordinary code', async () => {
    expect(await blocked('const r = stream.getReader(); void r.read();', 'src/core/providers/ollama.ts')).toBe(false);
    expect(await blocked("import { z } from 'zod';", 'src/core/settings.ts')).toBe(false);
  });

  it('names the owning file in the message', async () => {
    const { errors } = await lintGates('void this.app.vault;', 'src/main.ts');
    expect(errors[0]?.message).toContain('src/obsidian/ContextBroker.ts');
  });
});
