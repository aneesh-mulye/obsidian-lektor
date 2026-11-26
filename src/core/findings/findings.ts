// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Findings (DESIGN.md § Presets, "Findings output"; INVARIANTS.md F1, F2):
 * what a proofread, garden-path or fact-check preset reports. Each finding
 * quotes a passage of a note in context; it is kept only if that passage
 * occurs exactly once, so its highlight can only ever land on it.
 *
 * Findings never change the note. "Suggest fix" asks the model for an edit,
 * which goes through review like any other.
 */

import { z } from 'zod';
import type { ToolRun } from '../chat/types';
import type { ModelRef } from '../providers/types';
import { fingerprint } from '../review/fingerprint';
import { occurrences } from '../review/proposals';
import { type Tool, ToolError } from '../tools/types';
import { type KnownUrls, normaliseUrl } from '../tools/urls';

export const VERDICTS = ['correct', 'wrong', 'doubtful', 'unverified'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface FindingSource {
  readonly url: string;
  /** Whether the URL was known to the chat when reported (search results, fetched pages, the user's messages, attached notes). Only known URLs are links. */
  readonly known: boolean;
}

export interface Finding {
  readonly id: string;
  /** Copied exactly from the note; it occurred exactly once there when reported. */
  readonly quote: string;
  /** Where the quote started in the note when reported. */
  readonly at: number;
  /** e.g. typo, homophone, garden-path, claim (lowercase). */
  readonly kind: string;
  readonly explanation: string;
  readonly verdict?: Verdict;
  readonly sources: readonly FindingSource[];
  readonly status: 'open' | 'dismissed';
}

export interface FindingSet {
  readonly id: string;
  readonly path: string;
  /** Fingerprint of the note's text when reported: while it still matches, positions are exact. */
  readonly expect: string;
  readonly findings: readonly Finding[];
  readonly createdAt: number;
  readonly model: ModelRef;
}

export const ReportFindingsArgs = z.object({
  path: z.string().min(1).max(500).optional().describe('The note, exactly as named in the context. May be left out when only one note is in context.'),
  findings: z
    .array(
      z.object({
        quote: z.string().min(1).max(1000).describe('The passage, copied exactly from the note, long enough to occur only once.'),
        kind: z.string().trim().min(1).max(40).describe('What sort of finding: e.g. typo, homophone, garden-path, claim.'),
        explanation: z.string().max(2000).describe('What is wrong, briefly.'),
        verdict: z.enum(VERDICTS).optional().describe('For claims: correct, wrong, doubtful or unverified.'),
        sources: z.array(z.string().max(2000)).max(10).optional().describe('URLs of pages you relied on.'),
      }),
    )
    .min(1)
    .max(100),
});
export type ReportFindingsArgs = z.infer<typeof ReportFindingsArgs>;

export interface FindingsDeps {
  /** The note's current text (through ContextBroker). */
  readNote: (path: string) => Promise<string>;
  newId: () => string;
  now: () => number;
}

const NO_MODEL: ModelRef = { provider: 'none', model: 'none' };
const preview = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** Validate a report against the note: keep each finding whose quote occurs exactly once; say why the others were not kept. */
export async function makeFindings(
  args: ReportFindingsArgs,
  editable: ReadonlySet<string>,
  known: KnownUrls,
  model: ModelRef | null,
  deps: FindingsDeps,
): Promise<{ set: FindingSet | null; problems: string[] }> {
  const notes = [...editable];
  const path = args.path ?? (notes.length === 1 ? notes[0]! : undefined);
  if (path === undefined || !editable.has(path)) {
    const list = notes.join(', ');
    throw new ToolError(`You can only report findings for notes in the context${list ? `: ${list}` : ', and there are none'}. Give "path" exactly as named there.`);
  }
  let text: string;
  try {
    text = await deps.readNote(path);
  } catch {
    throw new ToolError(`Lektor could not read ${path}.`);
  }
  const findings: Finding[] = [];
  const problems: string[] = [];
  args.findings.forEach((f, i) => {
    const at = occurrences(text, f.quote, 2);
    if (at.length !== 1) {
      problems.push(`${i + 1}. ${preview(f.quote)} ${at.length === 0 ? 'is not in the note (quote it exactly)' : 'appears more than once (quote more of it)'}`);
      return;
    }
    findings.push({
      id: deps.newId(),
      quote: f.quote,
      at: at[0]!,
      kind: f.kind.trim().toLowerCase(),
      explanation: f.explanation,
      ...(f.verdict ? { verdict: f.verdict } : {}),
      sources: (f.sources ?? []).map((url) => ({ url, known: known.has(url) && normaliseUrl(url) === url })),
      status: 'open',
    });
  });
  if (findings.length === 0) return { set: null, problems };
  return { set: { id: deps.newId(), path, expect: fingerprint(text), findings, createdAt: deps.now(), model: model ?? NO_MODEL }, problems };
}

export function reportFindingsTool(deps: FindingsDeps): Tool<ReportFindingsArgs> {
  return {
    name: 'report_findings',
    description:
      'Report findings about a note in the context: each one quotes a passage exactly (long enough to occur only once) and says what is wrong. ' +
      'The user sees them highlighted in the note. Report all your findings in one call. This never changes the note.',
    schema: ReportFindingsArgs,
    approval: 'never', // nothing is written; findings are only shown
    touchesVault: true, // reads the note through ContextBroker, to check the quotes
    async run(args, ctx) {
      const { set, problems } = await makeFindings(args, ctx.editable, ctx.knownUrls, ctx.model, deps);
      const notKept = problems.length > 0 ? ` Not recorded (send these again with an exact, longer quote): ${problems.join('; ')}.` : '';
      if (!set) throw new ToolError(`No findings were recorded.${notKept}`);
      const n = set.findings.length;
      return {
        content: `Recorded ${n} finding${n === 1 ? '' : 's'} in ${set.path}. The user sees them in the note; do not list them again in full.${notKept}`,
        summary: `${set.path}: ${n} finding${n === 1 ? '' : 's'}${problems.length > 0 ? `, ${problems.length} not placed` : ''}`,
        findings: set,
      };
    },
  };
}

const FENCE = /```lektor-findings[^\n]*\n([\s\S]*?)```/g;

/** For models without tool calling: findings in fenced `lektor-findings` blocks. */
export function fencedFindings(deps: FindingsDeps, editable: ReadonlySet<string>, known: KnownUrls, model: ModelRef | null): NonNullable<ToolRun['fenced']> {
  const list = [...editable].map((p) => `- ${p}`).join('\n');
  return {
    instructions:
      'The notes in the context are:\n' +
      `${list}\n` +
      'Report your findings in one fenced block like this, quoting each passage exactly as it appears in the note (long enough to occur only once):\n' +
      '```lektor-findings\n{"path": "Folder/Note.md", "findings": [{"quote": "exact text", "kind": "typo", "explanation": "what is wrong", "verdict": "wrong", "sources": ["https://…"]}]}\n```\n' +
      '"verdict" (correct, wrong, doubtful or unverified) and "sources" are for fact checks only. Then add one short line saying how many you found.',
    async extract(reply) {
      const findings: FindingSet[] = [];
      const problems: string[] = [];
      for (const [i, m] of [...reply.matchAll(FENCE)].entries()) {
        let value: unknown;
        try {
          value = JSON.parse(m[1]!);
        } catch {
          problems.push(`Block ${i + 1} is not valid JSON.`);
          continue;
        }
        const args = ReportFindingsArgs.safeParse(value);
        if (!args.success) {
          problems.push(`Block ${i + 1} is not a valid list of findings (it needs "findings", each with "quote", "kind" and "explanation").`);
          continue;
        }
        try {
          const r = await makeFindings(args.data, editable, known, model, deps);
          if (r.set) findings.push(r.set);
          for (const p of r.problems) problems.push(`Block ${i + 1}, finding ${p}`);
        } catch (err) {
          problems.push(`Block ${i + 1}: ${err instanceof Error ? err.message : 'invalid'}`);
        }
      }
      return { proposals: [], findings, problems };
    },
  };
}

// ---------------------------------------------------------------------------
// Placement (INVARIANTS.md F2)

export interface FindingMark {
  setId: string;
  findingId: string;
  from: number;
  to: number;
  kind: string;
}

/** Where an open finding is in the note now: at its stored position while the note is unchanged, else where its quote occurs exactly once, else nowhere. */
export function placeFinding(text: string, set: FindingSet, f: Finding, unchanged = fingerprint(text) === set.expect): { from: number; to: number } | null {
  if (f.status !== 'open') return null;
  if (unchanged && text.startsWith(f.quote, f.at)) return { from: f.at, to: f.at + f.quote.length };
  const at = occurrences(text, f.quote, 2);
  return at.length === 1 ? { from: at[0]!, to: at[0]! + f.quote.length } : null;
}

/** Highlights for a note's open findings, in order. */
export function findingMarks(text: string, sets: readonly FindingSet[]): FindingMark[] {
  const fp = fingerprint(text);
  const out: FindingMark[] = [];
  for (const set of sets) {
    for (const f of set.findings) {
      const p = placeFinding(text, set, f, fp === set.expect);
      if (p) out.push({ setId: set.id, findingId: f.id, ...p, kind: f.kind });
    }
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The message "Suggest fix" sends: an edit for that passage only. */
export function suggestFixMessage(set: FindingSet, f: Finding): string {
  return (
    `Suggest a fix for this ${f.kind} in ${set.path}: “${f.quote}”` +
    (f.explanation ? ` (${f.explanation.trim().replace(/\.$/, '')})` : '') +
    '. Use propose_edit, changing only that passage.'
  );
}
