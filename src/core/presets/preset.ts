// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Preset files (DESIGN.md § Presets; INVARIANTS.md PR1): Markdown whose
 * frontmatter holds the settings and whose body is the prompt.
 *
 * The frontmatter reader takes a small, strict part of YAML: one `key: value`
 * per line, values plain or quoted, lists as `[a, b]` or as `- item` lines,
 * and comments. Anything else is an error for that file alone, with its line
 * number. Parsing is total: any text gives a preset or an error, never an
 * exception. What Lektor writes is plain YAML that reads back exactly.
 */

import type { ModelRef } from '../providers/types';
import { DISPLAY_MODES, type DisplayMode } from '../settings';
import { isStorageKey } from '../storage';

export const PRESET_OUTPUTS = ['findings', 'edits', 'chat'] as const;
export type PresetOutput = (typeof PRESET_OUTPUTS)[number];
/** The web tools a preset can ask for; review tools follow from its output. */
export const PRESET_TOOLS = ['web_search', 'fetch_page'] as const;
export type PresetTool = (typeof PRESET_TOOLS)[number];

export const PRESET_NAME_MAX = 60;
export const PRESET_PROMPT_MAX = 50_000;
export const PRESET_CAP_MAX = 50;
export const DEFAULT_ICON = 'sparkles';

export interface Preset {
  /** The file's key (and the slash command): lowercase letters, digits, `-` and `_`. */
  readonly id: string;
  readonly name: string;
  /** A Lucide icon name. */
  readonly icon: string;
  /** A model for this preset's replies; otherwise the chat's. */
  readonly model?: ModelRef;
  /** Web tools it uses (if they are available). */
  readonly tools: readonly PresetTool[];
  /** The display mode the chat switches to when it runs. */
  readonly display?: DisplayMode;
  readonly output: PresetOutput;
  /** Caps for its replies, instead of the global ones. */
  readonly searches?: number;
  readonly fetches?: number;
  readonly prompt: string;
}

export type ParseResult = { readonly ok: true; readonly preset: Preset } | { readonly ok: false; readonly error: string };

const FIELDS = ['name', 'icon', 'model', 'tools', 'display', 'output', 'searches', 'fetches'] as const;
type Raw = string | readonly string[];

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ICON = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROVIDER = /^[a-z][a-z0-9-]*$/;
/** Control characters and every character some YAML version treats as a line break. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const BAD_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** A preset's id is its file's storage key, at most 64 characters. */
/** No lone surrogates (what String.prototype.isWellFormed checks). */
const wellFormed = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

export const isPresetId = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && isStorageKey(id);

class FrontmatterError extends Error {}

const fail = (line: number, message: string): never => {
  throw new FrontmatterError(`Line ${line}: ${message}`);
};

// ---------------------------------------------------------------------------
// Reading

/** A value after `key:` (or a list item): returns the scalar and whatever follows it on the line. */
function readScalar(src: string, line: number): { value: string; rest: string } {
  const s = src.trimStart();
  if (s.startsWith('"')) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i]!;
      if (c === '"') return { value: out, rest: s.slice(i + 1) };
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = s[++i];
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '0': '\0' };
      if (e !== undefined && Object.hasOwn(simple, e)) out += simple[e];
      else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
        i += 4;
      } else fail(line, `"\\${e ?? ''}" is not an escape Lektor reads.`);
    }
    return fail(line, 'a quoted value is not closed on its line.');
  }
  if (s.startsWith("'")) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i]!;
      if (c !== "'") out += c;
      else if (s[i + 1] === "'") {
        out += "'";
        i++;
      } else return { value: out, rest: s.slice(i + 1) };
    }
    return fail(line, 'a quoted value is not closed on its line.');
  }
  return { value: s, rest: '' };
}

/** What may follow a quoted value or a list on its line: nothing, or a comment after a space (YAML's rule). */
const AFTER = /^([ \t]+#.*|[ \t]*)$/;

/** Plain text up to a comment, trimmed. */
function plain(s: string, line: number): string {
  const hash = s.search(/(^|[ \t])#/);
  const v = (hash === -1 ? s : s.slice(0, hash)).trim();
  // What YAML reads as something other than text at the start of a value.
  if (/^[[\]{}&*!|>%@`,]/.test(v) || /^[-?:]([ \t]|$)/.test(v)) fail(line, `"${v.slice(0, 20)}" needs quotes.`);
  if (/:([ \t]|$)/.test(v)) fail(line, `"${v.slice(0, 20)}" needs quotes (it contains ": ").`);
  return v;
}

/** One value: quoted (then nothing but a comment after it) or plain. */
function value(src: string, line: number): string {
  const t = src.trimStart();
  if (t.startsWith('"') || t.startsWith("'")) {
    const { value: v, rest } = readScalar(t, line);
    if (!AFTER.test(rest)) fail(line, 'unexpected text after a quoted value.');
    return v;
  }
  return plain(t, line);
}

function flowList(src: string, line: number): string[] {
  let s = src.trim();
  const items: string[] = [];
  if (!s.startsWith('[')) return fail(line, 'expected a list.');
  s = s.slice(1).trimStart();
  if (s.startsWith(']')) {
    if (!AFTER.test(s.slice(1))) fail(line, 'unexpected text after a list.');
    return items;
  }
  for (;;) {
    let item: string;
    if (s.startsWith('"') || s.startsWith("'")) {
      const r = readScalar(s, line);
      item = r.value;
      s = r.rest.trimStart();
    } else {
      const end = s.search(/[,\]]/);
      if (end === -1) fail(line, 'a list is not closed on its line.');
      item = plain(s.slice(0, end), line);
      s = s.slice(end);
    }
    items.push(item);
    if (s.startsWith(',')) {
      s = s.slice(1).trimStart();
      continue;
    }
    if (s.startsWith(']')) {
      if (!AFTER.test(s.slice(1))) fail(line, 'unexpected text after a list.');
      return items;
    }
    return fail(line, 'expected "," or "]" in a list.');
  }
}

/** The frontmatter's fields, raw. Throws FrontmatterError. */
function readFields(lines: readonly string[], first: number): Map<string, Raw> {
  const out = new Map<string, Raw>();
  for (let i = 0; i < lines.length; i++) {
    const n = first + i;
    const l = lines[i]!;
    if (/^[ \t]*(#.*)?$/.test(l)) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*)|)$/.exec(l);
    if (!m) fail(n, /^[ \t]/.test(l) ? 'indented lines are only for "- item" list entries.' : 'expected "field: value".');
    const key = m![1]!;
    if (!(FIELDS as readonly string[]).includes(key)) fail(n, `"${key}" is not a preset field (${FIELDS.join(', ')}).`);
    if (out.has(key)) fail(n, `"${key}" appears twice.`);
    const rest = (m![2] ?? '').trim();
    if (rest.startsWith('[')) {
      out.set(key, flowList(rest, n));
      continue;
    }
    if (rest !== '' && !rest.startsWith('#')) {
      out.set(key, value(rest, n));
      continue;
    }
    // Nothing after the colon: a block list may follow ("- item" lines), or the value is empty.
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      const item = /^[ \t]*-(?:[ \t]+(.*)|)$/.exec(next);
      if (item) {
        items.push(value(item[1] ?? '', first + i + 1));
        i++;
      } else if (/^[ \t]+(#.*)?$/.test(next) || next === '') {
        i++;
      } else break;
    }
    out.set(key, items.length > 0 ? items : '');
  }
  return out;
}

/** Split a file into its frontmatter lines and body. Throws FrontmatterError. */
function split(text: string): { lines: string[]; body: string } {
  const t = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const open = /^---[ \t]*\r?\n/.exec(t);
  if (!open) fail(1, 'a preset starts with a "---" line, then its settings, then another "---" line.');
  const lines: string[] = [];
  let pos = open![0].length;
  for (;;) {
    const nl = t.indexOf('\n', pos);
    let l = t.slice(pos, nl === -1 ? t.length : nl);
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (/^---[ \t]*$/.test(l)) return { lines, body: nl === -1 ? '' : t.slice(nl + 1) };
    if (nl === -1) fail(lines.length + 2, 'the settings are never closed with a "---" line.');
    lines.push(l);
    pos = nl + 1;
  }
}

const one = (raw: Raw | undefined, field: string): string | undefined => {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') throw new FrontmatterError(`"${field}" takes one value, not a list.`);
  return raw;
};

/** Parse a preset file. Never throws (INVARIANTS.md PR1). */
export function parsePreset(id: string, text: string): ParseResult {
  try {
    if (!isPresetId(id)) return { ok: false, error: `"${String(id)}" is not a usable file name for a preset.` };
    if (typeof text !== 'string') return { ok: false, error: 'The file is not text.' };
    const { lines, body } = split(text);
    const raw = readFields(lines, 2);
    const p = checkPreset({
      id,
      name: one(raw.get('name'), 'name'),
      icon: one(raw.get('icon'), 'icon'),
      model: one(raw.get('model'), 'model'),
      tools: raw.get('tools'),
      display: one(raw.get('display'), 'display'),
      output: one(raw.get('output'), 'output'),
      searches: one(raw.get('searches'), 'searches'),
      fetches: one(raw.get('fetches'), 'fetches'),
      prompt: body,
    });
    return p;
  } catch (err) {
    if (err instanceof FrontmatterError) return { ok: false, error: err.message };
    return { ok: false, error: 'The file could not be read as a preset.' };
  }
}

interface Unchecked {
  id: string;
  name?: string | undefined;
  icon?: string | undefined;
  model?: string | undefined;
  tools?: Raw | undefined;
  display?: string | undefined;
  output?: string | undefined;
  searches?: string | undefined;
  fetches?: string | undefined;
  prompt: string;
}

const cap = (v: string | undefined, field: string): number | undefined => {
  if (v === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,2})$/.test(v) || Number(v) > PRESET_CAP_MAX) throw new FrontmatterError(`"${field}" must be a whole number from 0 to ${PRESET_CAP_MAX}.`);
  return Number(v);
};

/** Problems with a name, or null. */
export function presetNameProblem(name: string): string | null {
  if (name.trim() === '') return 'A preset needs a name.';
  if (name !== name.trim()) return 'The name has spaces at its start or end.';
  if (name.length > PRESET_NAME_MAX) return `The name is longer than ${PRESET_NAME_MAX} characters.`;
  if (BAD_CHARS.test(name) || !wellFormed(name)) return 'The name must be one line of ordinary text.';
  return null;
}

function checkPreset(u: Unchecked): ParseResult {
  if (u.name === undefined) return { ok: false, error: 'A preset needs a "name".' };
  const nameProblem = presetNameProblem(u.name);
  if (nameProblem) return { ok: false, error: nameProblem };
  const icon = u.icon ?? DEFAULT_ICON;
  if (!ICON.test(icon) || icon.length > 40) return { ok: false, error: `"${icon.slice(0, 40)}" is not an icon name (lowercase words joined by "-", as in "spell-check").` };
  let model: ModelRef | undefined;
  if (u.model !== undefined) {
    const colon = u.model.indexOf(':');
    const provider = colon === -1 ? '' : u.model.slice(0, colon);
    const id = colon === -1 ? '' : u.model.slice(colon + 1);
    if (!PROVIDER.test(provider) || provider.length > 64 || id === '' || id.length > 256 || BAD_CHARS.test(id) || !wellFormed(id)) {
      return { ok: false, error: '"model" must be written as provider:model, as in "ollama:qwen3.8:27b".' };
    }
    model = { provider, model: id };
  }
  const toolList = u.tools === undefined || u.tools === '' ? [] : typeof u.tools === 'string' ? [u.tools] : u.tools;
  const tools: PresetTool[] = [];
  for (const t of toolList) {
    if (!(PRESET_TOOLS as readonly string[]).includes(t)) return { ok: false, error: `"${t.slice(0, 40)}" is not a tool presets can use (${PRESET_TOOLS.join(', ')}).` };
    if (tools.includes(t as PresetTool)) return { ok: false, error: `"${t}" is listed twice in "tools".` };
    tools.push(t as PresetTool);
  }
  if (u.display !== undefined && !(DISPLAY_MODES as readonly string[]).includes(u.display)) return { ok: false, error: `"display" must be one of ${DISPLAY_MODES.join(', ')}.` };
  const output = u.output ?? 'chat';
  if (!(PRESET_OUTPUTS as readonly string[]).includes(output)) return { ok: false, error: `"output" must be one of ${PRESET_OUTPUTS.join(', ')}.` };
  const searches = cap(u.searches, 'searches');
  const fetches = cap(u.fetches, 'fetches');
  if (u.prompt.trim() === '') return { ok: false, error: 'The prompt (the text after the settings) is empty.' };
  if (u.prompt.length > PRESET_PROMPT_MAX) return { ok: false, error: `The prompt is longer than ${PRESET_PROMPT_MAX} characters.` };
  if (!wellFormed(u.prompt)) return { ok: false, error: 'The prompt contains text that is not valid Unicode.' };
  return {
    ok: true,
    preset: {
      id: u.id,
      name: u.name,
      icon,
      ...(model ? { model } : {}),
      tools,
      ...(u.display !== undefined ? { display: u.display as DisplayMode } : {}),
      output: output as PresetOutput,
      ...(searches !== undefined ? { searches } : {}),
      ...(fetches !== undefined ? { fetches } : {}),
      prompt: u.prompt,
    },
  };
}

/** Problems with a preset Lektor is about to save, or null (the settings form checks with this). */
export function presetProblem(p: Preset): string | null {
  const r = checkPreset({
    id: p.id,
    name: p.name,
    icon: p.icon,
    model: p.model ? `${p.model.provider}:${p.model.model}` : undefined,
    tools: [...p.tools],
    display: p.display,
    output: p.output,
    searches: p.searches?.toString(),
    fetches: p.fetches?.toString(),
    prompt: p.prompt,
  });
  return r.ok ? null : r.error;
}

// ---------------------------------------------------------------------------
// Writing

const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

/** A value as YAML: plain when that is unambiguous, otherwise double-quoted (JSON's escapes are YAML's). */
function scalar(s: string): string {
  const plainOk = /^[A-Za-z][A-Za-z0-9 _./:-]*$/.test(s) && !/[ ]$/.test(s) && !/:([ ]|$)/.test(s) && !RESERVED.test(s);
  return plainOk ? s : JSON.stringify(s);
}

/** A preset file. Parsing it gives the same preset back (INVARIANTS.md PR1). */
export function serializePreset(p: Preset): string {
  const lines = [`name: ${scalar(p.name)}`, `icon: ${scalar(p.icon)}`];
  if (p.model) lines.push(`model: ${scalar(`${p.model.provider}:${p.model.model}`)}`);
  lines.push(`tools: [${p.tools.join(', ')}]`);
  if (p.display) lines.push(`display: ${p.display}`);
  lines.push(`output: ${p.output}`);
  if (p.searches !== undefined) lines.push(`searches: ${p.searches}`);
  if (p.fetches !== undefined) lines.push(`fetches: ${p.fetches}`);
  return `---\n${lines.join('\n')}\n---\n${p.prompt}`;
}

/** A new preset's id from its name: lowercase words joined by "-", made unique against `taken`. */
export function presetIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'preset';
  const safe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(base) ? `${base}-preset` : base;
  if (!taken.has(safe)) return safe;
  for (let i = 2; ; i++) if (!taken.has(`${safe}-${i}`)) return `${safe}-${i}`;
}
