// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Valid presets, for the preset and history tests (INVARIANTS.md PR1, H6). */

import fc from 'fast-check';
import { PRESET_OUTPUTS, PRESET_TOOLS, type Preset, isPresetId, presetNameProblem } from '../../src/core/presets/preset';
import { DISPLAY_MODES } from '../../src/core/settings';

export const id = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,20}$/).filter(isPresetId);
const tricky = fc.constantFrom('true', 'No', 'null', '~', '123', '0x1F', '- a', 'a: b', 'a:b', '#tag', 'x #y', '"q"', "it's", '[x]', '{x}', 'a\\b', '  pad', 'Ünïcödé', '日本語', '🙂 emoji', 'tab\there', 'trailing:');
const name = fc.oneof(tricky, fc.string({ minLength: 1, maxLength: 60, unit: 'grapheme' })).map((s) => s.trim()).filter((s) => presetNameProblem(s) === null);
const icon = fc.oneof(fc.constantFrom('spell-check', 'signpost', 'badge-check', 'sparkles', 'x'), fc.stringMatching(/^[a-z0-9]{1,8}(-[a-z0-9]{1,8}){0,2}$/));
const model = fc.record({
  provider: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
  model: fc.oneof(fc.constantFrom('qwen3.8:27b', 'llama3', 'a b', 'x: y', '#1'), fc.string({ minLength: 1, maxLength: 30, unit: 'grapheme' })),
  // eslint-disable-next-line no-control-regex -- control characters are exactly what presets refuse
}).filter((m) => m.model.trim() !== '' && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(m.model) && m.model.trim() === m.model || m.model === 'a b');
const prompt = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 200, unit: 'grapheme' }),
    fc.constantFrom('Proofread.\n---\nnot frontmatter\n', '\r\nCRLF body\r\n', '  leading spaces', 'line\n\n\nend\n', '---', '# Heading\n- list'),
  )
  .filter((s) => s.trim() !== '');

export const preset: fc.Arbitrary<Preset> = fc
  .record(
    {
      id,
      name,
      icon,
      model,
      tools: fc.subarray([...PRESET_TOOLS]).chain((t) => fc.shuffledSubarray(t, { minLength: t.length, maxLength: t.length })),
      display: fc.constantFrom(...DISPLAY_MODES),
      output: fc.constantFrom(...PRESET_OUTPUTS),
      searches: fc.integer({ min: 0, max: 50 }),
      fetches: fc.integer({ min: 0, max: 50 }),
      prompt,
    },
    { requiredKeys: ['id', 'name', 'icon', 'tools', 'output', 'prompt'] },
  )
  .map((p) => p as Preset);

