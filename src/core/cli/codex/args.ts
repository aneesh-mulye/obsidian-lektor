// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The locked-down `codex exec` command line (DESIGN.md § Backends, Codex
 * lockdown; INVARIANTS.md C1), as verified against Codex 0.162.1. The fixed
 * part never changes with settings; what varies is the model, whether Codex
 * may search the web, the run's files, Lektor's MCP server and the feature
 * list, in which everything but the vetted few is disabled.
 */

import { CliError, MCP_SERVER_NAME } from '../claude/args';

export { CliError };

/** The features left on: without code_mode_host no tool can be called at all; the other two are transport only. */
export const CODEX_VETTED_FEATURES = ['code_mode_host', 'enable_request_compression', 'system_proxy_fallback'] as const;
/** Lektor's tools Codex may get over MCP (web_search and fetch_page only when Lektor does web work). */
export const CODEX_MCP_TOOLS = ['request_context', 'propose_edit', 'propose_note', 'report_findings', 'web_search', 'fetch_page'] as const;
/** The environment variable that carries the run's token, for the MCP server (and the scripted model). */
export const TOKEN_ENV = 'LEKTOR_MCP_TOKEN';
/** The provider name of the inventory check's scripted model. */
export const CHECK_PROVIDER = 'lektor_check';

export interface CodexFeature {
  name: string;
  stage: string;
  on: boolean;
}

const FEATURE_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/** `codex features list` output: "name  stage  true|false" per line (the stage may have spaces). Fails closed on anything else. */
export function parseFeatures(text: string): CodexFeature[] {
  const out: CodexFeature[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0]!;
    const value = parts.at(-1);
    if (parts.length < 3 || !FEATURE_NAME.test(name) || (value !== 'true' && value !== 'false')) throw new CliError(`Codex listed a feature Lektor can’t read ("${line.trim().slice(0, 80)}").`);
    out.push({ name, stage: parts.slice(1, -1).join(' '), on: value === 'true' });
  }
  if (out.length === 0) throw new CliError('Codex listed no features.');
  return out;
}

/** Every feature to disable: all but the removed ones, the vetted few, and deprecated ones already off. */
export function disabledFeatures(features: readonly CodexFeature[]): string[] {
  if (features.length === 0) throw new CliError('Codex listed no features.');
  return features
    .filter((f) => {
      if (!FEATURE_NAME.test(f.name)) throw new CliError(`"${f.name.slice(0, 60)}" is not a feature name.`);
      return f.stage !== 'removed' && !(CODEX_VETTED_FEATURES as readonly string[]).includes(f.name) && !(f.stage === 'deprecated' && !f.on);
    })
    .map((f) => f.name);
}

/** Every `-c` key Lektor ever sets (INVARIANTS.md C1). */
export const CODEX_CONFIG_KEYS = [
  'approval_policy',
  'web_search',
  'project_doc_max_bytes',
  'skills.include_instructions',
  'skills.bundled.enabled',
  'agents.enabled',
  'apps._default.enabled',
  'plugins._default.enabled',
  'personality',
  'history.persistence',
  'sqlite_home',
  'log_dir',
  'model_instructions_file',
  'model_catalog_json',
  'model_reasoning_summary',
  'model_reasoning_effort',
  `mcp_servers.${MCP_SERVER_NAME}.url`,
  `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var`,
  `mcp_servers.${MCP_SERVER_NAME}.required`,
  `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode`,
  `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec`,
  'model_provider',
  `model_providers.${CHECK_PROVIDER}`,
] as const;

export interface CodexArgsInput {
  /** A Codex model slug from its catalog. */
  model: string;
  features: readonly CodexFeature[];
  /** Codex's own live web search for this run (the globe on, and Codex doing web work). */
  web: boolean;
  /** The empty working folder. */
  workdir: string;
  /** The run's files: instructions, model catalog, and Codex's own state and log folders. */
  files: { instructions: string; catalog: string; state: string; log: string };
  /** Lektor's MCP server for this run. */
  mcpUrl: string;
  /** Context images, as files in the run folder. */
  images?: readonly string[];
  /** The inventory check: Codex's model is the scripted one at this base URL (no request leaves the machine). */
  check?: { modelUrl: string };
  /** Lower reasoning effort (the real check only). */
  effort?: 'low';
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const PATH = /^\/[^"\\\u0000-\u001f]{1,1000}$/;
const MCP_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/;
const MODEL_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/;

const path = (p: string): string => {
  if (!PATH.test(p)) throw new CliError('A run file’s path can’t be passed to Codex.');
  return p;
};

/** The full argument list for one run (INVARIANTS.md C1). Throws CliError rather than build anything unsafe. */
export function codexArgs(input: CodexArgsInput): string[] {
  if (!MODEL.test(input.model)) throw new CliError(`"${input.model.slice(0, 60)}" is not a Codex model name.`);
  if (!MCP_URL.test(input.mcpUrl)) throw new CliError('Lektor’s MCP server must be on 127.0.0.1.');
  if (input.check && !MODEL_URL.test(input.check.modelUrl)) throw new CliError('The check model must be on 127.0.0.1.');
  const disable = disabledFeatures(input.features);
  const c = (key: (typeof CODEX_CONFIG_KEYS)[number], value: string) => ['-c', `${key}=${value}`];
  const s = MCP_SERVER_NAME;
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    // One value each, so a list of images can never swallow the flags after it.
    ...(input.images ?? []).map((i) => `--image=${path(i)}`),
    '-C',
    path(input.workdir),
    '--sandbox',
    'read-only',
    '-m',
    input.model,
    ...c('approval_policy', '"never"'),
    ...c('web_search', input.web && !input.check ? '"live"' : '"disabled"'),
    ...c('project_doc_max_bytes', '0'),
    ...c('skills.include_instructions', 'false'),
    ...c('skills.bundled.enabled', 'false'),
    ...c('agents.enabled', 'false'),
    ...c('apps._default.enabled', 'false'),
    ...c('plugins._default.enabled', 'false'),
    ...c('personality', '"none"'),
    ...c('history.persistence', '"none"'),
    ...c('sqlite_home', `"${path(input.files.state)}"`),
    ...c('log_dir', `"${path(input.files.log)}"`),
    ...c('model_instructions_file', `"${path(input.files.instructions)}"`),
    ...c('model_catalog_json', `"${path(input.files.catalog)}"`),
    ...c('model_reasoning_summary', '"auto"'),
    ...(input.effort ? c('model_reasoning_effort', `"${input.effort}"`) : []),
    ...c(`mcp_servers.${s}.url`, `"${input.mcpUrl}"`),
    ...c(`mcp_servers.${s}.bearer_token_env_var`, `"${TOKEN_ENV}"`),
    ...c(`mcp_servers.${s}.required`, 'true'),
    ...c(`mcp_servers.${s}.default_tools_approval_mode`, '"approve"'),
    ...c(`mcp_servers.${s}.tool_timeout_sec`, '3600'),
    ...(input.check
      ? [
          ...c('model_provider', `"${CHECK_PROVIDER}"`),
          ...c(`model_providers.${CHECK_PROVIDER}`, `{ name = "Lektor check", base_url = "${input.check.modelUrl}", wire_api = "responses", requires_openai_auth = false, env_key = "${TOKEN_ENV}" }`),
        ]
      : []),
    ...disable.flatMap((f) => ['--disable', f]),
    '-',
  ];
}
