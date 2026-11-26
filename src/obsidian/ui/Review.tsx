// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Review cards in the conversation (DESIGN.md § Display modes; § Staleness and rebase):
 * per-hunk ✓ / ✕ for edits, Create / Dismiss for new notes. In Inline mode the card is a
 * summary (the marks are in the editor) with the changes folded away. Each edit card has
 * a staleness dot; when amber, it opens the rebase panel.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatSession } from '../../core/chat/session';
import { hunkView, type ReviewManager } from '../../core/review/manager';
import type { RebaseResult } from '../../core/review/rebase';
import type { EditProposal, NoteProposal, Proposal } from '../../core/review/types';
import type { DisplayMode } from '../../core/settings';
import { IconButton } from './Icon';

export interface ReviewUi {
  manager: ReviewManager;
  openNote: (path: string) => void;
  /** The display mode for chats that never chose one. */
  defaultMode: () => DisplayMode;
}

const titleOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');

// Which card's rebase panel to open (from the editor pill's amber dot).
let focused: { id: string; at: number } | null = null;
const focusListeners = new Set<() => void>();
export function focusProposal(id: string): void {
  focused = { id, at: Date.now() };
  for (const l of focusListeners) l();
}
const subscribeFocus = (l: () => void) => {
  focusListeners.add(l);
  return () => focusListeners.delete(l);
};
const getFocus = () => focused;

export function ProposalCard({ proposal, session, ui, mode }: { proposal: Proposal | undefined; session: ChatSession; ui: ReviewUi; mode: DisplayMode }) {
  useSyncExternalStore(ui.manager.subscribe, ui.manager.version);
  if (!proposal) return null;
  return proposal.kind === 'edit' ? <EditCard p={proposal} session={session} ui={ui} mode={mode} /> : <NoteCard p={proposal} session={session} ui={ui} />;
}

function EditCard({ p, session, ui, mode }: { p: EditProposal; session: ChatSession; ui: ReviewUi; mode: DisplayMode }) {
  const pending = p.hunks.filter((h) => h.status === 'pending').length;
  const accepted = p.hunks.filter((h) => h.status === 'accepted').length;
  const stale = ui.manager.stale.get(p.id) ?? [];
  const [panel, setPanel] = useState(false);
  const [result, setResult] = useState<RebaseResult | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const focus = useSyncExternalStore(subscribeFocus, getFocus);
  useEffect(() => {
    if (focus?.id !== p.id) return;
    setPanel(true);
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focus, p.id]);

  const inline = mode === 'inline';
  const changes = <Hunks p={p} session={session} ui={ui} />;
  return (
    <div className={`lektor-proposal${inline ? ' is-inline' : ''}`} ref={ref}>
      <div className="lektor-proposal-head">
        {pending > 0 && (
          <button
            type="button"
            className={`lektor-dot clickable-icon${stale.length > 0 ? ' is-stale' : ''}`}
            aria-label={
              stale.length > 0 ? `${stale.length} change${stale.length === 1 ? '' : 's'} no longer fit the note. Click to review.` : 'All proposed changes still fit the note'
            }
            data-tooltip-position="top"
            onClick={() => stale.length > 0 && setPanel(!panel)}
          />
        )}
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
      {(panel || result) && (
        <RebasePanel
          p={p}
          stale={stale.length}
          result={result}
          onRebase={() => void ui.manager.rebaseNow(session, p.id).then(setResult)}
          onKeep={() => {
            setPanel(false);
            setResult(null);
          }}
          onDiscard={() => {
            ui.manager.discard(session, p.id);
            setPanel(false);
            setResult(null);
          }}
        />
      )}
      {inline ? (
        <details className="lektor-proposal-details">
          <summary>{pending > 0 ? 'Marked in the note. Show the changes here' : 'Show the changes'}</summary>
          {changes}
        </details>
      ) : (
        changes
      )}
    </div>
  );
}

function RebasePanel(props: { p: EditProposal; stale: number; result: RebaseResult | null; onRebase: () => void; onKeep: () => void; onDiscard: () => void }) {
  const { p, stale, result } = props;
  if (result) {
    return (
      <div className="lektor-rebase-panel">
        <div>
          {result.kept.length > 0 ? `Rebased: ${result.kept.length} change${result.kept.length === 1 ? '' : 's'} kept.` : 'No changes could be kept.'}
          {result.dropped.length > 0 && ` ${result.dropped.length} dropped:`}
        </div>
        {result.dropped.length > 0 && (
          <ul className="lektor-rebase-dropped">
            {result.dropped.map((d) => {
              const v = hunkView(p, d.hunkId);
              return (
                <li key={d.hunkId}>
                  {v && v.before !== '' && <del>{v.before}</del>}
                  {v && v.after !== '' && <ins>{v.after}</ins>}
                  <span className="lektor-rebase-reason">: {d.reason}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="lektor-proposal-all">
          <button type="button" onClick={props.onKeep}>
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="lektor-rebase-panel">
      <div>
        The note has changed, and {stale} change{stale === 1 ? '' : 's'} no longer fit{stale === 1 ? 's' : ''} it. Rebase re-places what still matches and lists what it drops.
      </div>
      <div className="lektor-proposal-all">
        <button type="button" className="mod-cta" onClick={props.onRebase}>
          Rebase
        </button>
        <button type="button" onClick={props.onKeep}>
          Keep as-is
        </button>
        <button type="button" onClick={props.onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

function Hunks({ p, session, ui }: { p: EditProposal; session: ChatSession; ui: ReviewUi }) {
  const shownReason = new Set<number>();
  const stale = new Set(ui.manager.stale.get(p.id) ?? []);
  return (
    <>
      {p.hunks.map((h) => {
        const v = hunkView(p, h.id)!;
        const reason = !shownReason.has(h.edit) ? p.edits[h.edit]!.reason : undefined;
        shownReason.add(h.edit);
        const problem = h.status === 'dropped' ? `Dropped: ${h.dropReason ?? 'it no longer fits the note'}.` : ui.manager.problems.get(h.id);
        const isStale = h.status === 'pending' && stale.has(h.id);
        return (
          <div key={h.id} className={`lektor-hunk is-${h.status}${problem || isStale ? ' is-conflict' : ''}`}>
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
                <span className="lektor-hunk-status">{h.status === 'accepted' ? 'Accepted' : h.status === 'rejected' ? 'Rejected' : 'Dropped'}</span>
              )}
            </div>
            {problem && h.status !== 'accepted' && h.status !== 'rejected' && <div className="lektor-hunk-problem">{problem}</div>}
            {!problem && isStale && <div className="lektor-hunk-problem">The note changed here; this no longer fits.</div>}
          </div>
        );
      })}
    </>
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
