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
      // From the 0.1.0 review: no globalThis, even as a type (use window or activeWindow).
      expect(code, s.path).not.toMatch(/\bglobalThis\b/);
      // From the 0.1.1-0.1.3 reviews: nothing split or joined on dots (read as runtime domain assembly).
      expect(code, s.path).not.toMatch(/\.(split|join)\(\s*(['"`])\.\2\s*\)/);
    }
    // From the 0.1.0 review's CSS lint: only a plain line in text-decoration, and none of its extras.
    const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/text-decoration\s*:\s*([^;]+);/g)) expect(m[1]!.trim(), m[0]).toMatch(/^(none|underline|line-through|overline)$/);
    expect(css).not.toMatch(/text-decoration-(thickness|style|color)|text-underline-offset/);
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

  it('U4: the README discloses network use, accounts, files outside the vault and the absence of telemetry, and credits', () => {
    expect(existsSync(join(ROOT, 'README.md'))).toBe(true);
    const readme = read('README.md');
    const at = readme.indexOf('## Privacy and network use');
    expect(at).toBeGreaterThan(-1);
    // Near the top: the first section after the introduction.
    expect(readme.slice(0, at).match(/^## /gm)).toBeNull();
    for (const heading of ['### What the model sees and changes', '### Network use', '### Accounts', '### Files outside the vault']) expect(readme.slice(at)).toContain(heading);
    expect(readme).toMatch(/no telemetry/i);
    for (const credit of ['LLM Hub', 'Smart Composer', 'AGPL-3.0-or-later']) expect(readme).toContain(credit);
    for (const img of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) expect(existsSync(join(ROOT, img[1]!)), img[1]).toBe(true);
  });

  it('U4: a pushed tag builds a release only if it equals the manifest version, with the three plugin files', () => {
    const wf = read('.github/workflows/release.yml');
    expect(wf).toMatch(/on:\s+push:\s+tags:/);
    expect(wf).toContain("require('./manifest.json').version");
    expect(wf).toMatch(/\[ "\$tag" != "\$version" \]/);
    expect(wf).toMatch(/gh release create "\$GITHUB_REF_NAME" main\.js manifest\.json styles\.css/);
    expect(wf).toContain('npm run lint');
    expect(wf).toContain('npm test');
    // A proper title and notes: "Lektor x.y.z", and the version's CHANGELOG.md section.
    expect(wf).toContain('--title "Lektor $GITHUB_REF_NAME"');
    expect(wf).toContain('--notes-file "$RUNNER_TEMP/notes.md"');
    // Signed provenance for the files (0.1.1 review): attested after the build, before the release.
    expect(wf).toMatch(/id-token: write\s+attestations: write/);
    const attest = wf.indexOf('actions/attest-build-provenance@');
    expect(attest).toBeGreaterThan(wf.indexOf('npm run build'));
    expect(attest).toBeLessThan(wf.indexOf('gh release create'));
    for (const f of ['main.js', 'manifest.json', 'styles.css']) expect(wf.slice(attest, wf.indexOf('gh release create'))).toContain(f);
  });

  it('U4: CHANGELOG.md has notes for the manifest’s version (the release workflow needs them)', () => {
    const version = (JSON.parse(read('manifest.json')) as { version: string }).version;
    const log = read('CHANGELOG.md');
    const at = log.indexOf(`\n## ${version}\n`);
    expect(at, `CHANGELOG.md has no "## ${version}" section`).toBeGreaterThan(-1);
    const rest = log.slice(at + version.length + 5);
    const section = rest.slice(0, rest.search(/\n## |$/));
    expect(section.trim().length).toBeGreaterThan(40);
  });

  it('U4: markdown-it’s punycode.js is swapped for the URL-based stand-in in the build and the tests (0.1.1 review)', () => {
    expect(read('esbuild.config.mjs')).toContain("alias: { 'punycode.js': './src/obsidian/ui/punycode.ts' }");
    expect(read('vitest.config.mts')).toContain("'punycode.js': new URL('./src/obsidian/ui/punycode.ts'");
    expect(read('THIRD_PARTY.md')).not.toMatch(/^\| punycode\.js /m);
  });

  it('U4: markdown-it’s import of mdurl gets Lektor’s parse, which assembles no domains (0.1.2 review), and it is credited', () => {
    expect(read('esbuild.config.mjs')).toContain('plugins: [markdownItMdurl]');
    expect(read('vitest.config.mts')).toContain("name: 'lektor-markdown-it-mdurl'");
    const copy = read('src/obsidian/ui/mdurl-parse.ts');
    expect(copy).toContain('SPDX-License-Identifier: MIT');
    expect(copy).toContain('Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin.');
    expect(copy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/\.split\(|\.join\(/);
    expect(read('THIRD_PARTY.md')).toContain('`src/obsidian/ui/mdurl-parse.ts`');
  });

  it('U4: the review’s own ESLint rules are part of npm run lint', () => {
    expect(read('eslint.config.mjs')).toContain('...obsidianmd.configs.recommended');
    expect((JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }).devDependencies['eslint-plugin-obsidianmd']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
