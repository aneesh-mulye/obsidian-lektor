// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Review cards in the conversation: per-hunk ✓ / ✕ for edits, Create / Dismiss for new notes (DESIGN.md § Display modes). */

import { useSyncExternalStore } from 'react';
import type { ChatSession } from '../../core/chat/session';
import { hunkView, type ReviewManager } from '../../core/review/manager';
import type { EditProposal, NoteProposal, Proposal } from '../../core/review/types';
import { IconButton } from './Icon';

export interface ReviewUi {
  manager: ReviewManager;
  openNote: (path: string) => void;
}

const titleOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');

export function ProposalCard({ proposal, session, ui }: { proposal: Proposal | undefined; session: ChatSession; ui: ReviewUi }) {
  useSyncExternalStore(ui.manager.subscribe, ui.manager.version);
  if (!proposal) return null;
  return proposal.kind === 'edit' ? <EditCard p={proposal} session={session} ui={ui} /> : <NoteCard p={proposal} session={session} ui={ui} />;
}

function EditCard({ p, session, ui }: { p: EditProposal; session: ChatSession; ui: ReviewUi }) {
  const pending = p.hunks.filter((h) => h.status === 'pending').length;
  const accepted = p.hunks.filter((h) => h.status === 'accepted').length;
  const shownReason = new Set<number>();
  return (
    <div className="lektor-proposal">
      <div className="lektor-proposal-head">
        <button type="button" className="lektor-link" onClick={() => ui.openNote(p.path)} aria-label={`Open ${p.path}`} data-tooltip-position="top">
          {titleOf(p.path)}
        </button>
        <span className="lektor-proposal-count">{pending > 0 ? `${pending} of ${p.hunks.length} to review` : `${accepted} of ${p.hunks.length} accepted`}</span>
        {pending > 0 && (
          <span className="lektor-proposal-all">
            <button type="button" className="mod-cta" onClick={() => void ui.manager.acceptAll(session, p.id)}>
              Accept all
            </button>
            <button type="button" onClick={() => ui.manager.rejectAll(session, p.id)}>
              Reject all
            </button>
          </span>
        )}
      </div>
      {p.hunks.map((h) => {
        const v = hunkView(p, h.id)!;
        const reason = !shownReason.has(h.edit) ? p.edits[h.edit]!.reason : undefined;
        shownReason.add(h.edit);
        const problem = ui.manager.problems.get(h.id);
        return (
          <div key={h.id} className={`lektor-hunk is-${h.status}${problem ? ' is-conflict' : ''}`}>
            {reason && <div className="lektor-hunk-reason">{reason}</div>}
            <div className="lektor-hunk-body">
              <span className="lektor-hunk-text">
                {v.lead.length > 0 && <span className="lektor-hunk-context">{v.lead.length >= 40 ? `…${v.lead}` : v.lead}</span>}
                {v.before !== '' && <del>{v.before}</del>}
                {v.after !== '' && <ins>{v.after}</ins>}
                {v.trail.length > 0 && <span className="lektor-hunk-context">{v.trail.length >= 40 ? `${v.trail}…` : v.trail}</span>}
              </span>
              {h.status === 'pending' ? (
                <span className="lektor-hunk-actions">
                  <IconButton icon="check" label="Accept this change" onClick={() => void ui.manager.acceptHunk(session, p.id, h.id)} />
                  <IconButton icon="x" label="Reject this change" onClick={() => ui.manager.rejectHunk(session, p.id, h.id)} />
                </span>
              ) : (
                <span className="lektor-hunk-status">{h.status === 'accepted' ? 'Accepted' : 'Rejected'}</span>
              )}
            </div>
            {problem && h.status === 'pending' && <div className="lektor-hunk-problem">{problem}</div>}
          </div>
        );
      })}
    </div>
  );
}

function NoteCard({ p, session, ui }: { p: NoteProposal; session: ChatSession; ui: ReviewUi }) {
  const problem = ui.manager.problems.get(p.id);
  const preview = p.content.length > 1200 ? `${p.content.slice(0, 1200)}…` : p.content;
  return (
    <div className="lektor-proposal">
      <div className="lektor-proposal-head">
        <span>New note:</span>
        {p.status === 'created' ? (
          <button type="button" className="lektor-link" onClick={() => ui.openNote(p.path)}>
            {p.path}
          </button>
        ) : (
          <code>{p.path}</code>
        )}
      </div>
      <pre className="lektor-note-preview">{preview}</pre>
      {p.status === 'pending' ? (
        <div className="lektor-proposal-all">
          <button type="button" className="mod-cta" onClick={() => void ui.manager.createNote(session, p.id)}>
            Create
          </button>
          <button type="button" onClick={() => ui.manager.dismissNote(session, p.id)}>
            Dismiss
          </button>
        </div>
      ) : (
        <div className="lektor-hunk-status">{p.status === 'created' ? 'Created' : 'Dismissed'}</div>
      )}
      {problem && p.status === 'pending' && <div className="lektor-hunk-problem">{problem}</div>}
    </div>
  );
}
