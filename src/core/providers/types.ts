// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The backend interface every chat provider implements (DESIGN.md § Backends). */

export interface Capabilities {
  toolCalling: 'native' | 'mcp' | 'fenced' | 'none';
  /** The backend searches the web itself (Claude Code); Lektor then offers no web_search. */
  nativeWebSearch: boolean;
  /** The backend fetches pages itself; Lektor then offers no fetch_page. */
  nativeWebFetch?: boolean;
  images: boolean;
  contextWindow: number;
}

export interface ModelInfo {
  /** The provider's own model id, e.g. `qwen3.8:27b`. */
  id: string;
  /** What the picker shows. */
  name: string;
  contextWindow?: number;
}

/** A tool the model may call, in the shape every native tool API uses. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** As the model sent it; validated by the tool registry before anything runs. */
  arguments: unknown;
}

/** An image sent with a message, for models with vision. */
export interface ChatImage {
  mime: string;
  /** Base64 of the file's bytes. */
  data: string;
  /** Lektor's estimate (INVARIANTS.md C6). */
  tokens: number;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: readonly ChatImage[] }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /**
       * Provider data to send back unchanged with this turn, within the reply that produced it
       * (Claude's signed thinking blocks before a tool call). Never stored.
       */
      replay?: unknown;
    }
  | { role: 'tool'; content: string; toolName: string; toolCallId: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Tools offered for this request; absent or empty means none. */
  tools?: ToolDefinition[];
  /**
   * For backends that call Lektor's tools themselves over MCP (toolCalling 'mcp'): the tools for this
   * reply, run through the same registry, approvals and caps as native calls (INVARIANTS.md L6).
   */
  toolHost?: ToolHost;
  /** For backends with their own web tools: whether they may search and fetch for this reply (the globe, a preset's tools). */
  web?: { search: boolean; pages: boolean };
}

/** Lektor's tools for one reply, as an MCP backend calls them. Calls run one at a time. */
export interface ToolHost {
  definitions: ToolDefinition[];
  call(name: string, args: unknown): Promise<ToolHostResult>;
}

export interface ToolHostResult {
  content: string;
  isError: boolean;
  /** Images shared with the result (request_context), base64. */
  images?: readonly ChatImage[];
}

export type DoneReason = 'stop' | 'length' | 'aborted' | 'error';

/**
 * A stream is zero or more text / reasoning / usage / error events followed by
 * exactly one `done`, and nothing after it (INVARIANTS.md O1). Tool events
 * arrive with the tools milestone.
 */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  /** Data the provider needs back with this turn if the reply continues (see ChatMessage.replay). */
  | { type: 'replay'; data: unknown }
  /** Something the user should know about this reply (e.g. it could not be streamed). */
  | { type: 'notice'; message: string }
  /** A tool the backend ran itself (Claude Code's own WebSearch), shown in the reply's steps. */
  | { type: 'tool_activity'; call: ToolCall; result: { ok: boolean; content: string; summary: string; urls?: string[] } }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: DoneReason };

export interface ChatProvider {
  /** "ollama", "claude-code", "openai-compat:<name>". */
  readonly id: string;
  /** Shown in the model picker. */
  readonly label: string;
  /** Rejects if they cannot be determined; sessions then refuse to start (fail closed). */
  capabilities(model: string): Promise<Capabilities>;
  listModels(): Promise<ModelInfo[]>;
  /** Never throws: failures become `error` + `done: error` events. */
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export interface ModelRef {
  provider: string;
  model: string;
}
