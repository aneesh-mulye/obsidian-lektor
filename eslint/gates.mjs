// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The lint gates that make Lektor's two hard rules structural.
 *
 *   1. No write without approval: only ReviewController may change a note.
 *   2. Only what you give it: only ContextBroker may read vault content.
 *
 * One narrow exception: PluginStorage may read and write Lektor's own data
 * (chats, edit history) under the plugin folder, and only through paths built
 * by resolveStoragePath / resolveStorageDir in src/core/storage.ts.
 *
 * They also keep Lektor's privacy promise structural: only Http.ts may open a
 * network connection, nothing may create an element that loads a URL, and raw
 * HTML is confined to SafeMarkdown.tsx (which renders model output with images
 * and HTML switched off).
 *
 * See INVARIANTS.md (G1–G7). Never weaken or disable these; if a feature
 * seems to need it, stop and ask.
 *
 * ESLint flat config lets the *last* block that sets a rule win, so every
 * source file must match exactly one gate block below, and each block
 * composes the full rule set for its category. `gateBlocks` is applied last
 * in eslint.config.mjs; tests/lint/config.test.ts checks nothing overrides it.
 */

export const CONTEXT_BROKER = 'src/obsidian/ContextBroker.ts';
export const REVIEW_CONTROLLER = 'src/obsidian/ReviewController.ts';
export const PLUGIN_STORAGE = 'src/obsidian/PluginStorage.ts';
export const HTTP = 'src/obsidian/Http.ts';
export const SAFE_MARKDOWN = 'src/obsidian/ui/SafeMarkdown.tsx';

const EXT = '{ts,tsx,mts,cts,js,mjs,cjs,jsx}';
const SRC = `src/**/*.${EXT}`;
const CORE = `src/core/**/*.${EXT}`;
const CLI = `src/core/cli/**/*.${EXT}`;

/** Rule names the gates own. No other config block may set these for src/. */
export const GATE_RULES = [
  'no-restricted-imports',
  'no-restricted-globals',
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
const M_NET = `Only ${HTTP} may make network requests (DESIGN.md § Privacy guarantees); take an HttpClient instead.`;
const M_LOAD = 'Nothing in Lektor may create an element or attribute that loads a URL (img, iframe, src, …), so displayed model output can never contact anyone.';
const M_HTML = `Raw HTML is only allowed in ${SAFE_MARKDOWN}, which renders through the locked-down Markdown renderer.`;
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

/**
 * PluginStorage: the adapter only as `<x>.vault.adapter.<allowed>(resolver(…), …)`.
 * No aliasing, no computed access, no other vault members, and the resolver
 * must be the real one from core/storage.
 */
const M_STORAGE = `${PLUGIN_STORAGE} may only call <app>.vault.adapter.<read|write|append|remove|exists|list|mkdir>(resolveStoragePath(…) or resolveStorageDir(…), …), with the resolver imported from core/storage, so every path it touches is confined to Lektor's data folder.`;
const STORAGE_METHODS = ['read', 'write', 'append', 'remove', 'exists', 'list', 'mkdir'];
const RESOLVERS = ['resolveStoragePath', 'resolveStorageDir'];

const S_STORAGE = [
  // .vault only when immediately followed by .adapter
  {
    selector: "MemberExpression[computed=false][property.name='vault']:not(MemberExpression[computed=false][property.name='adapter'] > MemberExpression.object)",
    message: M_STORAGE,
  },
  // .adapter only as the receiver of a direct call to an allow-listed method
  {
    selector: `MemberExpression[computed=false][property.name='adapter']:not(CallExpression > MemberExpression.callee[computed=false][property.name=${alt(STORAGE_METHODS)}] > MemberExpression.object)`,
    message: M_STORAGE,
  },
  // ...whose first argument is a direct call to a resolver
  {
    selector: `CallExpression[callee.object.property.name='adapter']:not([arguments.0.type='CallExpression'][arguments.0.callee.type='Identifier'][arguments.0.callee.name=${alt(RESOLVERS)}])`,
    message: M_STORAGE,
  },
  // Computed, template and destructuring access to either handle.
  ...access(['vault', 'adapter'], M_STORAGE).slice(1),
  // The resolvers are the real ones: imported under their own name from core/storage, never redefined.
  {
    selector: `ImportDeclaration:not([source.value=/core.storage$/]) > ImportSpecifier[local.name=${alt(RESOLVERS)}]`,
    message: M_STORAGE,
  },
  ...RESOLVERS.map((name) => ({
    selector: `ImportSpecifier[local.name='${name}']:not([imported.name='${name}'])`,
    message: M_STORAGE,
  })),
  {
    selector: `:matches(FunctionDeclaration, ClassDeclaration, VariableDeclarator)[id.name=${alt(RESOLVERS)}]`,
    message: M_STORAGE,
  },
  // Everything else that reaches note content stays banned.
  ...access(['metadataCache', 'fileManager', 'editor', 'activeEditor', 'cm'], M_READ),
  ...access(['cachedRead', 'readBinary', 'getViewData', 'registerEditorExtension'], M_READ),
  { selector: `Property[key.name=${alt(['editorCallback', 'editorCheckCallback'])}]`, message: M_READ },
  { selector: "Literal[value=/^editor-/]", message: M_READ },
];

/** Network APIs: banned everywhere except Http.ts. */
const NET_NAMES = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
  'RTCPeerConnection', 'Worker', 'SharedWorker', 'Image', 'Audio',
];
const S_NETWORK = [
  ...access([...NET_NAMES, 'sendBeacon'], M_NET),
  ...onReceiver(['window', 'globalThis', 'self'], ['open'], M_NET),
  { selector: 'VariableDeclarator[init.name=/^(window|globalThis|self)$/] > ObjectPattern', message: M_NET },
];
const G_NETWORK = [...NET_NAMES, 'open', 'importScripts'].map((name) => ({ name, message: M_NET }));

/** Anything that loads a resource by URL: banned everywhere. */
const LOADING_TAGS = [
  'img', 'iframe', 'frame', 'video', 'audio', 'source', 'track', 'picture', 'script',
  'link', 'style', 'object', 'embed', 'image', 'use', 'base', 'meta', 'form', 'portal',
];
const TAG = `/^(${LOADING_TAGS.join('|')})$/i`;
const S_LOADING = [
  { selector: `CallExpression[callee.property.name=/^(createEl|createElement)$/][arguments.0.value=${TAG}]`, message: M_LOAD },
  { selector: `CallExpression[callee.name=/^(createEl|createElement)$/][arguments.0.value=${TAG}]`, message: M_LOAD },
  { selector: `CallExpression[callee.property.name='createElementNS'][arguments.1.value=${TAG}]`, message: M_LOAD },
  { selector: `JSXOpeningElement[name.name=${TAG}]`, message: M_LOAD },
  ...access(['src', 'srcset', 'srcdoc', 'backgroundImage'], M_LOAD),
  { selector: 'Property[key.name=/^(src|srcset|srcdoc|backgroundImage)$/i]', message: M_LOAD },
  { selector: 'JSXAttribute[name.name=/^(src|srcset|srcdoc|poster)$/i]', message: M_LOAD },
  {
    selector: 'CallExpression[callee.property.name=/^(setAttribute|setAttr)$/][arguments.0.value=/^(src|srcset|srcdoc|style|background|poster)$/i]',
    message: M_LOAD,
  },
];

/** Raw HTML: banned everywhere; dangerouslySetInnerHTML only in SafeMarkdown.tsx. */
const S_RAW_HTML = [
  ...access(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'setHTMLUnsafe', 'createContextualFragment'], M_HTML),
  ...onReceiver(['document'], ['write', 'writeln'], M_HTML),
];
const S_DANGEROUS_HTML = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: M_HTML },
  { selector: "Property[key.name='dangerouslySetInnerHTML']", message: M_HTML },
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

/** Loopback server modules: only the CLI bridges (their local MCP server). */
const I_NET_LOOPBACK = ['http', 'node:http', 'net', 'node:net'].map((name) => ({ name, message: M_NET }));
/** Outbound network modules: nowhere; Http.ts uses fetch. */
const I_NET_OTHER = [
  'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram',
  'http2', 'node:http2', 'dns', 'node:dns', 'undici',
].map((name) => ({ name, message: M_NET }));

// ---------------------------------------------------------------------------
// Composition

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

/**
 * One gate block. `content` is the category's vault-access syntax group; the
 * flags name what this category is additionally *allowed*.
 */
function gate(name, files, ignores, { content, obsidianNames, core = false, codemirror = false, fs = false, loopback = false, network = false, html = false, editorWrite = false }) {
  const paths = [];
  const patterns = [];
  if (core) {
    paths.push({ name: 'obsidian', message: M_CORE });
    patterns.push({ group: ['@codemirror/*'], message: M_CORE });
  } else {
    paths.push({ name: 'obsidian', importNames: ['MarkdownRenderer', 'sanitizeHTMLToDom'], message: M_HTML });
    if (!network) paths.push({ name: 'obsidian', importNames: ['requestUrl', 'request'], message: M_NET });
    if (obsidianNames.length > 0) paths.push({ name: 'obsidian', importNames: obsidianNames, message: M_READ });
    if (!codemirror) patterns.push({ group: ['@codemirror/*'], message: M_READ });
  }
  if (!fs) paths.push(...I_FS);
  if (!loopback) paths.push(...I_NET_LOOPBACK);
  paths.push(...I_NET_OTHER);

  const syntax = [
    ...S_MODULES,
    ...S_LOADING,
    ...S_RAW_HTML,
    ...(html ? [] : S_DANGEROUS_HTML),
    ...(network ? [] : S_NETWORK),
    ...(editorWrite ? [] : S_EDITOR_WRITE_ANYWHERE),
    ...content,
  ];

  return {
    name: `lektor/gates/${name}`,
    files,
    ...(ignores.length > 0 ? { ignores } : {}),
    languageOptions: { globals: EVAL_GLOBALS },
    rules: {
      'no-restricted-imports': ['error', { paths, patterns }],
      'no-restricted-globals': network ? 'off' : ['error', ...G_NETWORK],
      'no-restricted-syntax': ['error', ...syntax],
      ...EVAL,
    },
  };
}

// ---------------------------------------------------------------------------
// Blocks: each src file matches exactly one.

const OWNED = [CONTEXT_BROKER, REVIEW_CONTROLLER, PLUGIN_STORAGE, HTTP, SAFE_MARKDOWN];

export const gateBlocks = [
  gate('obsidian', [SRC], [CORE, ...OWNED], { content: S_CONTENT, obsidianNames: I_CONTENT_NAMES }),
  gate('core', [CORE], [CLI], { content: S_CONTENT, core: true }),
  gate('cli', [CLI], [], { content: S_CONTENT, core: true, fs: true, loopback: true }),
  gate('context-broker', [CONTEXT_BROKER], [], { content: S_BROKER, obsidianNames: ['FileManager'] }),
  gate('review-controller', [REVIEW_CONTROLLER], [], {
    content: S_REVIEW,
    obsidianNames: ['DataAdapter', 'FileSystemAdapter', 'MetadataCache'],
    codemirror: true,
    editorWrite: true,
  }),
  gate('plugin-storage', [PLUGIN_STORAGE], [], { content: S_STORAGE, obsidianNames: I_CONTENT_NAMES }),
  gate('http', [HTTP], [], { content: S_CONTENT, obsidianNames: I_CONTENT_NAMES, network: true }),
  gate('safe-markdown', [SAFE_MARKDOWN], [], { content: S_CONTENT, obsidianNames: I_CONTENT_NAMES, html: true }),
];

/** Which gate block applies to a repo-relative path (null: not gated). Mirrors the globs above. */
export function gateCategory(path) {
  if (!/^src\/.+\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(path)) return null;
  if (path === CONTEXT_BROKER) return 'context-broker';
  if (path === REVIEW_CONTROLLER) return 'review-controller';
  if (path === PLUGIN_STORAGE) return 'plugin-storage';
  if (path === HTTP) return 'http';
  if (path === SAFE_MARKDOWN) return 'safe-markdown';
  if (path.startsWith('src/core/cli/')) return 'cli';
  if (path.startsWith('src/core/')) return 'core';
  return 'obsidian';
}
