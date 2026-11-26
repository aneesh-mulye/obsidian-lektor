// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** INVARIANTS.md PR1: preset parsing is total, and what Lektor writes reads back exactly. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { BUILTIN_PRESETS } from '../../src/core/presets/builtins';
import { PresetLibrary, buildLibrary } from '../../src/core/presets/library';
import { isPresetId, parsePreset, presetIdFor, serializePreset } from '../../src/core/presets/preset';
import { id, preset } from './presets.fixtures';
import { MemStorage } from './review.fixtures';

// ---------------------------------------------------------------------------
// The preset world (valid presets are in presets.fixtures.ts)

/** Small changes to a valid file: the near-misses a hand edit produces. */
const nearMiss = fc.tuple(preset, fc.nat(), fc.nat(), fc.constantFrom('delete', 'insert', 'dupline', 'swap', 'tab', 'crlf', 'bom', 'unquote', 'blockList', 'comment', 'indent')).map(([p, a, b, kind]) => {
  const t = serializePreset(p);
  const lines = t.split('\n');
  const i = a % lines.length;
  const j = b % lines.length;
  switch (kind) {
    case 'delete':
      return t.slice(0, a % t.length) + t.slice((a % t.length) + 1);
    case 'insert':
      return t.slice(0, a % (t.length + 1)) + ':#"\'[- \t'[b % 8] + t.slice(a % (t.length + 1));
    case 'dupline':
      return [...lines.slice(0, i + 1), lines[i], ...lines.slice(i + 1)].join('\n');
    case 'swap': {
      const l = [...lines];
      [l[i], l[j]] = [l[j]!, l[i]!];
      return l.join('\n');
    }
    case 'tab':
      return t.replace(': ', ':\t');
    case 'crlf':
      return t.replace(/\n/g, '\r\n');
    case 'bom':
      return `\uFEFF${t}`;
    case 'unquote':
      return t.replace(/"/g, '');
    case 'blockList':
      return t.replace(/tools: \[(.*)\]/, (_m, items: string) => `tools:${items.split(', ').filter(Boolean).map((x) => `\n  - ${x}`).join('')}`);
    case 'comment':
      return t.replace(/\n/, '\n# a comment\n').replace(/^(output: \w+)$/m, '$1  # trailing');
    case 'indent':
      return t.replace(/\nicon:/, '\n  icon:');
  }
});

/** Frontmatter built from YAML's awkward tokens, under the real field names. */
const token = fc.constantFrom(
  '"a\\"b"', "'x''y'", 'a # c', '#c', '[a, b]', '[ "a" , b ]', '[]', '- x', '? x', ': x', 'a: b', 'x:y', '"\\u00e9"', '"\\x41"', '|', '>', '&a', '*a', '!t x',
  '%x', '@x', '`x', ',x', 'a,b', '"unterminated', "'u", 'a\tb', 'a  ', '"a" b', '[a', 'a]', '{a: b}', '"\\/"', '"\\0"', 'web_search', 'fetch_page', 'findings', 'edits',
  'inline', '5', '05', '-1', 'ollama:qwen3.8:27b', 'Proofread', 'spell-check', '-', 'a-b', 'no', '~', 'null', '"#"', "'#'", 'x#y', '[web_search,fetch_page]', '["web_search"]',
);
const fieldName = fc.constantFrom('name', 'icon', 'model', 'tools', 'display', 'output', 'searches', 'fetches');
const fmLine = fc.oneof(
  { weight: 5, arbitrary: fc.tuple(fieldName, token).map(([k, v]) => `${k}: ${v}`) },
  { weight: 1, arbitrary: fc.tuple(fieldName, fc.array(token, { minLength: 1, maxLength: 3 }), fc.constantFrom('  ', '', '\t')).map(([k, vs, ind]) => `${k}:${vs.map((v) => `\n${ind}- ${v}`).join('')}`) },
  { weight: 1, arbitrary: fc.constantFrom('', '# comment', '  # indented comment', 'name:', 'name:x') },
);
const tokenFile = fc.tuple(fc.array(fmLine, { maxLength: 8 }), fc.constantFrom('name: Fine', 'name: "Fine"', '')).map(([ls, n]) => `---\n${[n, ...ls].join('\n')}\n---\nThe prompt.`);

const anyText = fc.oneof(tokenFile, fc.string(), fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }).map((s) => `---\n${s}\n---\nbody`), nearMiss);

/** The frontmatter block of a file, for a real YAML parser. */
function frontmatter(text: string): string {
  const t = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n([\s\S]*?)(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(t);
  return m ? m[1]! : '';
}

describe('preset parsing (INVARIANTS.md PR1, design invariant 11)', () => {
  it('PR1: parsing any text gives a preset or an error, never an exception', () => {
    fc.assert(
      fc.property(id, anyText, (i, t) => {
        const r = parsePreset(i, t);
        expect(typeof r.ok).toBe('boolean');
        if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
        else expect(r.preset.id).toBe(i);
      }),
    );
  });

  it('PR1: parse(serialise(p)) is p, and serialising again gives the same text', () => {
    fc.assert(
      fc.property(preset, (p) => {
        const text = serializePreset(p);
        const r = parsePreset(p.id, text);
        expect(r).toEqual({ ok: true, preset: p });
        if (r.ok) expect(serializePreset(r.preset)).toBe(text);
      }),
    );
  });

  it('PR1: what Lektor writes is YAML whose fields read back with the same values', () => {
    fc.assert(
      fc.property(preset, (p) => {
        const text = serializePreset(p);
        const doc = YAML.parse(frontmatter(text)) as Record<string, unknown>;
        expect(doc['name']).toBe(p.name);
        expect(doc['icon']).toBe(p.icon);
        expect(doc['model']).toBe(p.model ? `${p.model.provider}:${p.model.model}` : undefined);
        expect(doc['tools']).toEqual(p.tools);
        expect(doc['display']).toBe(p.display);
        expect(doc['output']).toBe(p.output);
        expect(doc['searches']).toBe(p.searches);
        expect(doc['fetches']).toBe(p.fetches);
        // YAML 1.1 readers (yes/no/on/off are booleans there) agree too.
        const old = YAML.parse(frontmatter(text), { version: '1.1' }) as Record<string, unknown>;
        expect(old['name']).toBe(p.name);
        expect(old['model']).toBe(p.model ? `${p.model.provider}:${p.model.model}` : undefined);
        // The body is the prompt, byte for byte.
        expect(text.endsWith(`\n---\n${p.prompt}`)).toBe(true);
      }),
    );
  });

  it('PR1: whatever Lektor accepts, a YAML parser reads the same way', () => {
    fc.assert(
      fc.property(id, fc.oneof(nearMiss, tokenFile), (i, t) => {
        const r = parsePreset(i, t);
        if (!r.ok) return;
        // The failsafe schema keeps every scalar a string, so quoting and escapes are what is compared.
        const doc = YAML.parse(frontmatter(t), { schema: 'failsafe', uniqueKeys: true }) as Record<string, unknown> | null;
        const get = (k: string) => {
          const v = doc?.[k];
          return v === '' ? undefined : v;
        };
        expect(get('name')).toBe(r.preset.name);
        expect(get('icon') ?? 'sparkles').toBe(r.preset.icon);
        expect(get('model')).toBe(r.preset.model ? `${r.preset.model.provider}:${r.preset.model.model}` : undefined);
        const tools = get('tools');
        expect(tools === undefined ? [] : typeof tools === 'string' ? [tools] : tools).toEqual(r.preset.tools);
        expect(get('output') ?? 'chat').toBe(r.preset.output);
        expect(get('searches')).toBe(r.preset.searches?.toString());
      }),
    );
  });

  it('PR1: a folder of files: each file gets exactly what parsing it alone gives; built-ins are always there', () => {
    const files = fc.array(fc.tuple(fc.oneof(id, fc.constantFrom(...BUILTIN_PRESETS.map((b) => b.id))), fc.oneof(anyText, preset.map(serializePreset), fc.constant(null))), { maxLength: 8 });
    fc.assert(
      fc.property(files, fc.subarray(BUILTIN_PRESETS.map((b) => b.id)), (list, hidden) => {
        const map = new Map(list);
        const lib = buildLibrary(map, new Set(hidden));
        expect(new Set(lib.map((e) => e.id)).size).toBe(lib.length);
        expect(lib.map((e) => e.id).slice(0, BUILTIN_PRESETS.length)).toEqual(BUILTIN_PRESETS.map((b) => b.id));
        for (const e of lib) {
          const text = map.get(e.id);
          const builtin = BUILTIN_PRESETS.find((b) => b.id === e.id);
          expect(e.hidden).toBe(builtin !== undefined && hidden.includes(e.id));
          if (text === undefined) {
            expect(builtin).toBeDefined();
            expect(e).toMatchObject({ source: 'builtin', preset: builtin });
            continue;
          }
          expect(e.source).toBe(builtin ? 'edited' : 'file');
          const alone = text === null ? null : parsePreset(e.id, text);
          if (alone?.ok) expect(e.preset).toEqual(alone.preset);
          else {
            // A broken override shows its error instead of the built-in.
            expect(e.preset).toBeNull();
            expect(e.error).toBe(alone ? alone.error : 'The file could not be read.');
          }
        }
        expect(lib.length).toBe(new Set([...map.keys(), ...BUILTIN_PRESETS.map((b) => b.id)]).size);
      }),
    );
  });

  it('PR1: the built-ins are valid presets, and survive being saved as files', () => {
    for (const b of BUILTIN_PRESETS) expect(parsePreset(b.id, serializePreset(b))).toEqual({ ok: true, preset: b });
  });

  it('PR1: errors name the line', () => {
    const error = (t: string) => {
      const r = parsePreset('x', t);
      return r.ok ? null : r.error;
    };
    expect(error('no frontmatter')).toContain('Line 1');
    expect(error('---\nname: A\nbogus: 1\n---\nP')).toMatch(/^Line 3: "bogus" is not a preset field/);
    expect(parsePreset('x', '---\nname: A\nname: B\n---\nP')).toEqual({ ok: false, error: 'Line 3: "name" appears twice.' });
    expect(parsePreset('x', '---\nname: "A\n---\nP')).toEqual({ ok: false, error: 'Line 2: a quoted value is not closed on its line.' });
    expect(error('---\nname: A\n')).toContain('never closed');
    expect(error('---\nname: A\n---\n   \n')).toContain('prompt');
    // Regression (PR1, a YAML-agreement counterexample): a comment needs a space before it, after a quoted value or a list.
    expect(error('---\nname: "A"#x\n---\nP')).toBe('Line 2: unexpected text after a quoted value.');
    expect(error('---\nname: A\ntools: []#x\n---\nP')).toBe('Line 3: unexpected text after a list.');
    expect(parsePreset('x', '---\nname: "A" # x\n---\nP')).toMatchObject({ ok: true, preset: { name: 'A' } });
    // Regression (PR1, a YAML-agreement counterexample): YAML reads "- a" as a list, so it needs quotes.
    expect(parsePreset('x', '---\nname: - a\n---\nP')).toEqual({ ok: false, error: 'Line 2: "- a" needs quotes.' });
    expect(parsePreset('x', '---\nname: "- a"\n---\nP')).toMatchObject({ ok: true, preset: { name: '- a' } });
    expect(parsePreset('x', '---\nname: A\ntools:\n  - web_search\n  - fetch_page\n---\nP')).toMatchObject({ ok: true, preset: { tools: ['web_search', 'fetch_page'] } });
    expect(parsePreset('x', '---\nname: A\nmodel: ollama:qwen3.8:27b # mine\n---\nP')).toMatchObject({ ok: true, preset: { model: { provider: 'ollama', model: 'qwen3.8:27b' } } });
  });

  it('PR1: the library over storage: hide, edit, reset, add, delete, reload', async () => {
    const storage = new MemStorage();
    let hidden: string[] = [];
    const lib = new PresetLibrary(storage, () => hidden);
    await lib.load();
    expect(lib.runnable().map((p) => p.id)).toEqual(['proofread', 'garden-paths', 'fact-check']);
    // Hidden built-ins don't run, and can't be found by id.
    hidden = ['garden-paths'];
    lib.refresh();
    expect(lib.runnable().map((p) => p.id)).toEqual(['proofread', 'fact-check']);
    expect(lib.get('garden-paths')).toBeNull();
    expect(lib.entries().find((e) => e.id === 'garden-paths')).toMatchObject({ hidden: true, source: 'builtin' });
    // Editing a built-in saves a file that takes precedence; resetting deletes it.
    await lib.save({ ...BUILTIN_PRESETS[0]!, prompt: 'Mine.' });
    expect(storage.files.get('presets/proofread')).toBe(serializePreset({ ...BUILTIN_PRESETS[0]!, prompt: 'Mine.' }));
    expect(lib.get('proofread')?.prompt).toBe('Mine.');
    await lib.remove('proofread');
    expect(lib.get('proofread')).toEqual(BUILTIN_PRESETS[0]);
    // A user's preset, and a broken file next to it.
    await lib.save({ id: 'tone', name: 'Tone', icon: 'x', tools: [], output: 'chat', prompt: 'Check the tone.' });
    await storage.write('presets', 'broken', 'not a preset');
    await lib.load();
    expect(lib.runnable().map((p) => p.id)).toEqual(['proofread', 'fact-check', 'tone']);
    expect(lib.entries().find((e) => e.id === 'broken')).toMatchObject({ source: 'file', preset: null, error: expect.any(String) as unknown });
    await lib.remove('tone');
    expect(lib.get('tone')).toBeNull();
    expect(storage.files.has('presets/tone')).toBe(false);
  });

  it('new preset ids are file keys, unique, and readable', () => {
    fc.assert(
      fc.property(fc.string(), fc.array(id), (n, taken) => {
        const i = presetIdFor(n, new Set(taken));
        expect(isPresetId(i)).toBe(true);
        expect(taken).not.toContain(i);
      }),
    );
    expect(presetIdFor('Garden paths', new Set())).toBe('garden-paths');
    expect(presetIdFor('Garden paths', new Set(['garden-paths']))).toBe('garden-paths-2');
    expect(presetIdFor('Ünïcödé!', new Set())).toBe('unicode');
    expect(presetIdFor('日本', new Set())).toBe('preset');
  });
});
