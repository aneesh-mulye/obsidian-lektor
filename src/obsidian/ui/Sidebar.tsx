// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The sidebar's three zones (DESIGN.md § UI): header, conversation, composer. */

import { Menu } from 'obsidian';
import { type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatSummary } from '../../core/chat/history';
import type { ChatManager } from '../../core/chat/manager';
import { type AssistantMessage, type Chat, type ToolRound, displayModeOf } from '../../core/chat/types';
import type { DisplayMode } from '../../core/settings';
import type { Capabilities, ChatProvider } from '../../core/providers/types';
import { normaliseUrl } from '../../core/tools/urls';
import type { ModelRef } from '../../core/providers/types';
import type { ChatSession } from '../../core/chat/session';
import { ContextBar, type ContextUi } from './ContextBar';
import { ProposalCard, type ReviewUi } from './Review';
import { Icon, IconButton } from './Icon';
import { SafeMarkdown } from './SafeMarkdown';

export interface SidebarProps {
  manager: ChatManager;
  providers: readonly ChatProvider[];
  /** Asks the user to confirm, then clears every chat. */
  clearAllChats: () => Promise<void>;
  /** The context chips; absent if the context system is unavailable. */
  context?: ContextUi;
  /** Whether a web search provider is set up. */
  searchConfigured?: () => boolean;
  /** Reviewing proposed edits and notes. */
  review?: ReviewUi;
}

/** The model's capabilities (null while unknown). */
function useCapabilities(providers: readonly ChatProvider[], model: ModelRef | null): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    let alive = true;
    setCaps(null);
    const provider = model ? providers.find((p) => p.id === model.provider) : undefined;
    if (provider && model) {
      provider.capabilities(model.model).then(
        (c) => alive && setCaps(c),
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
  }, [providers, model?.provider, model?.model]);
  return caps;
}

export function Sidebar({ manager, providers, clearAllChats, context, searchConfigured, review }: SidebarProps) {
  const { chat, busy } = useSyncExternalStore(manager.subscribe, manager.snapshot);
  const [historyOpen, setHistoryOpen] = useState(false);
  const caps = useCapabilities(providers, chat.model);
  const window = caps?.contextWindow ?? null;

  return (
    <div
      className="lektor-sidebar"
      onDragOver={(e) => {
        if (context) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!context) return;
        e.preventDefault();
        context.drop();
      }}
    >
      <Header
        chat={chat}
        manager={manager}
        providers={providers}
        caps={caps}
        searchConfigured={searchConfigured?.() ?? false}
        historyOpen={historyOpen}
        mode={review ? displayModeOf(chat, review.defaultMode()) : null}
        onNewChat={() => {
          manager.newChat();
          setHistoryOpen(false);
        }}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
      />
      {historyOpen ? (
        <HistoryPanel manager={manager} currentId={chat.id} onOpened={() => setHistoryOpen(false)} clearAllChats={clearAllChats} />
      ) : (
        <Conversation
          chat={chat}
          busy={busy}
          session={manager.session}
          {...(review ? { review } : {})}
          onRegenerate={() => manager.session.regenerate()}
          onApprove={(id, ok) => manager.session.answerApproval(id, ok)}
        />
      )}
      {context && <ContextBar ui={context} chat={chat} window={window} calibration={manager.session.calibration} />}
      <Composer
        busy={busy}
        canSend={chat.model !== null}
        onSend={(text) => manager.session.send(text)}
        onStop={() => manager.session.stop()}
        {...(context ? { onMention: (done: () => void) => context.pickNote(done) } : {})}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'not reachable';
}

const MODES: Record<DisplayMode, { title: string; icon: string }> = {
  prose: { title: 'Prose: the model describes changes in words', icon: 'pilcrow' },
  sidebar: { title: 'Sidebar diff: review changes here', icon: 'git-compare' },
  inline: { title: 'Inline: review changes in the note', icon: 'highlighter' },
};

function toolsState(on: boolean, caps: Capabilities | null, searchConfigured: boolean): { label: string; warn: boolean } {
  const next = ' Changes apply from your next message.';
  if (!on) return { label: `Tools off: no web search or page fetching.${next}`, warn: false };
  if (caps && caps.toolCalling !== 'native') return { label: "Tools are on, but this model can't call tools.", warn: true };
  if (!searchConfigured) return { label: `Tools on: page fetching only. Set up a search provider in Lektor's settings for web search.${next}`, warn: true };
  return { label: `Tools on: web search and page fetching.${next}`, warn: false };
}

function Header(props: {
  chat: Chat;
  manager: ChatManager;
  providers: readonly ChatProvider[];
  caps: Capabilities | null;
  searchConfigured: boolean;
  historyOpen: boolean;
  /** The chat's display mode; null without review. */
  mode: DisplayMode | null;
  onNewChat: () => void;
  onToggleHistory: () => void;
}) {
  const { chat, manager, providers } = props;
  const pickMode = (ev: MouseEvent<HTMLButtonElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const menu = new Menu();
    for (const m of ['prose', 'sidebar', 'inline'] as const) {
      menu.addItem((i) =>
        i
          .setTitle(MODES[m].title)
          .setIcon(MODES[m].icon)
          .setChecked(props.mode === m)
          .onClick(() => manager.session.setDisplayMode(m)),
      );
    }
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  };
  const [loading, setLoading] = useState(false);

  const openPicker = async (ev: MouseEvent<HTMLButtonElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    setLoading(true);
    const menu = new Menu();
    for (const provider of providers) {
      try {
        const models = await provider.listModels();
        if (models.length === 0) menu.addItem((i) => i.setTitle(`${provider.label}: no models installed`).setDisabled(true));
        for (const m of models) {
          menu.addItem((i) =>
            i
              .setTitle(`${provider.label} · ${m.name}`)
              .setChecked(chat.model?.provider === provider.id && chat.model.model === m.id)
              .onClick(() => void manager.pickModel({ provider: provider.id, model: m.id })),
          );
        }
      } catch (err) {
        menu.addItem((i) => i.setTitle(`${provider.label}: ${errorText(err)}`).setDisabled(true));
      }
    }
    setLoading(false);
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  };

  const label = chat.model ? chat.model.model : 'Choose model';
  return (
    <div className="lektor-header">
      <button
        type="button"
        className="lektor-model-picker clickable-icon"
        aria-label={chat.model ? `Model: ${chat.model.provider} · ${chat.model.model}` : 'Choose a model'}
        data-tooltip-position="bottom"
        onClick={(ev) => void openPicker(ev)}
      >
        <Icon name={loading ? 'loader' : 'cpu'} />
        <span className="lektor-model-name">{label}</span>
        <Icon name="chevron-down" />
      </button>
      <div className="lektor-header-actions">
        {props.mode && <IconButton icon={MODES[props.mode].icon} label={`${MODES[props.mode].title}. Click to change.`} onClick={pickMode} />}
        {(() => {
          const on = chat.toolsDisabled !== true;
          const state = toolsState(on, props.caps, props.searchConfigured);
          return (
            <IconButton
              icon="globe"
              label={state.label}
              active={on && !state.warn}
              className={state.warn ? 'is-warn' : on ? '' : 'is-off'}
              onClick={() => manager.session.setTools(!on)}
            />
          );
        })()}
        <IconButton icon="square-pen" label="New chat" onClick={props.onNewChat} />
        <IconButton icon="history" label="Chat history" active={props.historyOpen} onClick={props.onToggleHistory} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation

function Conversation(props: {
  chat: Chat;
  busy: boolean;
  session: ChatSession;
  review?: ReviewUi;
  onRegenerate: () => void;
  onApprove: (id: string, ok: boolean) => void;
}) {
  const { chat, busy, session, review, onRegenerate, onApprove } = props;
  const mode = review ? displayModeOf(chat, review.defaultMode()) : 'sidebar';
  const card = (id: string) => (review ? <ProposalCard key={id} proposal={chat.proposals?.[id]} session={session} ui={review} mode={mode} /> : null);
  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const onScroll = () => {
    const el = ref.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (chat.messages.length === 0) {
    return (
      <div className="lektor-conversation lektor-empty">
        <p>{chat.model ? 'Ask anything.' : 'Choose a model above to start.'}</p>
      </div>
    );
  }

  const last = chat.messages.length - 1;
  return (
    <div className="lektor-conversation" ref={ref} onScroll={onScroll}>
      {chat.messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={m.id} className="lektor-message lektor-user">
            {m.content}
          </div>
        ) : (
          <Reply key={m.id} message={m} canRegenerate={i === last && !busy} onRegenerate={onRegenerate} onApprove={onApprove} card={card} />
        ),
      )}
    </div>
  );
}

function Reply(props: {
  message: AssistantMessage;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onApprove: (id: string, ok: boolean) => void;
  card: (proposalId: string) => ReactNode;
}) {
  const { message: m, canRegenerate, onRegenerate, onApprove, card } = props;
  const streaming = m.status === 'streaming';
  const steps = m.steps ?? [];
  return (
    <div className="lektor-message lektor-assistant">
      {m.reasoning !== '' && (
        <details className="lektor-reasoning">
          <summary>{streaming && m.content === '' ? 'Thinking…' : 'Thinking'}</summary>
          <div className="lektor-reasoning-text">{m.reasoning}</div>
        </details>
      )}
      {steps.map((round, k) => (
        <ToolRoundView key={k} round={round} card={card} />
      ))}
      {m.approval && (
        <div className="lektor-approval" role="group" aria-label={m.approval.title}>
          <div className="lektor-approval-title">{m.approval.title}</div>
          <code className="lektor-approval-detail">{m.approval.detail}</code>
          <div className="lektor-approval-actions">
            <button type="button" className="mod-cta" onClick={() => onApprove(m.approval!.id, true)}>
              Allow
            </button>
            <button type="button" onClick={() => onApprove(m.approval!.id, false)}>
              Deny
            </button>
          </div>
        </div>
      )}
      {m.content !== '' && <SafeMarkdown text={m.content} />}
      {(m.fencedProposals ?? []).map(card)}
      {m.notice && <div className="lektor-note">{m.notice}</div>}
      {streaming && m.content === '' && m.reasoning === '' && steps.length === 0 && <div className="lektor-pending" aria-label="Waiting for the model">…</div>}
      {m.status === 'stopped' && <div className="lektor-note">Stopped.</div>}
      {m.status === 'truncated' && <div className="lektor-note">Cut off at the model’s length limit.</div>}
      {m.status === 'error' && <div className="lektor-error">{m.error ?? 'The reply failed.'}</div>}
      {canRegenerate && (
        <div className="lektor-actions">
          <IconButton icon="refresh-cw" label={m.status === 'error' ? 'Try again' : 'Regenerate'} onClick={onRegenerate} />
        </div>
      )}
    </div>
  );
}

/** One tool round: what the model said, then one line for its calls (expandable). */
function ToolRoundView({ round, card }: { round: ToolRound; card: (proposalId: string) => ReactNode }) {
  const searches = round.calls.filter((c) => c.name === 'web_search');
  const fetches = round.calls.filter((c) => c.name === 'fetch_page');
  const results = searches.reduce((t, c) => t + (c.result?.urls?.length ?? 0), 0);
  const parts: string[] = [];
  const okSearches = searches.filter((c) => c.result?.ok).length;
  const failedSearches = searches.filter((c) => c.result && !c.result.ok && !c.result.limit).length;
  if (okSearches > 0) parts.push(`Searched: ${okSearches} ${okSearches === 1 ? 'query' : 'queries'} · ${results} ${results === 1 ? 'result' : 'results'}`);
  if (failedSearches > 0) parts.push(failedSearches === 1 ? 'Search failed' : `${failedSearches} searches failed`);
  const fetched = fetches.filter((c) => c.result?.ok).length;
  const notFetched = fetches.filter((c) => c.result && !c.result.ok && !c.result.limit).length;
  if (fetched > 0) parts.push(`Fetched ${fetched} ${fetched === 1 ? 'page' : 'pages'}`);
  if (notFetched > 0) parts.push(notFetched === 1 ? 'Fetch failed or declined' : `${notFetched} fetches failed or declined`);
  const proposals = round.calls.filter((c) => c.name === 'propose_edit' || c.name === 'propose_note');
  const madeProposals = proposals.filter((c) => c.result?.ok).length;
  if (madeProposals > 0) parts.push(madeProposals === 1 ? 'Proposed changes' : `Proposed ${madeProposals} sets of changes`);
  const failedProposals = proposals.filter((c) => c.result && !c.result.ok).length;
  if (failedProposals > 0) parts.push(failedProposals === 1 ? 'A proposal was refused' : `${failedProposals} proposals were refused`);
  const others = round.calls.length - searches.length - fetches.length - proposals.length;
  if (others > 0) parts.push(`${others} other tool ${others === 1 ? 'call' : 'calls'}`);
  if (round.calls.some((c) => c.result?.limit)) parts.push('limit reached');
  if (round.calls.some((c) => !c.result)) parts.push('working…');
  return (
    <>
      {round.text !== '' && <SafeMarkdown text={round.text} />}
      <details className="lektor-tools">
        <summary>{parts.join(' · ')}</summary>
        <ul>
          {round.calls.map((c) => (
            <li key={c.id} className={c.result && !c.result.ok ? 'is-failed' : ''}>
              <span>{c.result ? c.result.summary : `${c.name}…`}</span>
              {c.result && !c.result.ok && <div className="lektor-tool-error">{c.result.content}</div>}
              {(c.result?.urls ?? []).map((u) =>
                normaliseUrl(u) === u ? (
                  <div key={u}>
                    <a className="external-link" href={u} target="_blank" rel="noopener noreferrer">
                      {u}
                    </a>
                  </div>
                ) : null,
              )}
            </li>
          ))}
        </ul>
      </details>
      {round.calls.flatMap((c) => (c.result?.proposalId ? [card(c.result.proposalId)] : []))}
    </>
  );
}

// ---------------------------------------------------------------------------
// History

function HistoryPanel(props: { manager: ChatManager; currentId: string; onOpened: () => void; clearAllChats: () => Promise<void> }) {
  const { manager } = props;
  const [state, setState] = useState<{ chats: ChatSummary[]; unreadable: number } | null>(null);

  const reload = useCallback(() => {
    manager.list().then(setState, () => setState({ chats: [], unreadable: 0 }));
  }, [manager]);
  useEffect(reload, [reload]);

  if (state === null) return <div className="lektor-conversation lektor-history" />;
  return (
    <div className="lektor-conversation lektor-history">
      {state.chats.length === 0 && <p className="lektor-note">No saved chats.</p>}
      {state.chats.map((c) => (
        <div key={c.id} className={`lektor-history-row${c.id === props.currentId ? ' is-active' : ''}`}>
          <button
            type="button"
            className="lektor-history-open"
            onClick={() => void manager.open(c.id).then((ok) => ok && props.onOpened())}
          >
            <span className="lektor-history-title">{c.title || 'Untitled chat'}</span>
            <span className="lektor-history-date">{new Date(c.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </button>
          <IconButton icon="trash-2" label="Delete chat" onClick={() => void manager.delete(c.id).then(reload)} />
        </div>
      ))}
      {state.unreadable > 0 && (
        <p className="lektor-note">
          {state.unreadable === 1 ? '1 chat file could not be read.' : `${state.unreadable} chat files could not be read.`}
        </p>
      )}
      {(state.chats.length > 0 || state.unreadable > 0) && (
        <div className="lektor-history-footer">
          <button type="button" className="mod-warning" onClick={() => void props.clearAllChats().then(reload)}>
            Clear all chats
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer

function Composer(props: {
  busy: boolean;
  canSend: boolean;
  onSend: (text: string) => boolean;
  onStop: () => void;
  /** Typing "@" at the start of a word: open the note picker; `picked` removes the "@". */
  onMention?: (picked: () => void) => void;
}) {
  const { busy, canSend, onSend, onStop, onMention } = props;
  const [text, setText] = useState('');
  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const caret = e.target.selectionStart;
    const typedAt = value.length === text.length + 1 && value[caret - 1] === '@' && (caret === 1 || /\s/.test(value[caret - 2] ?? ''));
    setText(value);
    if (typedAt && onMention) onMention(() => setText((v) => (v[caret - 1] === '@' ? v.slice(0, caret - 1) + v.slice(caret) : v)));
  };
  const submit = () => {
    if (onSend(text)) setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy) submit();
    }
  };
  return (
    <div className="lektor-composer">
      <textarea
        className="lektor-input"
        value={text}
        rows={3}
        placeholder={canSend ? 'Message (Enter to send, Shift+Enter for a new line)' : 'Choose a model first'}
        disabled={!canSend}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <IconButton icon="square" label="Stop" className="lektor-send" onClick={onStop} />
      ) : (
        <IconButton icon="send" label="Send" className="lektor-send" disabled={!canSend || text.trim() === ''} onClick={submit} />
      )}
    </div>
  );
}
