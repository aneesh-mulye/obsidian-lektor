// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One chat: the transcript, the reply being streamed, stop and regenerate
 * (INVARIANTS.md C1–C5). The model sees exactly the visible transcript; there
 * is never more than one live stream; a stopped reply is final.
 */

import type { ModelAccepts } from '../context/attachments';
import { type ContextManifest, type PreparedContext, recordSent, sha256 } from '../context/prepare';
import type { ContextState } from '../context/state';
import { MESSAGE_OVERHEAD, estimateTokens, fits, formatTokens } from '../context/tokens';
import type { ChatMessage, ChatProvider, ChatRequest, ModelRef, ToolCall } from '../providers/types';
import type { Proposal } from '../review/types';
import type { DisplayMode } from '../settings';
import type { ApprovalItem, ApprovalRequest, Shared, Transient } from '../tools/types';
import type { FindingSet } from '../findings/findings';
import type { Preset } from '../presets/preset';
import { type Delivery, presetInstructions } from '../presets/run';
import { imagesMessage, messagesTokens, roundMessages, titleFrom, toRequestMessages } from './transcript';
import type { AssistantMessage, Chat, Clock, Message, ProviderLookup, ToolRun, ToolsDeps } from './types';

/** The tool loop's limit: at most this many requests per reply; the last offers no tools (INVARIANTS.md C7). */
export const MAX_TOOL_ROUNDS = 8;

export interface SessionDeps {
  providers: ProviderLookup;
  clock: Clock;
  newId: () => string;
  /** Persist the chat. Called after every user action and when a reply ends. */
  save: (chat: Chat) => Promise<void>;
  onSaveError?: (err: unknown) => void;
  /** Build the context message for the chat's chips (INVARIANTS.md X2, A1). Failure means nothing is sent. */
  prepare?: (state: ContextState, accepts: ModelAccepts) => Promise<PreparedContext>;
  /** Turn what the user shared through request_context into chips (INVARIANTS.md A3). */
  share?: (state: ContextState, shared: Shared) => ContextState;
  /** Whether to keep the context text sent with each reply ("store full transcripts"). */
  storeFullTranscripts?: () => boolean;
  /** Tools for each reply (DESIGN.md § Tools framework). */
  tools?: ToolsDeps;
}

/** Calibration is the ratio of real to estimated prompt tokens, kept between 1 and 4. */
const clampCalibration = (r: number) => Math.min(4, Math.max(1, r));

export class ChatSession {
  #chat: Chat;
  /** Bumped whenever the live stream is abandoned; events from older runs are ignored. */
  #run = 0;
  #busy = false;
  #controller: AbortController | null = null;
  #saving: Promise<void> = Promise.resolve();
  /** Real ÷ estimated prompt tokens from the last finished reply (INVARIANTS.md C6). */
  #calibration = 1;
  #approval: { id: string; resolve: (answer: boolean | readonly string[]) => void } | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    chat: Chat,
    private readonly deps: SessionDeps,
  ) {
    this.#chat = chat;
  }

  get chat(): Chat {
    return this.#chat;
  }

  get busy(): boolean {
    return this.#busy;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Send a user message, or run a preset (with anything typed after its slash command). Returns
   * false (and does nothing) while busy, or for blank text without a preset.
   */
  send(text: string, preset?: Preset): boolean {
    if (this.#busy || (!preset && text.trim() === '')) return false;
    const content = preset ? text.trim() : text;
    const user: Message = { id: this.deps.newId(), role: 'user', content, createdAt: this.deps.clock.now(), ...(preset ? { preset } : {}) };
    if (this.#chat.messages.length === 0) this.#set({ ...this.#chat, title: titleFrom(preset ? `${preset.name}${content ? `: ${content}` : ''}` : text) });
    // A preset may ask for a display mode; the chat switches to it (the header shows it, and the user can switch back).
    if (preset?.display && preset.display !== this.#chat.displayMode) this.#set({ ...this.#chat, displayMode: preset.display });
    this.#start([...this.#chat.messages, user]);
    return true;
  }

  /** Dismiss a finding (a click on its ✕). Never writes to the vault. */
  dismissFinding(setId: string, findingId: string): void {
    const set = this.#chat.findings?.[setId];
    if (!set) return;
    const next: FindingSet = { ...set, findings: set.findings.map((f) => (f.id === findingId ? { ...f, status: 'dismissed' } : f)) };
    this.#set({ ...this.#chat, findings: { ...this.#chat.findings, [setId]: next } });
    this.#emit();
    this.#persist();
  }

  /** Replace the last reply with a new one. Returns false while busy or if the last message is not a reply. */
  regenerate(): boolean {
    if (this.#busy || this.#chat.messages.at(-1)?.role !== 'assistant') return false;
    this.#start(this.#chat.messages.slice(0, -1));
    return true;
  }

  /** Stop the live reply. It keeps what it has so far and never changes again. */
  stop(): void {
    if (!this.#busy) return;
    this.#run += 1;
    this.#controller?.abort();
    this.#controller = null;
    // A waiting approval is declined.
    const pending = this.#approval;
    this.#approval = null;
    pending?.resolve(false);
    this.#updateReply((r) => {
      const { approval: _a, ...rest } = r;
      return r.status === 'streaming' ? { ...rest, status: 'stopped' } : rest;
    });
    this.#busy = false;
    this.#emit();
    this.#persist();
  }

  /** Replace the chat's context (the chips). */
  setContext(context: ContextState): void {
    if (context === this.#chat.context) return;
    this.#set({ ...this.#chat, context });
    this.#emit();
    if (this.#chat.messages.length > 0) this.#persist();
  }

  get calibration(): number {
    return this.#calibration;
  }

  /** Use another model from the next message on. */
  setModel(model: ModelRef): void {
    this.#set({ ...this.#chat, model });
    this.#emit();
    if (this.#chat.messages.length > 0) this.#persist();
  }

  // -------------------------------------------------------------------------

  #start(history: readonly Message[]): void {
    // A preset's own model answers its run; the chat's model is unchanged (INVARIANTS.md PR2).
    const last = history.at(-1);
    const model = (last?.role === 'user' ? last.preset?.model : undefined) ?? this.#chat.model;
    const reply: AssistantMessage = {
      id: this.deps.newId(),
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
      model: model ?? { provider: 'none', model: 'none' },
      createdAt: this.deps.clock.now(),
    };
    this.#set({ ...this.#chat, messages: [...history, reply] });
    this.#busy = true;
    const run = ++this.#run;
    const controller = new AbortController();
    this.#controller = controller;
    this.#emit();
    this.#persist();
    void this.#pump(run, model, history, controller.signal);
  }

  async #pump(run: number, model: ModelRef | null, history: readonly Message[], signal: AbortSignal): Promise<void> {
    const live = () => run === this.#run && this.#busy;
    try {
      if (!model) throw new Error('Pick a model first.');
      const provider = this.deps.providers.get(model.provider);
      if (!provider) throw new Error(`The ${model.provider} backend is not available.`);
      // Fail closed: no stream unless the model's capabilities are known (DESIGN.md § The two hard rules).
      const caps = await provider.capabilities(model.model);
      if (!live()) return;
      const window = caps.contextWindow;
      // The context is read fresh for every message; if it can't be, nothing is sent.
      const prepared = this.deps.prepare ? await this.deps.prepare(this.#chat.context, { images: caps.images }) : null;
      if (!live()) return;

      const transcript = toRequestMessages(history);
      const head: ChatMessage[] = [
        ...(prepared?.message ? [{ role: 'system' as const, content: prepared.message }] : []),
        ...(prepared && prepared.images.length > 0 ? [imagesMessage(prepared.images)] : []),
      ];
      const base: ChatMessage[] = [...head, ...transcript];
      if (prepared && prepared.skipped.length > 0) {
        const list = prepared.skipped.map((x) => `${x.path} (${x.reason})`).join('; ');
        this.#updateReply((r) => ({ ...r, notice: `Not sent: ${list}.` }));
      }
      // Shared through request_context during this reply: sent in full until the reply ends, never saved (INVARIANTS.md A4).
      const transient = new Map<string, Transient>();
      const baseEstimate = (prepared?.tokens ?? 0) + messagesTokens(transcript, estimateTokens, MESSAGE_OVERHEAD);
      // One tool run (one budget) per user message (INVARIANTS.md T2).
      const editable = prepared ? [...new Set([...prepared.manifest.notes.map((n) => n.path), ...prepared.manifest.selections.map((x) => x.path)])] : [];
      const lastUser = history.at(-1);
      const preset = lastUser?.role === 'user' ? lastUser.preset : undefined;
      const tools =
        this.deps.tools?.forReply({ chat: this.#chat, capabilities: caps, contextUrls: prepared?.urls ?? [], editable, ...(preset ? { preset } : {}) }) ?? null;
      // A preset's prompt is sent for this reply only, in one system message (INVARIANTS.md PR2).
      if (preset) {
        const wanted = preset.output === 'findings' ? 'report_findings' : 'propose_edit';
        const delivery: Delivery = tools?.definitions.some((d) => d.name === wanted) ? 'tool' : tools?.fenced ? 'fenced' : 'none';
        base.push({ role: 'system', content: presetInstructions(preset, delivery) });
      }
      if (tools?.instructions) base.push({ role: 'system', content: tools.instructions });
      if (tools?.fenced) base.push({ role: 'system', content: tools.fenced.instructions });

      for (let round = 0; ; round++) {
        const rounds = this.#reply()?.steps ?? [];
        const extra = roundMessages(rounds, transient);
        const estimate = baseEstimate + messagesTokens(extra, estimateTokens, MESSAGE_OVERHEAD);
        // Every round must fit (INVARIANTS.md C6, C7).
        if (!fits(estimate, this.#calibration, window)) {
          this.#end('error', tooLong(Math.ceil(estimate * this.#calibration), window));
          return;
        }
        if (round === 0) await this.#recordContext(prepared, estimate);
        else this.#updateReply((r) => ({ ...r, promptEstimate: estimate }));
        if (!live()) return;

        // The last round offers no tools, so the loop always ends with an answer.
        const offered = tools !== null && tools.definitions.length > 0 && round < MAX_TOOL_ROUNDS - 1 ? tools.definitions : undefined;
        const calls = await this.#streamRound(provider, { model: model.model, messages: [...base, ...extra], ...(offered ? { tools: offered } : {}) }, signal, live, window);
        if (calls === null) {
          if (tools?.fenced && run === this.#run) await this.#extractFenced(tools.fenced);
          return;
        }
        if (!live()) return;

        // A tool round: keep what the model said with its calls, then run them in order.
        const index = rounds.length;
        this.#updateReply((r) => ({
          ...r,
          content: '',
          steps: [...rounds, { text: r.content, calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) }],
        }));
        this.#emit();
        for (let i = 0; i < calls.length; i++) {
          const { proposal, findings, transient: sent, shared, ...stored } = await tools!.execute(calls[i]!, signal, (request) => this.#askApproval(request), {
            choose: (request) => this.#askChoice(request),
            context: () => this.#chat.context,
          });
          if (!live()) return;
          if (proposal) this.#set({ ...this.#chat, proposals: { ...(this.#chat.proposals ?? {}), [proposal.id]: proposal } });
          if (findings) this.#set({ ...this.#chat, findings: { ...(this.#chat.findings ?? {}), [findings.id]: findings } });
          let result = stored;
          if (sent) {
            transient.set(calls[i]!.id, sent);
            if (this.deps.storeFullTranscripts?.()) {
              const contextHash = await sha256(sent.content);
              this.#set({ ...this.#chat, sentContext: { ...(this.#chat.sentContext ?? {}), [contextHash]: sent.content } });
              result = { ...stored, contextHash };
            }
          }
          if (shared) this.#share(shared);
          this.#updateReply((r) => ({
            ...r,
            steps: r.steps!.map((st, k) => (k !== index ? st : { ...st, calls: st.calls.map((c, j) => (j === i ? { ...c, result } : c)) })),
          }));
          this.#emit();
        }
        this.#persist();
      }
    } catch (err) {
      if (live()) this.#end('error', err instanceof Error && err.message ? err.message : 'The reply failed.');
    }
  }

  /**
   * Stream one request. Returns the tool calls if the round ended in some (and tools were offered);
   * otherwise ends the reply and returns null.
   */
  async #streamRound(provider: ChatProvider, req: ChatRequest, signal: AbortSignal, live: () => boolean, window: number): Promise<ToolCall[] | null> {
    const iterator = provider.stream(req, signal)[Symbol.asyncIterator]();
    const calls: ToolCall[] = [];
    let pendingError: string | undefined;
    try {
      for (;;) {
        const step = await iterator.next();
        if (!live()) return null;
        if (step.done) {
          this.#end('error', pendingError ?? 'The reply ended before it finished.');
          return null;
        }
        const event = step.value;
        switch (event.type) {
          case 'text':
            this.#updateReply((r) => ({ ...r, content: r.content + event.text }));
            break;
          case 'reasoning':
            this.#updateReply((r) => ({ ...r, reasoning: r.reasoning + event.text }));
            break;
          case 'tool_call':
            if (req.tools) calls.push(event.call); // never act on a call to tools that were not offered
            break;
          case 'usage':
            this.#updateReply((r) => ({
              ...r,
              usage: {
                ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
                ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              },
            }));
            break;
          case 'error':
            pendingError = event.message;
            break;
          case 'done':
            if ((event.reason === 'stop' || event.reason === 'length') && calls.length > 0) return calls;
            if (event.reason === 'stop' || event.reason === 'length') this.#calibrate(window);
            if (event.reason === 'stop') this.#end('complete');
            else if (event.reason === 'length') this.#end('truncated');
            else if (event.reason === 'aborted') this.#end('stopped');
            else this.#end('error', pendingError ?? 'The reply failed.');
            return null;
        }
        this.#emit();
      }
    } finally {
      // The stream is finished or abandoned; let it clean up, but never wait on it.
      try {
        void iterator.return?.();
      } catch {
        // ignore
      }
    }
  }

  /** A finished reply from a model without tool calling: turn its fenced blocks into proposals or findings. */
  async #extractFenced(fenced: NonNullable<ToolRun['fenced']>): Promise<void> {
    const reply = this.#reply();
    if (reply?.status !== 'complete') return;
    const { proposals, findings = [], problems } = await fenced.extract(reply.content);
    if (proposals.length === 0 && findings.length === 0 && problems.length === 0) return;
    this.#set({
      ...this.#chat,
      proposals: { ...(this.#chat.proposals ?? {}), ...Object.fromEntries(proposals.map((p) => [p.id, p])) },
      ...(findings.length > 0 ? { findings: { ...(this.#chat.findings ?? {}), ...Object.fromEntries(findings.map((f) => [f.id, f])) } } : {}),
    });
    this.#updateReply((r) => ({
      ...r,
      ...(proposals.length > 0 ? { fencedProposals: proposals.map((p) => p.id) } : {}),
      ...(findings.length > 0 ? { fencedFindings: findings.map((f) => f.id) } : {}),
      ...(problems.length > 0 ? { notice: `Some ${findings.length > 0 || /finding/i.test(problems.join(' ')) ? 'findings' : 'proposed edits'} could not be used: ${problems.join(' ')}` } : {}),
    }));
    this.#emit();
    this.#persist();
  }

  /** Change a proposal's state (the review manager, on a user's click). */
  updateProposal(id: string, fn: (p: Proposal) => Proposal): void {
    const current = this.#chat.proposals?.[id];
    if (!current) return;
    this.#set({ ...this.#chat, proposals: { ...this.#chat.proposals, [id]: fn(current) } });
    this.#emit();
    this.#persist();
  }

  /** Show an approval card on the reply and wait for the user (or Stop, which declines). */
  #askApproval(request: ApprovalRequest): Promise<boolean> {
    return this.#ask(request).then((answer) => answer === true);
  }

  /** Show a card with a checkbox per item and wait; resolves to the ticked ids that were offered ([] for Deny or Stop). */
  #askChoice(request: ApprovalRequest & { items: readonly ApprovalItem[] }): Promise<readonly string[]> {
    const offered = new Set(request.items.filter((i) => i.unavailable === undefined).map((i) => i.id));
    return this.#ask(request).then((answer) => (typeof answer === 'boolean' ? [] : answer.filter((id) => offered.has(id))));
  }

  #ask(request: ApprovalRequest): Promise<boolean | readonly string[]> {
    return new Promise((resolve) => {
      const id = this.deps.newId();
      this.#approval?.resolve(false);
      this.#approval = { id, resolve };
      this.#updateReply((r) => ({ ...r, approval: { id, ...request } }));
      this.#emit();
    });
  }

  /**
   * The user answered an approval card: yes or no, or for a card with items, the ids they ticked
   * (an empty list is a denial).
   */
  answerApproval(id: string, approved: boolean, items?: readonly string[]): void {
    const pending = this.#approval;
    if (pending?.id !== id) return;
    this.#approval = null;
    this.#updateReply((r) => {
      const { approval: _a, ...rest } = r;
      return rest;
    });
    this.#emit();
    pending.resolve(approved ? (items ?? true) : false);
  }

  /** What the user shared becomes chips, and part of this reply's manifest (so deleting it later finds this chat). */
  #share(shared: Shared): void {
    if (this.deps.share) this.#set({ ...this.#chat, context: this.deps.share(this.#chat.context, shared) });
    this.#updateReply((r) => {
      const base: ContextManifest = r.context ?? { notes: [], selections: [], attachments: [], backlinkLists: 0, excluded: 0 };
      const add = <T extends { path: string }>(list: readonly T[], more: readonly T[]) => [...list, ...more.filter((m) => !list.some((x) => x.path === m.path))];
      return { ...r, context: { ...base, notes: add(base.notes, shared.manifest.notes), attachments: add(base.attachments ?? [], shared.manifest.attachments) } };
    });
  }

  /** Show this chat's proposals as prose, sidebar diffs or inline marks (the header toggle). */
  setDisplayMode(mode: DisplayMode): void {
    if (this.#chat.displayMode === mode) return;
    this.#set({ ...this.#chat, displayMode: mode });
    this.#emit();
    if (this.#chat.messages.length > 0) this.#persist();
  }

  /** Turn the tools (the globe) on or off for this chat. */
  setTools(on: boolean): void {
    const { toolsDisabled: _t, ...rest } = this.#chat;
    this.#set(on ? rest : { ...rest, toolsDisabled: true });
    this.#emit();
    if (this.#chat.messages.length > 0) this.#persist();
  }

  #reply(): AssistantMessage | undefined {
    const last = this.#chat.messages.at(-1);
    return last?.role === 'assistant' ? last : undefined;
  }

  /** Note on the reply what it was sent with; with full transcripts on, keep the text too. */
  async #recordContext(prepared: PreparedContext | null, estimate: number): Promise<void> {
    let contextHash: string | undefined;
    if (prepared?.message && this.deps.storeFullTranscripts?.()) {
      contextHash = await sha256(prepared.message);
      this.#set({ ...this.#chat, sentContext: { ...(this.#chat.sentContext ?? {}), [contextHash]: prepared.message } });
    }
    const manifest: ContextManifest | undefined = prepared?.manifest;
    this.#updateReply((r) => ({
      ...r,
      promptEstimate: estimate,
      ...(manifest ? { context: manifest } : {}),
      ...(contextHash ? { contextHash } : {}),
    }));
    if (manifest) this.#set({ ...this.#chat, context: recordSent(this.#chat.context, manifest) });
    this.#emit();
  }

  /** Learn from the real prompt size the backend reported; warn if the context was full. */
  #calibrate(window: number): void {
    const reply = this.#chat.messages.at(-1);
    if (reply?.role !== 'assistant') return;
    const input = reply.usage?.inputTokens;
    if (input === undefined || !reply.promptEstimate) return;
    this.#calibration = clampCalibration(input / reply.promptEstimate);
    if (input + (reply.usage?.outputTokens ?? 0) >= window * 0.98) {
      this.#updateReply((r) => ({ ...r, notice: 'This filled the model’s context length, so the model may not have seen all of the conversation.' }));
    }
  }

  #end(status: AssistantMessage['status'], error?: string): void {
    this.#updateReply((r) => ({ ...r, status, ...(error !== undefined ? { error } : {}) }));
    this.#busy = false;
    this.#controller = null;
    this.#emit();
    this.#persist();
  }

  #updateReply(fn: (r: AssistantMessage) => AssistantMessage): void {
    const messages = this.#chat.messages;
    const last = messages.at(-1);
    if (last?.role !== 'assistant') return;
    this.#set({ ...this.#chat, messages: [...messages.slice(0, -1), fn(last)] });
  }

  #set(chat: Chat): void {
    this.#chat = { ...chat, updatedAt: this.deps.clock.now() };
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }

  #persist(): void {
    if (this.#chat.messages.length === 0) return;
    const snapshot = this.#chat;
    this.#saving = this.#saving
      .then(() => this.deps.save(snapshot))
      .catch((err: unknown) => this.deps.onSaveError?.(err));
  }
}

function tooLong(tokens: number, window: number): string {
  return (
    `This message and its context come to about ${formatTokens(tokens)} tokens, which, with room for the reply, ` +
    `doesn't fit the model's context length of ${formatTokens(window)}. Remove some context, start a new chat, ` +
    'or raise the context length in Lektor’s settings.'
  );
}
