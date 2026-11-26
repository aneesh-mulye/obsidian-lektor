// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The sidebar's three zones (DESIGN.md § UI): header, conversation, composer. */

import { Menu } from 'obsidian';
import { type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { ApprovalCard } from './Approval';
import { FindingsCard, type FindingsUi } from './Findings';
import type { PresetLibrary } from '../../core/presets/library';
import type { Preset } from '../../core/presets/preset';
import { parseSlash } from '../../core/presets/run';
import type { PresetStarter } from '../presets';
import { Icon, IconButton } from './Icon';
import { SafeMarkdown } from './SafeMarkdown';

export interface SidebarProps {
  manager: ChatManager;
  /** The backends as they are now (Ollama, then each configured endpoint). */
  providers: () => readonly ChatProvider[];
  /** Asks the user to confirm, then clears every chat. */
  clearAllChats: () => Promise<void>;
  /** The context chips; absent if the context system is unavailable. */
  context?: ContextUi;
  /** Whether a web search provider is set up. */
  searchConfigured?: () => boolean;
  /** Reviewing proposed edits and notes. */
  review?: ReviewUi;
  /** Presets and their findings. */
  presets?: PresetsUi;
}

export interface PresetsUi {
  library: PresetLibrary;
  starter: PresetStarter;
  findings: FindingsUi;
}

/** The presets that can run, kept current with the library. */
function useRunnable(presets: PresetsUi | undefined): readonly Preset[] {
  const noop = useCallback(() => () => undefined, []);
  const zero = useCallback(() => 0, []);
  const version = useSyncExternalStore(presets?.library.subscribe ?? noop, presets?.library.version ?? zero);
  // The library changes only with its version.
  return useMemo(() => presets?.library.runnable() ?? [], [presets, version]);
}

/**
 * The model's capabilities (null while unknown). Read again for each new chat and after each message,
 * so a settings change (such as who fetches pages for Claude Code) shows in the header.
 */
function useCapabilities(providers: () => readonly ChatProvider[], model: ModelRef | null, refresh: string): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    let alive = true;
    setCaps(null);
    const provider = model ? providers().find((p) => p.id === model.provider) : undefined;
    if (provider && model) {
      provider.capabilities(model.model).then(
        (c) => alive && setCaps(c),
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
  }, [providers, model?.provider, model?.model, refresh]);
  return caps;
}

export function Sidebar({ manager, providers, clearAllChats, context, searchConfigured, review, presets }: SidebarProps) {
  const { chat, busy } = useSyncExternalStore(manager.subscribe, manager.snapshot);
  const [historyOpen, setHistoryOpen] = useState(false);
  const caps = useCapabilities(providers, chat.model, `${chat.id}:${chat.messages.length}:${chat.toolsDisabled === true}`);
  const window = caps?.contextWindow ?? null;
  const runnable = useRunnable(presets);
  const start = presets ? (p: Preset, typed = '') => presets.starter.start(p, typed) : undefined;

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
          {...(presets ? { findings: presets.findings } : {})}
          samples={start ? SAMPLES.flatMap((x) => {
            const p = runnable.find((r) => r.id === x.id);
            return p ? [{ label: x.label, icon: p.icon, run: () => void start(p) }] : [];
          }) : []}
          onRegenerate={() => manager.session.regenerate()}
          onApprove={(id, ok, items) => manager.session.answerApproval(id, ok, items)}
        />
      )}
      {context && <ContextBar ui={context} chat={chat} window={window} images={caps?.images ?? null} calibration={manager.session.calibration} />}
      {start && runnable.length > 0 && (
        <PresetRow presets={runnable} busy={busy} starter={presets!.starter} chatKey={`${chat.id}:${chat.toolsDisabled === true}:${chat.model?.model ?? ''}:${searchConfigured?.() ?? false}`} />
      )}
      <Composer
        busy={busy}
        canSend={chat.model !== null || runnable.some((p) => p.model)}
        presets={runnable}
        onSend={(text) => {
          // "/proofread focus on the intro": run that preset, with the rest as extra instructions.
          const slash = start ? parseSlash(text, runnable) : null;
          if (slash) {
            void start!(slash.preset, slash.rest);
            return true;
          }
          return manager.session.send(text);
        }}
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
  // Claude Code searches (and maybe fetches) on its own, as in its own app (DESIGN.md § Decided, before milestone 10).
  if (caps?.nativeWebSearch) {
    return caps.nativeWebFetch
      ? { label: `Tools on: Claude Code searches the web and fetches pages itself, as in its own app.${next}`, warn: false }
      : { label: `Tools on: Claude Code searches the web itself; Lektor fetches pages, asking first for ones that didn't come from a search, your messages or your notes.${next}`, warn: false };
  }
  if (caps && caps.toolCalling !== 'native' && caps.toolCalling !== 'mcp') return { label: "Tools are on, but this model can't call tools.", warn: true };
  if (!searchConfigured) return { label: `Tools on: page fetching only. Set up a search provider in Lektor's settings for web search.${next}`, warn: true };
  return { label: `Tools on: web search and page fetching.${next}`, warn: false };
}

function Header(props: {
  chat: Chat;
  manager: ChatManager;
  providers: () => readonly ChatProvider[];
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
    for (const provider of providers()) {
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

/** The empty chat's sample actions: the built-ins, if they can run. */
const SAMPLES = [
  { id: 'proofread', label: 'Proofread this note' },
  { id: 'garden-paths', label: 'Find garden-path sentences' },
  { id: 'fact-check', label: 'Fact-check this note' },
];

function Conversation(props: {
  chat: Chat;
  busy: boolean;
  session: ChatSession;
  review?: ReviewUi;
  findings?: FindingsUi;
  samples: ReadonlyArray<{ label: string; icon: string; run: () => void }>;
  onRegenerate: () => void;
  onApprove: (id: string, ok: boolean, items?: readonly string[]) => void;
}) {
  const { chat, busy, session, review, findings, onRegenerate, onApprove } = props;
  const mode = review ? displayModeOf(chat, review.defaultMode()) : 'sidebar';
  const proposalCard = (id: string) => (review ? <ProposalCard key={id} proposal={chat.proposals?.[id]} session={session} ui={review} mode={mode} /> : null);
  const findingsCard = (id: string) => (findings ? <FindingsCard key={id} set={chat.findings?.[id]} session={session} ui={findings} busy={busy} /> : null);
  const card = { proposal: proposalCard, findings: findingsCard };
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
        <p>{chat.model ? 'Ask anything, or:' : 'Choose a model above to start.'}</p>
        {chat.model && props.samples.length > 0 && (
          <div className="lektor-samples">
            {props.samples.map((x) => (
              <button key={x.label} type="button" className="lektor-sample" onClick={x.run}>
                <Icon name={x.icon} />
                <span>{x.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const last = chat.messages.length - 1;
  return (
    <div className="lektor-conversation" ref={ref} onScroll={onScroll}>
      {chat.messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={m.id} className="lektor-message lektor-user">
            {m.preset && (
              <span className="lektor-preset-badge" title={`Preset: ${m.preset.name}`}>
                <Icon name={m.preset.icon} />
                {m.preset.name}
              </span>
            )}
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
  onApprove: (id: string, ok: boolean, items?: readonly string[]) => void;
  card: Cards;
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
      {m.approval && <ApprovalCard approval={m.approval} onAnswer={onApprove} />}
      {m.content !== '' && <SafeMarkdown text={m.content} />}
      {(m.fencedProposals ?? []).map(card.proposal)}
      {(m.fencedFindings ?? []).map(card.findings)}
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

/** Cards that appear where the model made them: proposals and findings, by id. */
interface Cards {
  proposal: (id: string) => ReactNode;
  findings: (id: string) => ReactNode;
}

/** One tool round: what the model said, then one line for its calls (expandable). */
function ToolRoundView({ round, card }: { round: ToolRound; card: Cards }) {
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
  const reports = round.calls.filter((c) => c.name === 'report_findings');
  for (const c of reports) {
    if (c.result?.ok) parts.push(`Reported ${c.result.summary}`);
    else if (c.result) parts.push('Findings could not be placed');
  }
  // What Claude Code ran itself: said plainly, so it's clear Lektor didn't vet it.
  const ccSearches = round.calls.filter((c) => c.name === 'cc_web_search');
  const ccFetches = round.calls.filter((c) => c.name === 'cc_web_fetch');
  const ccOther = round.calls.filter((c) => c.name.startsWith('cc_') && c.name !== 'cc_web_search' && c.name !== 'cc_web_fetch');
  if (ccSearches.length > 0) parts.push(`Claude Code searched: ${ccSearches.length} ${ccSearches.length === 1 ? 'query' : 'queries'}`);
  if (ccFetches.length > 0) parts.push(`Claude Code fetched ${ccFetches.length} ${ccFetches.length === 1 ? 'page' : 'pages'}`);
  if (ccOther.length > 0) parts.push(`Claude Code tried ${ccOther.length} other ${ccOther.length === 1 ? 'tool' : 'tools'}`);
  const requests = round.calls.filter((c) => c.name === 'request_context');
  for (const c of requests) {
    if (c.result?.ok) parts.push(`Asked for context: ${c.result.summary}`);
    else if (c.result) parts.push('A context request failed');
  }
  const others = round.calls.length - searches.length - fetches.length - proposals.length - requests.length - reports.length - ccSearches.length - ccFetches.length - ccOther.length;
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
      {round.calls.flatMap((c) => (c.result?.proposalId ? [card.proposal(c.result.proposalId)] : []))}
      {round.calls.flatMap((c) => (c.result?.findingsId ? [card.findings(c.result.findingsId)] : []))}
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
// Presets

/** The preset buttons above the text box: icon and name (icon only when the sidebar is narrow). */
function PresetRow(props: { presets: readonly Preset[]; busy: boolean; starter: PresetStarter; chatKey: string }) {
  const { presets, busy, starter, chatKey } = props;
  // Presets that need web search when none is available are marked, and ask before they run.
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    void Promise.all(presets.map(async (p) => [p.id, await starter.searchProblem(p)] as const)).then((list) => {
      if (alive) setProblems(new Map(list.filter((x): x is readonly [string, string] => x[1] !== null)));
    });
    return () => {
      alive = false;
    };
  }, [presets, starter, chatKey]);
  return (
    <div className="lektor-preset-row">
      {presets.map((p) => {
        const problem = problems.get(p.id);
        return (
          <button
            key={p.id}
            type="button"
            className={`lektor-preset clickable-icon${problem ? ' is-warn' : ''}`}
            aria-label={`${p.name} (/${p.id})${problem ? `. ${problem}` : ''}`}
            data-tooltip-position="top"
            disabled={busy}
            onClick={() => void starter.start(p)}
          >
            <Icon name={p.icon} />
            <span className="lektor-preset-name">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer

function Composer(props: {
  busy: boolean;
  canSend: boolean;
  /** For "/" commands: the presets that can run. */
  presets: readonly Preset[];
  onSend: (text: string) => boolean;
  onStop: () => void;
  /** Typing "@" at the start of a word: open the note picker; `picked` removes the "@". */
  onMention?: (picked: () => void) => void;
}) {
  const { busy, canSend, presets, onSend, onStop, onMention } = props;
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // "/" at the start: offer the presets whose command starts with what was typed.
  const slash = /^\/([a-z0-9_-]*)$/.exec(text);
  const suggestions = slash ? presets.filter((p) => p.id.startsWith(slash[1]!)) : [];
  const complete = (p: Preset) => {
    setText(`/${p.id} `);
    input.current?.focus();
  };
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
    if (e.key === 'Tab' && suggestions.length > 0) {
      e.preventDefault();
      complete(suggestions[0]!);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy) submit();
    }
  };
  return (
    <div className="lektor-composer">
      {suggestions.length > 0 && (
        <div className="lektor-slash" role="listbox" aria-label="Presets">
          {suggestions.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={false} className="lektor-slash-item" onClick={() => complete(p)}>
              <Icon name={p.icon} />
              <span className="lektor-slash-command">/{p.id}</span>
              <span className="lektor-slash-name">{p.name}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        className="lektor-input"
        value={text}
        rows={3}
        placeholder={canSend ? (presets.length > 0 ? 'Message, or / for a preset (Enter to send)' : 'Message (Enter to send, Shift+Enter for a new line)') : 'Choose a model first'}
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
