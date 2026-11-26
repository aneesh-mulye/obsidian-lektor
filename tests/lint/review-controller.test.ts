// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md G8: only ReviewController writes, only these ways, only from the user's clicks. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './harness';

const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const files = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => `src/${f}`);

/** The body of each class method, by name (good enough for this file's simple layout). */
function methods(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^ {2}(?:private |async |override )*(\w+)\(/gm;
  const starts = [...code.matchAll(re)].map((m) => ({ name: m[1]!, at: m.index }));
  starts.forEach((s, i) => out.set(s.name, code.slice(s.at, starts[i + 1]?.at ?? code.length)));
  return out;
}

describe('ReviewController (INVARIANTS.md G8)', () => {
  const rc = source('src/obsidian/ReviewController.ts');

  it('writes only through vault.process, vault.create(Folder), fileManager.trashFile and editor.replaceRange, inside apply/create/trash', () => {
    const writes = [...rc.matchAll(/\.(process|create|createFolder|trashFile|replaceRange|modify|append|delete|trash|rename|copy|write|setValue|replaceSelection|processFrontMatter|renameFile)\(/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(['process', 'replaceRange', 'create', 'createFolder', 'trashFile']));
    const byMethod = methods(rc);
    for (const [name, body] of byMethod) {
      const has = /\.(process|create|createFolder|trashFile|replaceRange)\(/.test(body);
      if (has) expect(['apply', 'create', 'trash']).toContain(name);
    }
  });

  it('dispatches editor transactions with effects only, never changes (inline marks are decorations)', () => {
    const dispatches = [...rc.matchAll(/\.dispatch\(/g)].length;
    expect(dispatches).toBeGreaterThan(0);
    expect([...rc.matchAll(/\.dispatch\(\{ effects: \[[^\]]*\] \}\)/g)].length).toBe(dispatches);
    expect(rc).not.toMatch(/\bchanges\s*:|\binsert\s*:|ChangeSet|\.update\(\[|annotations\s*:|selection\s*:/);
  });

  it('is used only through the core review manager, whose write paths are called only from UI click handlers', () => {
    // Only main.ts constructs it, and hands it to the ReviewManager; otherwise it only reads the
    // open editor's text and registers inline review.
    for (const f of files) {
      if (f === 'src/obsidian/ReviewController.ts') continue;
      if (source(f).includes('new ReviewController(')) expect(f).toBe('src/main.ts');
    }
    const main = source('src/main.ts');
    expect([...main.matchAll(/new ReviewController\(/g)]).toHaveLength(1);
    expect(main).toMatch(/const controller = new ReviewController\(this\.app\);\s*const review = new ReviewManager\(\{\s*applier: controller,/);
    const uses = [...main.matchAll(/\bcontroller\b(\.\w+)?/g)].map((m) => m[1] ?? '');
    expect(new Set(uses)).toEqual(new Set(['', '.editorText', '.registerInline']));
    expect([...main.matchAll(/applier: controller/g)]).toHaveLength(1);
    // Only the review manager calls the applier.
    for (const f of files) {
      if (/applier\.(apply|create|trash)\(/.test(source(f))) expect(f).toBe('src/core/review/manager.ts');
    }
    // Accept, create and revert are called only from click handlers in the UI.
    const inline = source('src/obsidian/InlineReview.ts');
    const clicksStart = inline.indexOf('const clicks: InlineClicks = {');
    const clicksEnd = inline.indexOf('\n  };\n', clicksStart);
    expect(clicksStart).toBeGreaterThan(-1);
    for (const f of files) {
      const code = source(f);
      for (const m of code.matchAll(/\.(acceptHunk|acceptAll|createNote|revert)\(/g)) {
        if (f === 'src/core/review/manager.ts') continue; // acceptAll → acceptHunk, inside the manager
        if (f === 'src/obsidian/ReviewController.ts' && code.slice(m.index - 6, m.index) === 'clicks') continue; // checked below
        // Inline review: only inside the `clicks` handlers, which only the editor's buttons call (below).
        if (f === 'src/obsidian/InlineReview.ts') {
          expect(m.index > clicksStart && m.index < clicksEnd, `${f} calls ${m[1]} outside its clicks`).toBe(true);
          continue;
        }
        expect(['src/obsidian/ui/Review.tsx', 'src/obsidian/EditHistoryModal.ts'], `${f} calls ${m[1]}`).toContain(f);
        const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index));
        const before = code.slice(Math.max(0, m.index - 200), m.index);
        expect(/onClick|\.onClick\(|onclick/.test(line + before), `${f}: ${line.trim()}`).toBe(true);
      }
    }
  });

  it('calls the inline clicks only from button click handlers in the editor', () => {
    const lines = rc.split('\n');
    const calls = lines.filter((l) => /clicks\.\w+\(/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const l of calls) expect(/\.onclick = |^\s*button\(/.test(l), l.trim()).toBe(true);
    // `button(…, onClick)` attaches onClick to the button's click and nothing else.
    const start = rc.indexOf('const button = (');
    const helper = rc.slice(start, rc.indexOf('\n    };', start));
    expect(helper).toMatch(/b\.onclick = \(ev\) => \{\s*ev\.preventDefault\(\);\s*onClick\(\);\s*\}/);
    expect([...helper.matchAll(/onClick\(\)/g)]).toHaveLength(1);
    // The clicks object is built in one place and handed only to registerInline.
    for (const f of files) if (/inlineSource\(/.test(source(f)) && f !== 'src/obsidian/InlineReview.ts') expect(f).toBe('src/main.ts');
    expect(source('src/main.ts')).toMatch(/controller\.registerInline\(this, inlineSource\(inlineDeps\)\)/);
  });
});
