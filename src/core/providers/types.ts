// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The backend interface every chat provider implements (DESIGN.md § Backends). */

export interface Capabilities {
  toolCalling: 'native' | 'mcp' | 'fenced' | 'none';
  nativeWebSearch: boolean;
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
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
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
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
