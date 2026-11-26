// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Claude Code's command line (DESIGN.md § Claude Code lockdown; INVARIANTS.md
 * L1). Every lockdown flag is added unconditionally; nothing a chat, preset or
 * setting chooses can remove one or add a file or shell tool. The model alias
 * is checked, and nothing private ever goes in argv (which other local users
 * can read): the MCP config and the system prompt are files in the run folder,
 * and the conversation goes in on stdin.
 *
 * Verified against Claude Code 2.1.332 on 2026-11-27 (DESIGN.md § Decided,
 * before milestone 10). `--safe-mode` is deliberately absent: it also drops
 * `--mcp-config` servers.
 */

/** Lektor's tools Claude Code may be offered over MCP. Never a file or shell tool. */
export const LEKTOR_MCP_TOOLS = ['request_context', 'propose_edit', 'propose_note', 'report_findings', 'fetch_page'] as const;
/** Claude Code's own tools it may have: the web tools, nothing else. */
export const CLAUDE_WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;
export const MCP_SERVER_NAME = 'lektor';

export class CliError extends Error {
  override name = 'CliError';
}

export interface ClaudeArgsInput {
  /** An alias (fable, opus, sonnet, haiku) or a full model name. */
  model: string;
  /** Claude Code's own web tools for this run: search, and page fetching (off when Lektor fetches pages). */
  web: { search: boolean; pages: boolean };
  /** Lektor tools offered over MCP for this reply. */
  lektorTools: readonly string[];
  /** Absolute paths of files in the run folder. */
  mcpConfigPath: string;
  systemPromptPath: string;
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

function absolute(path: string, what: string): string {
  if (!path.startsWith('/') || path.includes('\0') || /[\r\n]/.test(path)) throw new CliError(`The ${what} path is not usable.`);
  return path;
}

/** The arguments after `claude`. Throws CliError for anything that can't be run safely. */
export function claudeArgs(input: ClaudeArgsInput): string[] {
  if (!MODEL.test(input.model)) throw new CliError(`"${input.model.slice(0, 40)}" is not a Claude model name Lektor can pass on.`);
  const lektor = [...new Set(input.lektorTools)];
  for (const t of lektor) if (!(LEKTOR_MCP_TOOLS as readonly string[]).includes(t)) throw new CliError(`Lektor can't offer "${t}" to Claude Code.`);
  const web = [...(input.web.search ? ['WebSearch'] : []), ...(input.web.pages ? ['WebFetch'] : [])];
  const allowed = [...web, ...lektor.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`)];
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    // No user, project or local settings, hooks or plugins (instead of --safe-mode, which drops MCP servers).
    '--setting-sources',
    '',
    '--restricted',
    // Only Lektor's MCP server.
    '--strict-mcp-config',
    '--mcp-config',
    absolute(input.mcpConfigPath, 'MCP config'),
    // Anything not allowed below is denied, never prompted.
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--disable-slash-commands',
    // The only built-in tools that exist: the web tools (or none).
    '--tools',
    web.join(','),
    ...(allowed.length > 0 ? ['--allowedTools', ...allowed] : []),
    '--system-prompt-file',
    absolute(input.systemPromptPath, 'system prompt'),
    '--model',
    input.model,
  ];
}

/** The MCP config file's contents: Lektor's loopback server, with the run's token. */
export function mcpConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
}
