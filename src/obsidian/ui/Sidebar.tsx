// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The sidebar's three zones (DESIGN.md § UI): header, conversation, composer. */

import { Menu } from 'obsidian';
import { type ChangeEvent, type KeyboardEvent, type MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatSummary } from '../../core/chat/history';
import type { ChatManager } from '../../core/chat/manager';
import type { AssistantMessage, Chat } from '../../core/chat/types';
import type { ChatProvider } from '../../core/providers/types';
import type { ModelRef } from '../../core/providers/types';
import { ContextBar, type ContextUi } from './ContextBar';
import { Icon, IconButton } from './Icon';
import { SafeMarkdown } from './SafeMarkdown';

export interface SidebarProps {
  manager: ChatManager;
  providers: readonly ChatProvider[];
  /** Asks the user to confirm, then clears every chat. */
  clearAllChats: () => Promise<void>;
  /** The context chips; absent if the context system is unavailable. */
  context?: ContextUi;
}

/** The model's context window, from its capabilities (null while unknown). */
function useWindow(providers: readonly ChatProvider[], model: ModelRef | null): number | null {
  const [window, setWindow] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setWindow(null);
    const provider = model ? providers.find((p) => p.id === model.provider) : undefined;
    if (provider && model) {
      provider.capabilities(model.model).then(
        (c) => alive && setWindow(c.contextWindow),
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
  }, [providers, model?.provider, model?.model]);
  return window;
}

export function Sidebar({ manager, providers, clearAllChats, context }: SidebarProps) {
  const { chat, busy } = useSyncExternalStore(manager.subscribe, manager.snapshot);
  const [historyOpen, setHistoryOpen] = useState(false);
  const window = useWindow(providers, chat.model);

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
        historyOpen={historyOpen}
        onNewChat={() => {
          manager.newChat();
          setHistoryOpen(false);
        }}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
      />
      {historyOpen ? (
        <HistoryPanel manager={manager} currentId={chat.id} onOpened={() => setHistoryOpen(false)} clearAllChats={clearAllChats} />
      ) : (
        <Conversation chat={chat} busy={busy} onRegenerate={() => manager.session.regenerate()} />
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

function Header(props: {
  chat: Chat;
  manager: ChatManager;
  providers: readonly ChatProvider[];
  historyOpen: boolean;
  onNewChat: () => void;
  onToggleHistory: () => void;
}) {
  const { chat, manager, providers } = props;
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
        <IconButton icon="square-pen" label="New chat" onClick={props.onNewChat} />
        <IconButton icon="history" label="Chat history" active={props.historyOpen} onClick={props.onToggleHistory} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation

function Conversation({ chat, busy, onRegenerate }: { chat: Chat; busy: boolean; onRegenerate: () => void }) {
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
          <Reply key={m.id} message={m} canRegenerate={i === last && !busy} onRegenerate={onRegenerate} />
        ),
      )}
    </div>
  );
}

function Reply({ message: m, canRegenerate, onRegenerate }: { message: AssistantMessage; canRegenerate: boolean; onRegenerate: () => void }) {
  const streaming = m.status === 'streaming';
  return (
    <div className="lektor-message lektor-assistant">
      {m.reasoning !== '' && (
        <details className="lektor-reasoning">
          <summary>{streaming && m.content === '' ? 'Thinking…' : 'Thinking'}</summary>
          <div className="lektor-reasoning-text">{m.reasoning}</div>
        </details>
      )}
      {m.content !== '' && <SafeMarkdown text={m.content} />}
      {streaming && m.content === '' && m.reasoning === '' && <div className="lektor-pending" aria-label="Waiting for the model">…</div>}
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
