// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Approval cards on a reply (DESIGN.md § Tools framework, § Model-initiated requests).
 * A yes/no card for fetch_page; for request_context, every file with a checkbox,
 * all ticked, and Share or Deny. Nothing is read until the user answers.
 */

import { useState } from 'react';
import type { AssistantMessage } from '../../core/chat/types';
import { formatTokens } from '../../core/context/tokens';
import { Icon } from './Icon';

type Approval = NonNullable<AssistantMessage['approval']>;

export function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (id: string, ok: boolean, items?: readonly string[]) => void }) {
  if (approval.items) return <ChoiceCard approval={approval} items={approval.items} onAnswer={onAnswer} />;
  return (
    <div className="lektor-approval" role="group" aria-label={approval.title}>
      <div className="lektor-approval-title">{approval.title}</div>
      <code className="lektor-approval-detail">{approval.detail}</code>
      <div className="lektor-approval-actions">
        <button type="button" className="mod-cta" onClick={() => onAnswer(approval.id, true)}>
          Allow
        </button>
        <button type="button" onClick={() => onAnswer(approval.id, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

function ChoiceCard(props: { approval: Approval; items: NonNullable<Approval['items']>; onAnswer: (id: string, ok: boolean, items?: readonly string[]) => void }) {
  const { approval, items, onAnswer } = props;
  const available = items.filter((i) => i.unavailable === undefined);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(available.map((i) => i.id)));
  const total = available.filter((i) => ticked.has(i.id)).reduce((t, i) => t + i.tokens, 0);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
  };
  return (
    <div className="lektor-approval lektor-approval-choice" role="group" aria-label={approval.title}>
      <div className="lektor-approval-title">{approval.title}</div>
      <div className="lektor-approval-reason">{approval.detail}</div>
      <ul className="lektor-approval-items">
        {items.map((i) => (
          <li key={i.id} className={i.unavailable ? 'is-unavailable' : ''}>
            <label>
              <input type="checkbox" disabled={i.unavailable !== undefined} checked={i.unavailable === undefined && ticked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
              <Icon name={i.kind === 'note' ? 'file-text' : /\.(png|jpe?g|webp|gif)$/i.test(i.label) ? 'image' : 'paperclip'} />
              <span className="lektor-approval-path">{i.label}</span>
              <span className="lektor-chip-tokens">{i.unavailable ? `Can’t send: ${i.unavailable}` : `≈${formatTokens(i.tokens)}`}</span>
            </label>
          </li>
        ))}
      </ul>
      {approval.note && <div className="lektor-context-note">{approval.note}</div>}
      <div className="lektor-approval-actions">
        <button type="button" className="mod-cta" disabled={ticked.size === 0 || available.length === 0} onClick={() => onAnswer(approval.id, true, [...ticked])}>
          {available.length > 0 && ticked.size === available.length ? 'Share all' : `Share ${ticked.size}`}
          {total > 0 && ` (≈${formatTokens(total)})`}
        </button>
        <button type="button" onClick={() => onAnswer(approval.id, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
