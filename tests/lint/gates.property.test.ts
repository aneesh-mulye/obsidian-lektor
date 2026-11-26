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
  /** JSX: only parses in .tsx files. */
  jsx?: boolean;
  /** Categories where this construct is allowed (no gate error). */
  allowed: readonly Category[];
  /** Categories this snippet is meaningful in (default: all). */
  applicable?: readonly Category[];
}

const BROKER: Category = 'context-broker';
const REVIEW: Category = 'review-controller';
const STORAGE: Category = 'plugin-storage';
const HTTP: Category = 'http';
const SAFE_MD: Category = 'safe-markdown';
const NOWHERE: readonly Category[] = [];
const NOT_CORE: readonly Category[] = ['obsidian', BROKER, REVIEW, STORAGE, HTTP, SAFE_MD];
/** Categories with a .tsx path, where JSX snippets can be placed. */
const JSX_CATEGORIES: readonly Category[] = ['obsidian', 'core', 'cli', SAFE_MD];
const allBut = (...cs: Category[]) => ALL.filter((c) => !cs.includes(c));

// ---------------------------------------------------------------------------
// Paths

const seg = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,10}$/);
const ext = fc.constantFrom('ts', 'tsx');

const NEAR_MISSES = [
  'src/obsidian/ContextBroker.tsx',
  'src/obsidian/ReviewController.tsx',
  'src/obsidian/ui/ContextBroker.ts',
  'src/obsidian/review/ReviewController.ts',
  'src/obsidian/PluginStorage.tsx',
  'src/obsidian/storage/PluginStorage.ts',
  'src/obsidian/http.ts',
  'src/obsidian/ui/Http.ts',
  'src/obsidian/Http.tsx',
  'src/obsidian/ui/SafeMarkdown.ts',
  'src/obsidian/SafeMarkdown.tsx',
  'src/obsidian/ui/SafeMarkdown2.tsx',
  'src/obsidian/ui/x/SafeMarkdown.tsx',
  'src/ContextBroker.ts',
  'src/obsidian/contextbroker.ts',
  'src/main.ts',
];

function pathIn(category: Category, tsx = false): fc.Arbitrary<string> {
  const under = (dir: string) =>
    fc
      .tuple(fc.array(seg, { maxLength: 2 }), seg, tsx ? fc.constant('tsx') : ext)
      .map(([dirs, name, e]) => [dir, ...dirs, `${name}.${e}`].join('/'))
      .filter((p) => categoryOf(p) === category);
  switch (category) {
    case 'context-broker':
      return fc.constant('src/obsidian/ContextBroker.ts');
    case 'review-controller':
      return fc.constant('src/obsidian/ReviewController.ts');
    case 'plugin-storage':
      return fc.constant('src/obsidian/PluginStorage.ts');
    case 'http':
      return fc.constant('src/obsidian/Http.ts');
    case 'safe-markdown':
      return fc.constant('src/obsidian/ui/SafeMarkdown.tsx');
    case 'cli':
      return under('src/core/cli');
    case 'core':
      return under('src/core');
    case 'obsidian':
      return fc.oneof(
        under('src/obsidian'),
        under('src'),
        // Near-misses of the allow-listed files must get the generic gate.
        fc.constantFrom(...NEAR_MISSES.filter((p) => !tsx || p.endsWith('.tsx'))),
      );
  }
}

/** A snippet, plus a random path in one of the categories it applies to. */
const placed = (snippets: fc.Arbitrary<Snippet>) =>
  snippets.chain((s) =>
    fc
      .constantFrom(...(s.applicable ?? ALL).filter((c) => !s.jsx || JSX_CATEGORIES.includes(c)))
      .chain((c) => pathIn(c, s.jsx === true))
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

// G6: PluginStorage reaches only resolved paths in its own folder.
const g6: fc.Arbitrary<Snippet> = fc
  .tuple(
    fc.constantFrom('this.app', 'app', 'this.deps.app'),
    fc.constantFrom("resolveStoragePath(this.root, 'chats', key)", "resolveStoragePath(root, ns, k)"),
    fc.constantFrom("resolveStorageDir(this.root, 'history')", 'resolveStorageDir(root, ns)'),
  )
  .chain(([app, file, dir]) =>
    fc.constantFrom<Snippet>(
      // The allowed shape.
      { code: `void ${app}.vault.adapter.read(${file});`, allowed: [BROKER, STORAGE] },
      { code: `void ${app}.vault.adapter.exists(${file});`, allowed: [BROKER, STORAGE] },
      { code: `void ${app}.vault.adapter.list(${dir});`, allowed: [BROKER, STORAGE] },
      { code: `void ${app}.vault.adapter.write(${file}, data);`, allowed: [STORAGE] },
      { code: `void ${app}.vault.adapter.append(${file}, data);`, allowed: [STORAGE] },
      { code: `void ${app}.vault.adapter.remove(${file});`, allowed: [STORAGE] },
      { code: `void ${app}.vault.adapter.mkdir(${dir});`, allowed: [STORAGE] },
      { code: `void ${app}.vault?.adapter.read(${file});`, allowed: [BROKER, STORAGE] },
      // Unresolved paths.
      { code: `void ${app}.vault.adapter.read(path);`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.read('.obsidian/plugins/lektor/chats/a.json');`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.read(\`\${root}/chats/\${k}.json\`);`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.read(join(${dir}, k));`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.read(this.resolveStoragePath(root, ns, k));`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.write(path, data);`, allowed: NOWHERE },
      { code: `void ${app}.vault.adapter.read();`, allowed: [BROKER] },
      // Methods that are not allow-listed.
      { code: `void ${app}.vault.adapter.getFullPath(${file});`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.readBinary(${file});`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.stat(${file});`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.rename(${file}, ${file});`, allowed: NOWHERE },
      { code: `void ${app}.vault.adapter.rmdir(${dir}, true);`, allowed: NOWHERE },
      { code: `void ${app}.vault.adapter.process(${file}, (s: string) => s);`, allowed: NOWHERE },
      // Computed access and aliasing.
      { code: `void ${app}.vault['adapter'].read(${file});`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter['read'](${file});`, allowed: [BROKER] },
      { code: `const a = ${app}.vault.adapter; void a.read(${file});`, allowed: [BROKER] },
      { code: `const { adapter } = ${app}.vault; void adapter.read(${file});`, allowed: [BROKER] },
      { code: `const read = ${app}.vault.adapter.read; void read(${file});`, allowed: [BROKER] },
      { code: `void ${app}.vault.adapter.read.call(null, ${file});`, allowed: [BROKER] },
      // Other vault members.
      { code: `void ${app}.vault.getMarkdownFiles();`, allowed: [BROKER, REVIEW] },
      { code: `void ${app}.vault.configDir;`, allowed: [BROKER, REVIEW] },
      { code: `const v = ${app}.vault;`, allowed: [BROKER, REVIEW] },
    ),
  );

// G6: the resolver cannot be faked inside PluginStorage.
const g6Resolver: fc.Arbitrary<Snippet> = fc.constantFrom('resolveStoragePath', 'resolveStorageDir').chain((name) =>
  fc.constantFrom<Snippet>(
    { code: `import { ${name} } from '../core/storage';`, allowed: ALL },
    { code: `import { type StorageNamespace, ${name} } from '../core/storage';`, allowed: ALL },
    { code: `import { ${name} } from './fake';`, allowed: allBut(STORAGE) },
    { code: `import { ${name} } from '../core/storage-but-not';`, allowed: allBut(STORAGE) },
    { code: `import { identity as ${name} } from '../core/storage';`, allowed: allBut(STORAGE) },
    { code: `function ${name}(p: string) { return p; }`, allowed: allBut(STORAGE) },
    { code: `const ${name} = (p: string) => p;`, allowed: allBut(STORAGE) },
    { code: `class ${name} {}`, allowed: allBut(STORAGE) },
  ),
);

// G7: network only in Http.ts; no remote-loading elements; raw HTML only in SafeMarkdown.tsx.
const NET_NAMES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'Worker', 'SharedWorker', 'Image', 'Audio'];
const g7Network: fc.Arbitrary<Snippet> = fc.oneof(
  fc.constantFrom(...NET_NAMES).chain((g) =>
    fc.constantFrom<Snippet>(
      { code: `void ${g};`, allowed: [HTTP] },
      { code: `void window.${g};`, allowed: [HTTP] },
      { code: `void globalThis.${g};`, allowed: [HTTP] },
      { code: `void self['${g}'];`, allowed: [HTTP] },
      { code: `void window?.${g};`, allowed: [HTTP] },
      { code: `const { ${g}: x } = globalThis;`, allowed: [HTTP] },
    ),
  ),
  fc.constantFrom<Snippet>(
    { code: "void fetch('http://127.0.0.1:11434/api/tags');", allowed: [HTTP] },
    { code: 'const x = new XMLHttpRequest();', allowed: [HTTP] },
    { code: 'const w = new WebSocket(u);', allowed: [HTTP] },
    { code: 'navigator.sendBeacon(u, d);', allowed: [HTTP] },
    { code: 'void navigator["sendBeacon"](u, d);', allowed: [HTTP] },
    { code: 'window.open(u);', allowed: [HTTP] },
    { code: 'open(u);', allowed: [HTTP] },
    { code: 'const { open } = window;', allowed: [HTTP] },
    { code: "importScripts('x.js');", allowed: [HTTP] },
    { code: "import { requestUrl } from 'obsidian';", allowed: [HTTP] },
    { code: "import { request as r } from 'obsidian';", allowed: [HTTP] },
    // .src is banned even in Http.ts: nothing should load a resource by URL attribute.
    { code: 'new Image().src = u;', allowed: NOWHERE },
  ),
  fc.constantFrom('http', 'node:http', 'net', 'node:net').chain((mod) =>
    fc.constantFrom<Snippet>(
      { code: `import http from '${mod}';`, allowed: ['cli'] },
      { code: `import { createServer } from '${mod}';`, allowed: ['cli'] },
      { code: `export * from '${mod}';`, allowed: ['cli'] },
    ),
  ),
  fc.constantFrom('https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', 'http2', 'node:http2', 'dns', 'node:dns', 'undici').chain((mod) =>
    fc.constantFrom<Snippet>(
      { code: `import m from '${mod}';`, allowed: NOWHERE },
      { code: `import { request } from '${mod}';`, allowed: NOWHERE },
    ),
  ),
);

const LOADING_TAGS = ['img', 'iframe', 'frame', 'video', 'audio', 'source', 'track', 'picture', 'script', 'link', 'style', 'object', 'embed', 'image', 'use', 'base', 'meta', 'form', 'portal'];
const g7Loading: fc.Arbitrary<Snippet> = fc.oneof(
  fc.constantFrom(...LOADING_TAGS).chain((tag) =>
    fc.constantFrom<Snippet>(
      { code: `void document.createElement('${tag}');`, allowed: NOWHERE },
      { code: `void el.createEl('${tag}', { cls: 'x' });`, allowed: NOWHERE },
      { code: `void createEl('${tag.toUpperCase()}');`, allowed: NOWHERE },
      { code: `void document.createElementNS('http://www.w3.org/2000/svg', '${tag}');`, allowed: NOWHERE },
      { code: `void React.createElement('${tag}', {});`, allowed: NOWHERE },
      { code: `const e = <${tag} />;`, allowed: NOWHERE, jsx: true },
      { code: `const e = <${tag} className="x"></${tag}>;`, allowed: NOWHERE, jsx: true },
    ),
  ),
  fc.constantFrom<Snippet>(
    { code: 'el.src = u;', allowed: NOWHERE },
    { code: 'img.srcset = u;', allowed: NOWHERE },
    { code: "frame['srcdoc'] = h;", allowed: NOWHERE },
    { code: 'el.style.backgroundImage = u;', allowed: NOWHERE },
    { code: "el.setAttribute('src', u);", allowed: NOWHERE },
    { code: "el.setAttribute('SRCSET', u);", allowed: NOWHERE },
    { code: "el.setAttr('src', u);", allowed: NOWHERE },
    { code: "el.setAttribute('style', 'background:url(x)');", allowed: NOWHERE },
    { code: "void el.createEl('div', { attr: { src: u } });", allowed: NOWHERE },
    { code: 'const e = <div srcSet={u} />;', allowed: NOWHERE, jsx: true },
    { code: 'const e = <div style={{ backgroundImage: u }} />;', allowed: NOWHERE, jsx: true },
  ),
);

const g7Html: fc.Arbitrary<Snippet> = fc.constantFrom<Snippet>(
  { code: 'const e = <div dangerouslySetInnerHTML={{ __html: h }} />;', allowed: [SAFE_MD], jsx: true },
  { code: "void React.createElement('div', { dangerouslySetInnerHTML: { __html: h } });", allowed: [SAFE_MD] },
  { code: 'el.innerHTML = h;', allowed: NOWHERE },
  { code: "el['innerHTML'] = h;", allowed: NOWHERE },
  { code: 'el.outerHTML = h;', allowed: NOWHERE },
  { code: "el.insertAdjacentHTML('beforeend', h);", allowed: NOWHERE },
  { code: 'el.setHTMLUnsafe(h);', allowed: NOWHERE },
  { code: 'document.write(h);', allowed: NOWHERE },
  { code: 'document.writeln(h);', allowed: NOWHERE },
  { code: 'void range.createContextualFragment(h);', allowed: NOWHERE },
  { code: "import { MarkdownRenderer } from 'obsidian';", allowed: NOWHERE },
  { code: "import { sanitizeHTMLToDom } from 'obsidian';", allowed: NOWHERE },
);

const g7Benign: fc.Arbitrary<Snippet> = fc.constantFrom<Snippet>(
  { code: 'modal.open();', allowed: ALL },
  { code: 'const fetched = 1;', allowed: ALL },
  { code: 'const u = new URL(s);', allowed: ALL },
  { code: "void el.createEl('div', { text: 'x', cls: 'y' });", allowed: ALL },
  { code: "void el.createEl('a', { href: u, text: 'Terms' });", allowed: ALL },
  { code: "el.setAttribute('aria-label', 'Send');", allowed: ALL },
  { code: 'void item.source;', allowed: ALL },
  { code: 'const e = <a href={u}>x</a>;', allowed: ALL, jsx: true },
  { code: 'const e = <div className="x" style={{ color: "red" }} />;', allowed: ALL, jsx: true },
  { code: 'const e = <textarea value={v} />;', allowed: ALL, jsx: true },
  { code: 'void http.request(req);', allowed: ALL },
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

  it('G6: PluginStorage reaches only resolved paths in its own folder', async () => {
    await fc.assert(fc.asyncProperty(placed(fc.oneof(g6, g6Resolver)), holds));
  });

  it('G7: network only in Http.ts', async () => {
    await fc.assert(fc.asyncProperty(placed(g7Network), holds));
  });

  it('G7: nothing creates remote-loading elements or src-style attributes', async () => {
    await fc.assert(fc.asyncProperty(placed(g7Loading), holds));
  });

  it('G7: raw HTML only in SafeMarkdown.tsx, MarkdownRenderer nowhere', async () => {
    await fc.assert(fc.asyncProperty(placed(g7Html), holds));
  });

  it('G7: ordinary UI code is not caught', async () => {
    await fc.assert(fc.asyncProperty(placed(g7Benign), holds));
  });

  it('eval and friends are banned everywhere', async () => {
    await fc.assert(fc.asyncProperty(placed(evalForms), holds));
  });

  it('ordinary code never trips a gate', async () => {
    await fc.assert(fc.asyncProperty(placed(benign), holds));
  });

  it('one forbidden line cannot be masked by others in the same file', async () => {
    const any = fc.oneof(g1, g2, g3, g4, g6, g6Resolver, g7Network, g7Loading, g7Html, g7Benign, evalForms, benign);
    const files = fc.array(any, { minLength: 1, maxLength: 5 }).chain((snippets) => {
      const jsx = snippets.some((s) => s.jsx === true);
      const applicable = ALL.filter(
        (c) => snippets.every((s) => (s.applicable ?? ALL).includes(c)) && (!jsx || JSX_CATEGORIES.includes(c)),
      );
      if (applicable.length === 0) return fc.constant(null);
      return fc
        .constantFrom(...applicable)
        .chain((c) => pathIn(c, jsx))
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
