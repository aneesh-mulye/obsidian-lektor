// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * INVARIANTS.md G1–G4: the lint gates fire exactly where the reference model
 * says a file may not do something, for every ordinary syntactic form.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';
import { ALL, type Category, categoryOf, lintGates } from './harness';

// ---------------------------------------------------------------------------
// Reference model

interface Snippet {
  code: string;
  /** Categories where this construct is allowed (no gate error). */
  allowed: readonly Category[];
  /** Categories this snippet is meaningful in (default: all). */
  applicable?: readonly Category[];
}

const BROKER: Category = 'context-broker';
const REVIEW: Category = 'review-controller';
const NOWHERE: readonly Category[] = [];
const NOT_CORE: readonly Category[] = ['obsidian', BROKER, REVIEW];
const allBut = (...cs: Category[]) => ALL.filter((c) => !cs.includes(c));

// ---------------------------------------------------------------------------
// Paths

const seg = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,10}$/);
const ext = fc.constantFrom('ts', 'tsx');

function pathIn(category: Category): fc.Arbitrary<string> {
  const under = (dir: string) =>
    fc
      .tuple(fc.array(seg, { maxLength: 2 }), seg, ext)
      .map(([dirs, name, e]) => [dir, ...dirs, `${name}.${e}`].join('/'))
      .filter((p) => categoryOf(p) === category);
  switch (category) {
    case 'context-broker':
      return fc.constant('src/obsidian/ContextBroker.ts');
    case 'review-controller':
      return fc.constant('src/obsidian/ReviewController.ts');
    case 'cli':
      return under('src/core/cli');
    case 'core':
      return under('src/core');
    case 'obsidian':
      return fc.oneof(
        under('src/obsidian'),
        under('src'),
        // Near-misses of the allow-listed files must get the generic gate.
        fc.constantFrom(
          'src/obsidian/ContextBroker.tsx',
          'src/obsidian/ReviewController.tsx',
          'src/obsidian/ui/ContextBroker.ts',
          'src/obsidian/review/ReviewController.ts',
          'src/ContextBroker.ts',
          'src/obsidian/contextbroker.ts',
          'src/main.ts',
        ),
      );
  }
}

/** A snippet, plus a random path in one of the categories it applies to. */
const placed = (snippets: fc.Arbitrary<Snippet>) =>
  snippets.chain((s) =>
    fc
      .constantFrom(...(s.applicable ?? ALL))
      .chain(pathIn)
      .map((path) => ({ snippet: s, path })),
  );

// ---------------------------------------------------------------------------
// Snippet families

const receiver = fc.constantFrom('this.app', 'app', 'plugin.app', 'window.app', 'ctx.deps.app', 'this.plugin.app');

/** Every ordinary way of reading property `name` off `recv`. */
const accessForms = (recv: string, name: string) => [
  `void ${recv}.${name};`,
  `void ${recv}?.${name};`,
  `void ${recv}['${name}'];`,
  `void ${recv}["${name}"];`,
  `void ${recv}[\`${name}\`];`,
  `const { ${name} } = ${recv};`,
  `const { ${name}: alias } = ${recv};`,
  `const { '${name}': alias } = ${recv};`,
  `function f({ ${name} }: any) { return ${name}; }`,
];

const accessOf = (names: Record<string, readonly Category[]>, recv: fc.Arbitrary<string>) =>
  fc
    .tuple(fc.constantFrom(...Object.keys(names)), recv)
    .chain(([name, r]) =>
      fc.constantFrom(...accessForms(r, name)).map((code): Snippet => ({ code, allowed: names[name]! })),
    );

// G1: the core cannot import obsidian or the editor.
const g1: fc.Arbitrary<Snippet> = fc.oneof(
  fc.constantFrom<Snippet>(
    { code: "import { Notice } from 'obsidian';", allowed: NOT_CORE },
    { code: "import type { Notice } from 'obsidian';", allowed: NOT_CORE },
    { code: "import { Plugin, setIcon } from 'obsidian';", allowed: NOT_CORE },
    { code: "export { Notice } from 'obsidian';", allowed: NOT_CORE },
    { code: "export type { Notice } from 'obsidian';", allowed: NOT_CORE },
    // Re-exporting everything would re-export Vault & co., so it is banned wherever names are restricted.
    { code: "export * from 'obsidian';", allowed: NOWHERE },
    { code: "const o = require('obsidian');", allowed: NOWHERE },
    { code: "const o = window.require('obsidian');", allowed: NOWHERE },
    { code: "void import('obsidian');", allowed: NOWHERE },
    { code: "import o = require('obsidian');", allowed: NOWHERE },
    { code: "import * as o from 'obsidian';", allowed: NOWHERE },
    { code: "import o from 'obsidian';", allowed: NOWHERE },
    { code: "type T = import('obsidian').Notice;", allowed: NOWHERE },
    { code: "import { EditorView } from '@codemirror/view';", allowed: [REVIEW] },
    { code: "import type { EditorState } from '@codemirror/state';", allowed: [REVIEW] },
    { code: "export { EditorView } from '@codemirror/view';", allowed: [REVIEW] },
  ),
);

// G2: only ContextBroker reaches vault content.
const HANDLES: Record<string, readonly Category[]> = {
  vault: [BROKER, REVIEW],
  adapter: [BROKER],
  metadataCache: [BROKER],
  fileManager: [REVIEW],
  editor: [BROKER, REVIEW],
  activeEditor: [BROKER, REVIEW],
  cm: [REVIEW],
};
const CONTENT_METHODS: Record<string, readonly Category[]> = {
  cachedRead: [BROKER],
  readBinary: [BROKER],
  getViewData: [BROKER, REVIEW],
  registerEditorExtension: [REVIEW],
};
const CONTENT_IMPORTS: Record<string, readonly Category[]> = {
  Vault: [BROKER, REVIEW],
  DataAdapter: [BROKER],
  FileSystemAdapter: [BROKER],
  MetadataCache: [BROKER],
  FileManager: [REVIEW],
  MarkdownView: [BROKER, REVIEW],
  MarkdownEditView: [BROKER, REVIEW],
  TextFileView: [BROKER, REVIEW],
  Editor: [BROKER, REVIEW],
  MarkdownFileInfo: [BROKER, REVIEW],
};
const g2: fc.Arbitrary<Snippet> = fc.oneof(
  accessOf(HANDLES, receiver),
  accessOf(CONTENT_METHODS, fc.constantFrom('this', 'this.app.vault', 'file', 'view', 'x.y')),
  fc.constantFrom(...Object.keys(CONTENT_IMPORTS)).chain((name) =>
    fc.constantFrom<Snippet>(
      { code: `import { ${name} } from 'obsidian';`, allowed: CONTENT_IMPORTS[name]! },
      { code: `import type { ${name} } from 'obsidian';`, allowed: CONTENT_IMPORTS[name]! },
      { code: `import { Notice, ${name} as Alias } from 'obsidian';`, allowed: CONTENT_IMPORTS[name]! },
      { code: `export { ${name} } from 'obsidian';`, allowed: CONTENT_IMPORTS[name]! },
    ),
  ),
  fc.constantFrom('editorCallback', 'editorCheckCallback').map(
    (key): Snippet => ({
      code: `this.addCommand({ id: 'x', name: 'X', ${key}: () => {} });`,
      allowed: [BROKER, REVIEW],
    }),
  ),
  fc.constantFrom('editor-change', 'editor-paste', 'editor-drop', 'editor-menu').map(
    (event): Snippet => ({
      code: `this.registerEvent(this.app.workspace.on('${event}', () => {}));`,
      allowed: [BROKER, REVIEW],
    }),
  ),
  receiver.map((r): Snippet => ({ code: `void ${r}.vault.read(file);`, allowed: [BROKER] })),
);

// G3: only ReviewController writes.
const VAULT_WRITES = [
  'modify', 'modifyBinary', 'create', 'createBinary', 'createFolder', 'process',
  'append', 'appendBinary', 'delete', 'trash', 'rename', 'copy',
];
const ADAPTER_WRITES = ['write', 'writeBinary', 'append', 'remove', 'rmdir', 'mkdir', 'rename', 'copy', 'trashLocal', 'trashSystem', 'process'];
const EDITOR_MUTATORS = ['setValue', 'setLine', 'transaction', 'undo', 'redo', 'processLines'];
const g3: fc.Arbitrary<Snippet> = fc.oneof(
  // Editor writes: everywhere but ReviewController.
  fc
    .tuple(fc.constantFrom('replaceRange', 'replaceSelection'), fc.constantFrom('editor', 'ed', 'this.editor', 'view.editor'))
    .chain(([m, r]) =>
      fc.constantFrom<Snippet>(
        { code: `${r}.${m}('x', pos);`, allowed: [REVIEW] },
        { code: `${r}['${m}']('x', pos);`, allowed: [REVIEW] },
        { code: `const { ${m} } = ${r};`, allowed: [REVIEW] },
      ),
    ),
  // Vault writes through the app: everywhere but ReviewController.
  fc
    .tuple(fc.constantFrom(...VAULT_WRITES), receiver)
    .map(([m, r]): Snippet => ({ code: `void ${r}.vault.${m}(file, 'x');`, allowed: [REVIEW] })),
  // Vault writes on a held reference: ContextBroker holds .vault, so it must not write through it.
  fc
    .tuple(fc.constantFrom(...VAULT_WRITES), fc.constantFrom('vault', 'this.vault', 'this.deps.vault'))
    .chain(([m, r]) =>
      fc.constantFrom<Snippet>(
        { code: `void ${r}.${m}(file, 'x');`, allowed: [REVIEW], applicable: [BROKER, REVIEW] },
        { code: `void ${r}['${m}'](file, 'x');`, allowed: [REVIEW], applicable: [BROKER, REVIEW] },
      ),
    ),
  // Adapter writes: nobody. ContextBroker may hold the adapter (to read) but not write through it;
  // ReviewController writes through the vault, never the raw adapter.
  fc
    .tuple(fc.constantFrom(...ADAPTER_WRITES), fc.constantFrom('adapter', 'this.deps.adapter'))
    .map(([m, r]): Snippet => ({ code: `void ${r}.${m}('p', 'x');`, allowed: NOWHERE, applicable: [BROKER] })),
  fc
    .tuple(fc.constantFrom(...ADAPTER_WRITES), fc.constantFrom('this.adapter', 'vault.adapter'))
    .map(([m, r]): Snippet => ({ code: `void ${r}.${m}('p', 'x');`, allowed: NOWHERE })),
  fc
    .tuple(fc.constantFrom(...ADAPTER_WRITES), receiver)
    .map(([m, r]): Snippet => ({ code: `void ${r}.vault.adapter.${m}('p', 'x');`, allowed: NOWHERE })),
  // FileManager: ReviewController only.
  fc
    .tuple(fc.constantFrom('processFrontMatter', 'renameFile', 'trashFile'), receiver)
    .map(([m, r]): Snippet => ({ code: `void ${r}.fileManager.${m}(file, fn);`, allowed: [REVIEW] })),
  // Editor mutators in ContextBroker, which may hold an editor to read the selection.
  fc
    .tuple(fc.constantFrom(...EDITOR_MUTATORS), fc.constantFrom('ed', 'this.ed', 'view.ed'))
    .map(([m, r]): Snippet => ({ code: `${r}.${m}(arg);`, allowed: allBut(BROKER) })),
  fc.constant<Snippet>({ code: "editor.exec('swapLineUp');", allowed: allBut(BROKER) }),
);

// G4: raw fs, process and Electron only in the CLI bridges.
const FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'original-fs', 'child_process', 'node:child_process', 'electron'];
const g4: fc.Arbitrary<Snippet> = fc.constantFrom(...FS_MODULES).chain((mod) =>
  fc.constantFrom<Snippet>(
    { code: `import fs from '${mod}';`, allowed: ['cli'] },
    { code: `import * as fs from '${mod}';`, allowed: ['cli'] },
    { code: `import { readFileSync } from '${mod}';`, allowed: ['cli'] },
    { code: `import type { Stats } from '${mod}';`, allowed: ['cli'] },
    { code: `export * from '${mod}';`, allowed: ['cli'] },
    { code: `export { spawn } from '${mod}';`, allowed: ['cli'] },
    { code: `const fs = require('${mod}');`, allowed: NOWHERE },
    { code: `const fs = window.require('${mod}');`, allowed: NOWHERE },
    { code: `const fs = await import('${mod}');`, allowed: NOWHERE },
  ),
);

// Banned everywhere.
const evalForms: fc.Arbitrary<Snippet> = fc.constantFrom<Snippet>(
  { code: "eval('x');", allowed: NOWHERE },
  { code: "const f = new Function('return 1');", allowed: NOWHERE },
  { code: "setTimeout('alert(1)', 1);", allowed: NOWHERE },
  { code: "window.setInterval('alert(1)', 1);", allowed: NOWHERE },
);

// Precision controls: ordinary code that must never trip a gate.
const benign: fc.Arbitrary<Snippet> = fc.constantFrom<Snippet>(
  { code: 'const x = 1;', allowed: ALL },
  { code: 'const r = stream.getReader(); void r.read();', allowed: ALL },
  { code: 'const m = new Map<string, number>(); m.delete("k");', allowed: ALL },
  { code: 'const s = new Set<number>(); s.add(1); s.delete(1);', allowed: ALL },
  { code: 'void this.app.workspace.getActiveFile();', allowed: ALL },
  { code: "const editorial = 'editor';", allowed: ALL },
  { code: "const re = /a/; void re.exec('a');", allowed: ALL },
  { code: "text.setValue('x');", allowed: allBut(BROKER) },
  { code: "import { Notice } from 'obsidian';", allowed: NOT_CORE },
  { code: "import { z } from 'zod';", allowed: ALL },
  { code: "import { useState } from 'react';", allowed: ALL },
  { code: "import { readFileSync } from 'node:path';", allowed: ALL },
);

// ---------------------------------------------------------------------------
// Properties

async function holds({ snippet, path }: { snippet: Snippet; path: string }): Promise<boolean> {
  const { errors } = await lintGates(snippet.code, path);
  const forbidden = !snippet.allowed.includes(categoryOf(path));
  return forbidden === errors.length > 0;
}

describe('lint gates (INVARIANTS.md G1–G4)', () => {
  it('G1: the core cannot import obsidian or the editor', async () => {
    await fc.assert(fc.asyncProperty(placed(g1), holds));
  });

  it('G2: only ContextBroker reaches vault content', async () => {
    await fc.assert(fc.asyncProperty(placed(g2), holds));
  });

  it('G3: only ReviewController writes', async () => {
    await fc.assert(fc.asyncProperty(placed(g3), holds));
  });

  it('G4: raw fs, process and Electron only in src/core/cli', async () => {
    await fc.assert(fc.asyncProperty(placed(g4), holds));
  });

  it('eval and friends are banned everywhere', async () => {
    await fc.assert(fc.asyncProperty(placed(evalForms), holds));
  });

  it('ordinary code never trips a gate', async () => {
    await fc.assert(fc.asyncProperty(placed(benign), holds));
  });

  it('one forbidden line cannot be masked by others in the same file', async () => {
    const any = fc.oneof(g1, g2, g3, g4, evalForms, benign);
    const files = fc.array(any, { minLength: 1, maxLength: 5 }).chain((snippets) => {
      const applicable = ALL.filter((c) => snippets.every((s) => (s.applicable ?? ALL).includes(c)));
      if (applicable.length === 0) return fc.constant(null);
      return fc
        .constantFrom(...applicable)
        .chain(pathIn)
        .map((path) => ({ snippets, path }));
    });
    await fc.assert(
      fc.asyncProperty(files, async (file) => {
        if (file === null) return true;
        const category = categoryOf(file.path);
        // Each snippet on its own line, inside its own block so names don't clash.
        const code = file.snippets.map((s) => (s.code.startsWith('import') || s.code.startsWith('export') ? s.code : `{ ${s.code} }`)).join('\n');
        const { errors } = await lintGates(code, file.path);
        const forbidden = file.snippets.some((s) => !s.allowed.includes(category));
        return forbidden === errors.length > 0;
      }),
    );
  });
});
