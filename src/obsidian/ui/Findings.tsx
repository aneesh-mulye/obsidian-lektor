// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Findings in the chat (DESIGN.md § Presets, "Findings output"): one row per
 * finding, with its kind, verdict, quote (click to show it in the note),
 * explanation and sources, plus "Suggest fix" and dismiss. Sources are links
 * only if the chat knew the URL (INVARIANTS.md F1).
 */

import { type Finding, type FindingSet, suggestFixMessage } from '../../core/findings/findings';
import type { ChatSession } from '../../core/chat/session';
import { normaliseUrl } from '../../core/tools/urls';
import { IconButton } from './Icon';

export interface FindingsUi {
  /** Open the note and select the finding's passage. */
  reveal(set: FindingSet, finding: Finding): void;
}

const SPELLING = new Set(['typo', 'doubled-word', 'missing-word', 'homophone', 'punctuation', 'spelling']);

/** The colour family for a finding: by verdict for claims, by kind otherwise. */
export function findingTone(kind: string, verdict?: string): string {
  if (verdict) return verdict;
  if (SPELLING.has(kind)) return 'spelling';
  if (kind === 'garden-path') return 'garden';
  return 'other';
}

const VERDICT_LABEL: Record<string, string> = { correct: 'Correct', wrong: 'Wrong', doubtful: 'Doubtful', unverified: 'Couldn’t verify' };

export function FindingsCard(props: { set: FindingSet | undefined; session: ChatSession; ui: FindingsUi; busy: boolean }) {
  const { set, session, ui, busy } = props;
  if (!set) return null;
  const open = set.findings.filter((f) => f.status === 'open');
  const dismissed = set.findings.length - open.length;
  return (
    <div className="lektor-findings">
      <div className="lektor-findings-head">
        {set.findings.length === 1 ? '1 finding' : `${set.findings.length} findings`} in {set.path}
        {dismissed > 0 && <span className="lektor-findings-dismissed"> · {dismissed} dismissed</span>}
      </div>
      {open.map((f) => (
        <div key={f.id} className={`lektor-finding-row is-${findingTone(f.kind, f.verdict)}`}>
          <div className="lektor-finding-meta">
            <span className="lektor-finding-kind">{f.kind}</span>
            {f.verdict && <span className="lektor-finding-verdict">{VERDICT_LABEL[f.verdict] ?? f.verdict}</span>}
          </div>
          <button type="button" className="lektor-finding-quote" title="Show in the note" onClick={() => ui.reveal(set, f)}>
            “{f.quote.length > 200 ? `${f.quote.slice(0, 197)}…` : f.quote}”
          </button>
          {f.explanation && <div className="lektor-finding-explanation">{f.explanation}</div>}
          {f.sources.length > 0 && (
            <div className="lektor-finding-sources">
              {f.sources.map((s, i) =>
                s.known && normaliseUrl(s.url) === s.url ? (
                  <a key={i} className="external-link" href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.url}
                  </a>
                ) : (
                  <span key={i} className="lektor-source-unknown" title="Not from this chat’s searches or pages, so it is not a link">
                    {s.url}
                  </span>
                ),
              )}
            </div>
          )}
          <div className="lektor-finding-actions">
            <button type="button" disabled={busy} onClick={() => session.send(suggestFixMessage(set, f))}>
              Suggest fix
            </button>
            <IconButton icon="x" label="Dismiss" onClick={() => session.dismissFinding(set.id, f.id)} />
          </div>
        </div>
      ))}
    </div>
  );
}
