// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md U1–U4: easy to find your way around, and ready for the community directory's review. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../lint/harness';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const sources = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ path: `src/${f}`, code: read(`src/${f}`) }));

/** Each `addCommand({...})` call's argument text (braces balanced, strings skipped). */
function calls(code: string, head: string): string[] {
  const out: string[] = [];
  for (let at = code.indexOf(head); at !== -1; at = code.indexOf(head, at + 1)) {
    let depth = 0;
    let quote: string | null = null;
    for (let i = at + head.length - 1; i < code.length; i++) {
      const ch = code[i]!;
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(' || ch === '{') depth++;
      else if (ch === ')' || ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(code.slice(at, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

/** A JSX element's opening tag, from `<` to its closing `>` (arrows and braces skipped). */
function openingTag(code: string, from: number): string {
  const start = code.lastIndexOf('<', from);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0 && code[i - 1] !== '=') return code.slice(start, i + 1);
  }
  return code.slice(start);
}

const commands = sources.flatMap((s) => calls(s.code, 'this.addCommand('));

describe('Finding your way around (INVARIANTS.md U1–U3)', () => {
  it('U1: no command has a default hotkey', () => {
    expect(commands.length).toBeGreaterThanOrEqual(10);
    for (const c of commands) expect(c, c.slice(0, 80)).not.toMatch(/\bhotkeys\s*:/);
  });

  it('U2: every header action, and every older one, is in the command palette', () => {
    const ids = commands.map((c) => /id:\s*['`]([^'`]+)['`]/.exec(c)?.[1]);
    for (const id of [
      'open-sidebar',
      'new-chat',
      'choose-model',
      'change-display-mode',
      'toggle-web-tools',
      'show-chat-history',
      'stop-reply',
      'clear-all-chats',
      'add-selection',
      'add-current-note',
      'add-note',
      'add-folder',
      'add-attachment',
      'show-ai-history',
    ])
      expect(ids, id).toContain(id);
    // One command per preset: its id is built from the preset's.
    expect(read('src/main.ts')).toMatch(/const id = `preset-\$\{p\.id\}`;\s+presetCommands\.push\(id\);\s+this\.addCommand\(\{\s+id,/);
  });

  it('U3: every icon button has a tooltip', () => {
    let seen = 0;
    for (const s of sources) {
      for (let at = s.code.indexOf('<IconButton'); at !== -1; at = s.code.indexOf('<IconButton', at + 1)) {
        const tag = openingTag(s.code, at + 1);
        seen++;
        expect(tag, `${s.path}: ${tag.slice(0, 80)}`).toMatch(/\blabel=(\{[^}]|"[^"]+")/);
      }
      for (let at = s.code.indexOf('clickable-icon'); at !== -1; at = s.code.indexOf('clickable-icon', at + 1)) {
        seen++;
        if (s.path.endsWith('.tsx')) {
          if (s.path.endsWith('ui/Icon.tsx')) continue; // IconButton itself: it sets aria-label from `label`
          const tag = openingTag(s.code, at);
          expect(tag, `${s.path}: ${tag.slice(0, 80)}`).toMatch(/aria-label=/);
        } else {
          const call = s.code.slice(s.code.lastIndexOf('createEl(', at), at + 300);
          expect(call, s.path).toMatch(/'aria-label':/);
        }
      }
      for (const r of calls(s.code, 'this.addRibbonIcon(')) expect(r).toMatch(/addRibbonIcon\('[^']+', '[^']+'/);
    }
    expect(seen).toBeGreaterThan(10);
    expect(read('src/obsidian/ui/Icon.tsx')).toMatch(/aria-label=\{props\.label\}/);
  });
});

describe('The directory’s review rules (INVARIANTS.md U4)', () => {
  it('U4: none of the patterns reviewers reject', () => {
    for (const s of sources) {
      expect(s.code, s.path).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\(/);
      expect(s.code, s.path).not.toMatch(/workspace\.activeLeaf\b/);
      expect(s.code, s.path).not.toMatch(/detachLeavesOfType/);
      expect(s.code, s.path).not.toMatch(/console\.(log|info|debug)\(/);
      // Comments may name the folder; code must use vault.configDir.
      const code = s.code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code, s.path).not.toMatch(/['"`/]\.obsidian\b/);
    }
  });

  it('U4: the manifest and versions.json are as the directory expects', () => {
    const m = JSON.parse(read('manifest.json')) as Record<string, unknown>;
    expect(m['id']).toBe('lektor');
    expect(String(m['id'])).not.toMatch(/obsidian/i);
    expect(m['isDesktopOnly']).toBe(true);
    const d = String(m['description']);
    expect(d.length).toBeLessThanOrEqual(250);
    expect(d).toMatch(/\.$/);
    expect(d).not.toMatch(/obsidian|\bplugin\b/i);
    const versions = JSON.parse(read('versions.json')) as Record<string, string>;
    expect(versions[String(m['version'])]).toBe(m['minAppVersion']);
  });

  it('U4: no command or settings heading starts with the plugin’s name or says “settings”', () => {
    for (const c of commands) {
      const name = /name:\s*['`]([^'`]+)['`]/.exec(c)?.[1] ?? '';
      expect(name, c.slice(0, 60)).not.toMatch(/^lektor\b/i);
    }
    for (const s of sources) {
      for (const h of s.code.matchAll(/setName\('([^']+)'\)\s*\.setHeading\(\)/g)) expect(h[1], s.path).not.toMatch(/^lektor\b|settings|options/i);
    }
  });

  it('U4: the README discloses network use, accounts and the absence of telemetry', () => {
    expect(existsSync(join(ROOT, 'README.md'))).toBe(true);
    const readme = read('README.md');
    for (const heading of ['## Network use', '## Accounts', '## Privacy']) expect(readme).toContain(heading);
    expect(readme).toMatch(/no telemetry/i);
    for (const img of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) expect(existsSync(join(ROOT, img[1]!)), img[1]).toBe(true);
  });
});
