// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The lint gates that make Lektor's two hard rules structural.
 *
 *   1. No write without approval: only ReviewController may change a note.
 *   2. Only what you give it: only ContextBroker may read vault content.
 *
 * See INVARIANTS.md (G1–G5). Never weaken or disable these; if a feature
 * seems to need it, stop and ask.
 *
 * ESLint flat config lets the *last* block that sets a rule win, so every
 * source file must match exactly one gate block below, and each block
 * composes the full rule set for its category. `gateBlocks` is applied last
 * in eslint.config.mjs; tests/lint/config.test.ts checks nothing overrides it.
 */

export const CONTEXT_BROKER = 'src/obsidian/ContextBroker.ts';
export const REVIEW_CONTROLLER = 'src/obsidian/ReviewController.ts';

const EXT = '{ts,tsx,mts,cts,js,mjs,cjs,jsx}';
const SRC = `src/**/*.${EXT}`;
const CORE = `src/core/**/*.${EXT}`;
const CLI = `src/core/cli/**/*.${EXT}`;

/** Rule names the gates own. No other config block may set these for src/. */
export const GATE_RULES = [
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-eval',
  'no-new-func',
  'no-implied-eval',
];

// ---------------------------------------------------------------------------
// Selector helpers

const alt = (names) => `/^(${names.join('|')})$/`;

/** Every ordinary way of reading property `names` off an object. */
function access(names, message) {
  const re = alt(names);
  return [
    { selector: `MemberExpression[computed=false][property.name=${re}]`, message },
    { selector: `MemberExpression[computed=true][property.value=${re}]`, message },
    {
      selector: `MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked=${re}]`,
      message,
    },
    { selector: `ObjectPattern > Property[computed=false][key.name=${re}]`, message },
    { selector: `ObjectPattern > Property[key.value=${re}]`, message },
  ];
}

/** `methods` called on something named `receivers` (`vault.x`, `this.app.vault.x`). */
function onReceiver(receivers, methods, message) {
  const r = alt(receivers);
  const m = alt(methods);
  return [
    { selector: `MemberExpression[property.name=${m}][object.name=${r}]`, message },
    { selector: `MemberExpression[property.name=${m}][object.property.name=${r}]`, message },
    { selector: `MemberExpression[computed=true][property.value=${m}][object.name=${r}]`, message },
    {
      selector: `MemberExpression[computed=true][property.value=${m}][object.property.name=${r}]`,
      message,
    },
  ];
}

// ---------------------------------------------------------------------------
// Messages

const M_READ = `Only ${CONTEXT_BROKER} may reach vault or note content (hard rule 2). Ask the ContextBroker instead.`;
const M_WRITE = `Only ${REVIEW_CONTROLLER} may change notes, and only from an accept click (hard rule 1).`;
const M_CORE = 'src/core must never import obsidian or the editor; define an interface in core and implement it in src/obsidian.';
const M_FS = 'Raw filesystem, process and Electron access is only allowed in src/core/cli/ (the CLI bridges); notes must be read through ContextBroker.';
const M_DYN = 'Dynamic module loading (require, import(), import = require) is not allowed in src/; use a static import so the gates can see it.';

// ---------------------------------------------------------------------------
// Syntax groups

/** Everywhere in src/. */
const S_MODULES = [
  { selector: "CallExpression[callee.type='Identifier'][callee.name='require']", message: M_DYN },
  { selector: "CallExpression[callee.property.name='require']", message: M_DYN },
  { selector: 'ImportExpression', message: M_DYN },
  { selector: 'TSImportEqualsDeclaration', message: M_DYN },
  { selector: 'TSImportType', message: M_DYN },
  {
    selector: "ImportDeclaration[source.value='obsidian'] > ImportDefaultSpecifier",
    message: 'Import named members from obsidian, not the default export, so the gates can check them.',
  },
  {
    selector: "ImportDeclaration[source.value='obsidian'] > ImportNamespaceSpecifier",
    message: 'Import named members from obsidian, not a namespace, so the gates can check them.',
  },
];

/** Editor mutators: banned everywhere except ReviewController. */
const S_EDITOR_WRITE_ANYWHERE = access(['replaceRange', 'replaceSelection'], M_WRITE);

/** Vault, note and editor content: banned everywhere except ContextBroker (and partly ReviewController). */
const S_CONTENT = [
  ...access(['vault', 'adapter', 'metadataCache', 'fileManager', 'editor', 'activeEditor', 'cm'], M_READ),
  ...access(['cachedRead', 'readBinary', 'getViewData', 'registerEditorExtension'], M_READ),
  { selector: `Property[key.name=${alt(['editorCallback', 'editorCheckCallback'])}]`, message: M_READ },
  { selector: "Literal[value=/^editor-/]", message: M_READ },
];

/** ContextBroker may read, but never write. */
const S_BROKER = [
  ...access(['fileManager', 'cm', 'registerEditorExtension'], M_WRITE),
  ...onReceiver(
    ['vault', 'adapter'],
    [
      'modify', 'modifyBinary', 'create', 'createBinary', 'createFolder', 'process',
      'append', 'appendBinary', 'delete', 'trash', 'rename', 'copy', 'write',
      'writeBinary', 'remove', 'rmdir', 'mkdir', 'trashLocal', 'trashSystem',
    ],
    M_WRITE,
  ),
  ...access(['setValue', 'setLine', 'transaction', 'undo', 'redo', 'processLines'], M_WRITE),
  ...onReceiver(['editor'], ['exec'], M_WRITE),
];

/** ReviewController may write, but reads only through vault.process / the editor it is applying to. */
const S_REVIEW = [
  ...access(['adapter', 'metadataCache', 'cachedRead', 'readBinary'], M_READ),
  ...onReceiver(['vault'], ['read'], M_READ),
];

// ---------------------------------------------------------------------------
// Import groups

const I_CONTENT_NAMES = [
  'Vault', 'DataAdapter', 'FileSystemAdapter', 'MetadataCache', 'FileManager',
  'MarkdownView', 'MarkdownEditView', 'TextFileView', 'Editor', 'MarkdownFileInfo',
];

const I_FS = [
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'original-fs',
  'child_process', 'node:child_process', 'electron',
].map((name) => ({ name, message: M_FS }));

const I_CORE = {
  paths: [{ name: 'obsidian', message: M_CORE }],
  patterns: [{ group: ['@codemirror/*'], message: M_CORE }],
};

function imports({ obsidianNames = [], codemirror = false, fs = true, core = false }) {
  const paths = [];
  const patterns = [];
  if (core) {
    paths.push(...I_CORE.paths);
    patterns.push(...I_CORE.patterns);
  } else {
    if (obsidianNames.length > 0) {
      paths.push({ name: 'obsidian', importNames: obsidianNames, message: M_READ });
    }
    if (codemirror) patterns.push({ group: ['@codemirror/*'], message: M_READ });
  }
  if (fs) paths.push(...I_FS);
  return ['error', { paths, patterns }];
}

const EVAL = {
  'no-eval': 'error',
  'no-new-func': 'error',
  'no-implied-eval': 'error',
};

// no-implied-eval only recognises setTimeout('…') & co. when they are known globals.
const EVAL_GLOBALS = {
  setTimeout: 'readonly',
  setInterval: 'readonly',
  execScript: 'readonly',
  window: 'readonly',
  globalThis: 'readonly',
  self: 'readonly',
};

function block(name, files, ignores, importRule, syntax) {
  return {
    name: `lektor/gates/${name}`,
    files,
    ...(ignores.length > 0 ? { ignores } : {}),
    languageOptions: { globals: EVAL_GLOBALS },
    rules: {
      'no-restricted-imports': importRule,
      'no-restricted-syntax': ['error', ...syntax],
      ...EVAL,
    },
  };
}

// ---------------------------------------------------------------------------
// Blocks: each src file matches exactly one.

export const gateBlocks = [
  block(
    'obsidian',
    [SRC],
    [CORE, CONTEXT_BROKER, REVIEW_CONTROLLER],
    imports({ obsidianNames: I_CONTENT_NAMES, codemirror: true }),
    [...S_MODULES, ...S_EDITOR_WRITE_ANYWHERE, ...S_CONTENT],
  ),
  block(
    'core',
    [CORE],
    [CLI],
    imports({ core: true }),
    [...S_MODULES, ...S_EDITOR_WRITE_ANYWHERE, ...S_CONTENT],
  ),
  block(
    'cli',
    [CLI],
    [],
    imports({ core: true, fs: false }),
    [...S_MODULES, ...S_EDITOR_WRITE_ANYWHERE, ...S_CONTENT],
  ),
  block(
    'context-broker',
    [CONTEXT_BROKER],
    [],
    imports({ obsidianNames: ['FileManager'], codemirror: true }),
    [...S_MODULES, ...S_EDITOR_WRITE_ANYWHERE, ...S_BROKER],
  ),
  block(
    'review-controller',
    [REVIEW_CONTROLLER],
    [],
    imports({ obsidianNames: ['DataAdapter', 'FileSystemAdapter', 'MetadataCache'] }),
    [...S_MODULES, ...S_REVIEW],
  ),
];

/** Which gate block applies to a repo-relative path (null: not gated). Mirrors the globs above. */
export function gateCategory(path) {
  if (!/^src\/.+\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(path)) return null;
  if (path === CONTEXT_BROKER) return 'context-broker';
  if (path === REVIEW_CONTROLLER) return 'review-controller';
  if (path.startsWith('src/core/cli/')) return 'cli';
  if (path.startsWith('src/core/')) return 'core';
  return 'obsidian';
}
