# Lektor — Design Doc

Nov 26, 2026 · @Aneesh Mulye

## Summary

Lektor is an Obsidian sidebar chat that sees only the context you hand it, uses tools you allow, and changes nothing in your vault without per-hunk approval. It is a writing companion first: proofreading, catching hard-to-parse sentences, and fact-checking, with general chat as a by-product.

**Goals (v1)**

- One sidebar for local models (Ollama, any OpenAI- or Anthropic-compatible endpoint) and for Claude Code and Codex used purely as chat backends on the user's existing subscriptions.
- Context is explicit: current note by default, plus anything the user attaches; the model can ask for more, and the user decides.
- Tools (web search, fetch page) through one extensible tool registry.
- Every proposed edit is reviewable hunk by hunk, in one of three display modes.
- Three built-in presets: Proofread, Garden paths, Fact-check.
- Uncluttered UI: icons where they are instantly clear, text where they are not.

**Non-goals (v1)**

- Mobile, Windows support (Linux first; macOS should work but is untested).
- Cloud API keys (the provider layer must make them a small addition later).
- Agents that roam the vault, run shell commands, or write files on their own.
- RAG or embeddings over the whole vault.

**Licence:** AGPL-3.0-or-later, so that anyone who runs a modified Lektor core as a network service must share their changes too.

**Names and identifiers**

| What | Value | Rule |
| --- | --- | --- |
| Repository | `obsidian-lektor` | Convention only; makes the repo's purpose obvious |
| Plugin ID (`manifest.json` `id`) | `lektor` | Permanent once published; becomes the folder in `.obsidian/plugins/`; must not contain "obsidian" |
| Display name (`manifest.json` `name`) | Lektor | Must not contain "Obsidian" |

The ID `lektor` was free in Obsidian's plugin directory as of 2026-11-26; re-check `community-plugins.json` in the obsidian-releases repo before submitting.

## The two hard rules

Every design choice below serves two rules, and the code must make breaking them structurally hard, not merely discouraged.

1. **No write without approval.** Nothing in the vault changes unless the user accepts a specific hunk. There is no auto-apply setting.
2. **Only what you give it.** The model sees the context the user attached, nothing else. It may *ask* for more; the user grants or refuses.

**How they are enforced**

- **One gate for vault reads.** All note and attachment content reaches a model through a single `ContextBroker`. No provider, tool or preset imports Obsidian's `Vault` API directly. A lint rule (ESLint `no-restricted-imports`) fails the build if they do.
- **One gate for vault writes.** Only the `ReviewController` may call `vault.modify` / `editor.replaceRange`, and only from an accept action fired by a user click. Models never get a write tool; they return *proposals*.
- **One narrow gate for Lektor's own data.** `PluginStorage` may read and write chats and the AI edit log under the plugin folder, and nothing else: every adapter call it makes must take a path from `resolveStoragePath` / `resolveStorageDir` (in `src/core/storage.ts`), which accept only `<config dir>/plugins/<folder>/<chats|history>/<lowercase key>`. A lint rule enforces the call shape; property tests check that the resolver never produces another path and that `PluginStorage` never touches anything outside it.
- **Excluded folders** are filtered inside `ContextBroker`, so no path around it exists.
- **CLI bridges run blind.** Claude Code and Codex start in an empty, plugin-owned working folder with every file and shell tool disabled. A startup self-test proves this before each session (see Testing).
- **Tools are allow-listed per session.** A model can only call tools registered and enabled for the current chat; tool calls that would read the vault go through `ContextBroker` and its approval prompt like any other request.
- **Fail closed.** If a lockdown flag is rejected, a self-test fails, or a provider's capabilities are unknown, the session refuses to start and says why.

## Fork base

**Decision: a fresh codebase that lifts specific MIT-licensed modules from LLM Hub (and one from Smart Composer), not a whole-repo fork.** The hard rules depend on there being exactly one path to read and one to write the vault; every candidate has dozens of direct vault calls, RAG and agent tools that would have to be found and removed, and any one missed breaks a rule silently.

| Candidate | Licence | Size (TS lines) | Last commit | Worth taking | Why not fork whole |
| --- | --- | --- | --- | --- | --- |
| [LLM Hub](https://github.com/takeshy/obsidian-llm-hub) | MIT | \~40,000 | 2026-11-18 | CLI spawning with `cwd`, stream-json parsing, Codex `exec --json` + `resume`, loopback MCP bridge for Codex, Tavily/Brave search, edit history | Workflows, RAG, skills, Gemini-specific code; its Claude CLI call sets no tool restrictions |
| [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) | MIT | \~31,000 | 2026-01-27 | Apply view with per-block ✓ / ✕ (`vscode-diff`), Ollama and OpenAI-compatible providers | README says not under active development; PGlite, LangChain, Lexical; its Claude/Codex providers reuse subscription OAuth tokens directly, which Anthropic's terms forbid |
| [Local LLM Helper](https://github.com/manimohans/obsidian-local-llm-helper) | MIT | \~8,000 | 2026-10-13 | Simple Ollama + search flows | No React, no diff UI, no CLI bridges; little to reuse |
| [Copilot for Obsidian](https://github.com/logancyang/obsidian-copilot) | AGPL-3.0 | large | 2026-11-23 | Mature agent UI | Agent-first design conflicts with rule 2; too large to strip safely |

**Modules to lift (with MIT notice kept in each file's header and a `THIRD_PARTY.md`)**

- LLM Hub `src/core/cliProvider.ts` — command resolution, spawn, stream-json and Codex JSON event parsing, session resume. Strip everything vault-related; add the lockdown flags.
- LLM Hub `src/core/codexVaultMcpBridge.ts` — a \~200-line loopback MCP server; reuse its transport for Lektor's own tools (`propose_edit`, `request_context`, `report_findings`, search).
- LLM Hub `src/core/externalWebSearch.ts` and friends — provider adapters as a starting point.
- Smart Composer `src/components/apply-view/` + `src/utils/chat/diff.ts` — the per-block diff card, adapted to hunk-level accept.

**Licensing.** MIT code may be included in an AGPL-3.0-or-later project as long as the MIT copyright and permission notices are kept. Lektor as a whole is AGPL-3.0-or-later; each source file carries an SPDX header (AGPL-3.0-or-later, or MIT plus the original notice for lifted files).

**Stack.** TypeScript, esbuild, the Obsidian sample-plugin layout, React 18 for the sidebar (matches the lifted components), CodeMirror 6 decorations for inline review, `zod` for schemas, `vitest` for tests. No database: chat history is JSON in plugin data.

## Architecture

&#91;embedded content: architecture · two vault gates\]

Everything a model sees passes through `ContextBroker`, and everything it changes passes through `ReviewController`. Claude Code and Codex search the web with their own tools; every other backend uses `ToolRegistry`, whose `request_context` calls also go through the broker.

**Architecture boundary: Obsidian plugin first, with a hard core/adapter split.** Lektor ships as one repo, one package, one build, but the code is split so the core could later become its own package with no rewrite.

| Folder | Holds | May import `obsidian`? |
| --- | --- | --- |
| `src/core/` | Chat session, `ChatProvider` adapters and CLI bridges, `ToolRegistry` and search providers, proposal and hunk logic (diff, rebase, history format), preset parsing, invariants | No; an ESLint `no-restricted-imports` rule fails the build |
| `src/obsidian/` | `ContextBroker` and `ReviewController` implementations (vault, `metadataCache`, `vault.modify`), React sidebar, CodeMirror review marks, settings and storage | Yes |

The core defines the interfaces it needs (`ContextSource`, `EditApplier`, `Storage`, `Clock`), and `src/obsidian/` implements them. This keeps the two hard rules structural, since the core cannot reach the vault at all, and lets property tests run against the core with plain in-memory fakes. Do not build a generic multi-editor framework now; the split is the only preparation for other editors.

## Backends

All backends implement one `ChatProvider` interface, so adding cloud API keys later is a new adapter, not a refactor.

```ts
interface ChatProvider {
  id: string;                       // "ollama", "claude-code", "openai-compat:<name>"
  capabilities(model: string): Promise<{
    toolCalling: 'native' | 'mcp' | 'fenced' | 'none';
    nativeWebSearch: boolean;       // CC, Codex: true
    images: boolean;
    contextWindow: number;
  }>;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  // ChatEvent: text | reasoning | tool_call | tool_result | usage | error | done
}
```

**v1 adapters**

| Adapter | Transport | Tool calling | Web search |
| --- | --- | --- | --- |
| Ollama | `/api/chat` (native) | Native function calling where the model supports it | Lektor's search tools |
| OpenAI-compatible | `/v1/chat/completions` (LM Studio, vLLM, llama.cpp, gateways) | Native `tools` | Lektor's search tools |
| Anthropic-compatible | `/v1/messages` | Native `tools` | Lektor's search tools |
| Claude Code | Spawned `claude -p`, stream-json in and out | Lektor tools via loopback MCP | Its own `WebSearch` / `WebFetch` |
| Codex | Spawned `codex exec --json`, `resume` per turn | Lektor tools via loopback MCP | Its own (`--search`) |

**On OpenCode for Ollama search:** not needed. Lektor's own tool loop gives any tool-calling local model search directly, which is simpler than running another agent as a bridge. OpenCode can be added later as a sixth adapter if wanted.

**Claude Code lockdown.** Run in an empty plugin-owned folder (`<plugin data>/void/`, recreated empty each session) with:

```
claude -p --safe-mode --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages --no-session-persistence \
  --tools "WebSearch,WebFetch" --allowedTools "WebSearch" "WebFetch" \
  --permission-mode dontAsk --strict-mcp-config --mcp-config <lektor.json> \
  --disable-slash-commands --system-prompt-file <preset prompt> --model <alias>
```

- `--safe-mode`: CLAUDE.md, skills, plugins, hooks, MCP servers and memory do not load ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
- `--tools`: only the two web tools exist; no Bash, Read, Edit, Glob or Grep.
- `--strict-mcp-config`: only Lektor's MCP server, never the user's.
- `--permission-mode dontAsk` + `--allowedTools`: anything not allowed is denied rather than prompted.
- Web search toggle off → `--tools ""`.

**Codex lockdown.** Same empty folder, plus a plugin-owned `CODEX_HOME` holding only a symlink to the user's `auth.json`, so the user's `config.toml`, MCP servers and global `AGENTS.md` are not loaded:

```
codex exec --json --skip-git-repo-check -C <void> --sandbox read-only \
  -c approval_policy="never" -c features.shell_tool=false \
  -c features.apps=false -c features.multi_agent=false \
  -c features.view_image=false -c features.memories=false \
  -c mcp_servers.lektor.url="http://127.0.0.1:<port>/mcp" --search -
```

- `features.shell_tool=false` removes command execution, which is how Codex reads files ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)); `--sandbox read-only` blocks writes as a second layer.
- Web search toggle off → drop `--search` and set `-c web_search="disabled"`.
- The `CODEX_HOME` trick needs verifying on the installed version (see Risks).

**Subscriptions and terms.** Both bridges run the official CLIs as installed and signed in; Lektor never reads, copies or forwards OAuth tokens. Anthropic's terms forbid using subscription tokens in third-party tools; spawning the official `claude` binary is a different thing, but the settings page links the current terms and the user decides.

**Local model without search.** When the selected model has no tool calling, or search is disabled, and the preset needs search (Fact-check), the header shows a warning chip: "No web search — facts will be checked from the model's memory only." Running the preset requires one extra click to confirm.

## Context system

Context is a visible list of **chips** above the input; what is in the chips is exactly what the model receives, and nothing else.

**Ways to add context**

| Source | How | Default |
| --- | --- | --- |
| Current note | Added automatically when a chat starts or the active note changes | On; one click removes it |
| Selection | Ribbon / hotkey "Add selection"; also auto-offered when text is selected | Off |
| @-mention | Type `@` for a fuzzy note picker | — |
| Drag and drop | Drag notes or files from the file explorer into the sidebar | — |
| Folder | Picker; adds every note in it (non-recursive by default, toggle for recursive) | — |
| Link depth | A chip control on any note chip: depth 0–3, following outgoing links | 0 |

**Backlinks.** Every note in context also sends a *list* of the notes that link to it: paths and titles only, no content, excluded notes left out, capped at 50 entries with a "+N more" line. A per-chip toggle, "Include backlink contents", sends the contents of those notes too, and the same rule applies at every link-depth level.

**Link-depth preview.** The depth menu on a note chip shows, for each depth before you pick it, what that depth would add:

| Depth | Outgoing notes | Est. tokens | Backlinks listed | If backlink contents on |
| --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 4 | +3.1k |
| 1 | +6 | +8.2k | +11 | +14.7k |
| 2 | +19 | +31k | +27 | +40k |

(Illustrative numbers.) Excluded notes are counted separately ("2 excluded, not sent"), and a depth that would push the chat past the model's context window is shown in amber.

This is cheap to compute without reading any note: link structure comes from Obsidian's `metadataCache.resolvedLinks`, inverted once into a backlink index and updated on the cache's `resolved` event; sizes come from `TFile.stat.size`, converted to tokens at roughly 4 characters per token. A breadth-first walk to depth 3 touches only the cached graph. Exact token counts are computed only for notes actually added. A property test checks that the preview always matches what `ContextBroker` would actually send at that depth.

Each chip shows its token estimate; the header shows the total against the model's context window, turning amber past 80%.

**Model-initiated requests.** The model gets one meta-tool, `request_context`, which accepts a structured request: specific notes by path or title, "notes linked from X to depth N", a folder, a search query over note titles, or attachments. The broker resolves it into a concrete list, and the user sees an approval card listing every file with a checkbox (all ticked). Approve, approve subset, or deny. Approved items become chips.

**Embeds and attachments.** `![[...]]` embeds are sent as links, not expanded. Attachment handling has three modes, set globally and overridable per chat:

- **Ask** — the model must call `request_context` for each attachment; the user approves each.
- **Allowed** — attachments are not sent up front, but `request_context` for an attachment *already linked from a note in context* is granted without a prompt.
- **Upfront** — every attachment linked from notes in context is sent at the start.

In all modes, attachments the provider can't accept (e.g. images to a text-only model) are skipped with a visible notice.

**What a note sends.** Note text plus frontmatter, wrapped with its vault path so the model can refer to it and so proposals can name their target.

**Excluded folders.** A settings list of glob patterns. Excluded items never appear in pickers, link-depth expansion, or `request_context` results; the broker silently drops them and shows the user a count ("2 excluded notes skipped").

## Tools framework

Tools are plain objects in a `ToolRegistry`; adding one (dictionary, word count, date maths) is one file and one registration line.

```ts
interface Tool<A, R> {
  name: string;                 // "web_search"
  description: string;          // shown to the model
  schema: ZodType<A>;           // validated before run
  approval: 'never' | 'ask' | 'per-session';
  touchesVault: boolean;        // if true, must go through ContextBroker
  run(args: A, ctx: ToolCtx): Promise<R>;
}
```

The registry exposes enabled tools in each backend's format: native `tools` JSON for API backends, the loopback MCP server for Claude Code and Codex, and a fenced-block protocol (```` ```lektor-tool ````) for models with no tool calling.

**Built-in tools (v1)**

| Tool | Purpose | Approval |
| --- | --- | --- |
| `web_search` | Query the selected search provider; returns title, URL, snippet | Never (capped) |
| `fetch_page` | Fetch a URL, extract readable text (Readability), truncate to N tokens | Never (capped) |
| `request_context` | Ask for notes, folders, link-depth sets, attachments | Ask (see Context) |
| `propose_edit`, `propose_note` | Return edits for review | Review UI |
| `report_findings` | Structured findings for presets | Never |

**Search providers.** One `SearchProvider` interface; v1 ships Tavily, Brave, SearXNG (URL), DuckDuckGo (HTML, no key), and Exa. Settings: provider, key, result count, safe-search, region. Keys are stored in Obsidian's SecretStorage where available.

**Caps.** Searches per message default to 5, fetches per message to 5, both editable globally and per preset. Hitting a cap returns a tool error telling the model to answer with what it has; the chat shows a small "limit reached" notice.

**Network.** All tool HTTP goes through Obsidian's `requestUrl` (no CORS issues, one place to log). No other outbound calls exist.

## Edits and diff review

Models never edit; they emit **proposals**, and the user accepts or rejects each hunk.

**Proposal format.** The model calls `propose_edit({path, edits: [{find, replace, reason?}]})`. `find` must match the note's current text exactly once; the plugin computes hunks from the result with a word-aware diff (`diff-match-patch` with semantic cleanup, or `jsdiff` word mode). Ambiguous or missing `find` strings are returned to the model as a tool error so it can retry. For backends without tool calling, the same JSON is accepted inside a fenced ```` ```lektor-edit ```` block in the reply.

Creating a new note is a separate `propose_note({path, content})` with its own approval card. Proposals may only target notes currently in context.

**Display modes** (global setting, switchable per chat from the header):

| Mode | What you see | Applying |
| --- | --- | --- |
| Prose | The model describes changes in words | You edit by hand; nothing is applied |
| Sidebar diff | A per-note diff card in the chat, hunks with ✓ / ✕ | Accept per hunk, or all / none |
| Inline | Tracked-changes marks in the editor (CodeMirror 6 decorations) plus a summary card in the sidebar | ✓ / ✕ on each hunk in the editor or the card |

In Prose mode the model is told not to call `propose_edit`.

**Staleness and rebase.** Each pending proposal stores the note's content hash and each hunk's anchor (text before and after). On every editor change the plugin re-checks anchors:

- All hunks still apply cleanly → the proposal's status dot stays neutral.
- Some hunks conflict → the dot turns amber. Clicking it opens a small panel: **Rebase** (re-anchor what still matches; a list shows which hunks were dropped and why), **Keep as-is** (leave it stale; accepting a stale hunk is blocked), or **Discard**.

**AI undo history.** Every accepted hunk is logged permanently, per note, in plugin data (before text, after text, time, chat, model). The log is append-only, follows note renames, and is cleared only by an explicit "Clear history" for one note or for all. A history popover per note lets you revert any accepted hunk, which itself checks for conflicts the same way. Obsidian's normal undo still works independently.

## Presets

Presets are Markdown files with YAML frontmatter, kept in a plugin folder inside the vault but hidden from everything else; the settings tab edits the same files. This keeps prompts as plain, editable language without cluttering notes.

**The trade-off (Q24)**

|  | Files in the vault | Plugin settings (`data.json`) |
| --- | --- | --- |
| Editing | Any editor, Obsidian included; full Markdown | A settings text box |
| Versioning and sync | Goes wherever the vault goes (git, Sync) | Synced only as an opaque JSON blob |
| Structure | Frontmatter can be malformed; needs validation | Typed fields, validated by the UI |
| Clutter and leakage | Shows in search and graph; could be attached as context by accident | Invisible |
| Reuse | Can `[[link]]` a style guide note into the prompt | No |

**Decision: files, fenced off.** Presets live in `<vault>/.lektor/presets/*.md`. A dot-folder is hidden from Obsidian's file explorer, search, graph and link index, and `ContextBroker` hard-excludes it. The settings tab offers a form (name, icon, model, tools, display mode) plus a prompt editor, reading and writing those files; an "Open in editor" button opens the folder for anyone who wants raw editing. Invalid frontmatter shows an error on that preset and never breaks the others. If the dot-folder proves awkward, switching to a normal folder plus Obsidian's "Excluded files" setting is a one-line change.

**Preset frontmatter**

```yaml
name: Proofread
icon: spell-check        # Lucide icon name
model: ollama:qwen3.8-27b # default; overridable per chat
tools: []
display: inline           # findings shown as highlights
output: findings          # findings | edits | chat
```

**Built-ins**

- **Proofread** — typos, doubled or missing words, wrong homophones, broken punctuation. Never style.
- **Garden paths** — sentences a careful first-time reader might misparse; quote, explain the misreading, no rewrite unless asked.
- **Fact-check** — extract checkable claims (dates, figures, names, quotes), search only those, verdict per claim: correct, wrong, doubtful, couldn't verify, with sources. Tools: search, fetch.

**Findings output.** Presets with `output: findings` return structured findings (`{quote, kind, explanation, verdict?, sources?}`). They render as inline highlights with a hover card in the note and as a list in the chat; each finding has a "Suggest fix" button that asks the model for a `propose_edit` for that span only.

Presets run from a toolbar icon row, from slash commands (`/proofread`), and from Obsidian's command palette, so each can have a hotkey.

## UI

One right-sidebar view, three stacked zones, nothing else on screen by default.

1. **Header row** (icons, each with a tooltip): model picker (shows provider icon + model name, the only text), display-mode toggle (prose / sidebar diff / inline), tools toggle (globe; amber when the preset needs search and none is available), new chat, history.
2. **Conversation.** Streaming Markdown. Tool calls collapse to one line ("Searched: 3 queries · 5 results"), expandable. Approval cards and diff cards appear inline in the flow where they happened.
3. **Composer.** Context chips row (each chip: icon, name, token count, ✕; note chips have a depth control), preset icon row (Proofread, Garden paths, Fact-check, plus user presets), text box with `@` mentions and `/` commands, send / stop button, token total vs window.

**Discoverability rules**

- Every icon has a tooltip with its name and hotkey.
- Icons only where the meaning is unambiguous (send, stop, ✕, globe, history). Preset buttons show icon + name until the sidebar is narrower than 320 px, then icon only.
- Empty state shows three sample actions ("Proofread this note", "Find garden-path sentences", "Fact-check this note") instead of a blank pane.
- All actions are also in the command palette under "Lektor: …".

**Inline review in the editor.** Deletions struck through in a muted red, insertions underlined in green, a tiny ✓ / ✕ at the end of each hunk; a floating pill at the top right of the editor shows "3 pending · accept all · reject all" and the staleness dot. Findings use a dotted underline coloured by kind, with a hover card (explanation, sources, "Suggest fix").

**Styling.** Obsidian CSS variables only, so themes and dark mode work; Lucide icons, which Obsidian already bundles.

## Storage, settings and privacy

| What | Where | Notes |
| --- | --- | --- |
| Settings | `data.json` (plugin data) | Validated with zod; versioned schema with migrations |
| API keys, search keys | Obsidian SecretStorage | Fall back to `data.json` only if SecretStorage is unavailable, with a warning |
| Chat history | `<plugin dir>/chats/<id>.json` | Messages, context manifest (paths + hashes, not content), tool calls, proposal outcomes |
| Presets | `<vault>/.lektor/presets/*.md` | See Presets |
| AI undo history | Plugin data, history/\<note-id>.jsonl (permanent) | Append-only; follows renames; cleared only on request |
| CLI working folder | `<plugin dir>/void/` | Emptied before every CLI session; never inside the vault |
| Codex home | `<plugin dir>/codex-home/` | Only a symlink to `~/.codex/auth.json` |

**Privacy guarantees**

- No telemetry, analytics or update checks of its own.
- Outbound traffic only to: the configured model endpoints, the configured search provider, pages the model fetches, and whatever the official CLIs themselves contact.
- Chat history stores context *manifests*, not note contents, so deleting a note removes it from history too. A setting allows storing full transcripts for users who want them.
- A "Clear all chats" action and a per-chat delete.

**Settings tabs:** Models (providers, defaults), Context (attachment mode, link-depth limits, excluded folders), Tools (search provider, caps), Review (default display mode), Presets, CLI bridges (paths, self-test, terms links).

## Testing

The rules get their own tests; a build that fails them does not ship.

**Lockdown self-test (runs before every CLI session, cached for 24 h per CLI version).** Lektor puts a canary file `canary.txt` containing a random token in the void folder, and a second canary in a temp folder outside it. It then asks the model, in one short prompt, to list its working directory and print both canaries. The test passes only if the reply contains neither token and the event stream shows no file or shell tool call. On failure the bridge is disabled with the reason shown; there is no override.

**Unit tests (vitest)**

- `ContextBroker`: excluded folders never leak through any path (picker, link depth, `request_context`, attachments in each mode).
- Diff and rebase: hunk computation, anchor re-matching after edits, dropped-hunk reporting; property tests with random edits.
- `propose_edit` validation: zero, one and multiple matches of `find`.
- Tool caps and schema validation.
- CLI argument builders: snapshot tests of the exact flags, so a refactor cannot silently drop a lockdown flag.

**Property tests (fast-check, alongside the unit tests above)**

Example-based tests check the cases we thought of; property tests check the rules hold for inputs we didn't. Before writing any code for a milestone, Claude Code must think carefully about which invariants that milestone has to preserve, write them in `INVARIANTS.md` in plain words, and then turn each one into a property test. Each invariant names its generator, its property, and what a counterexample would mean. Prefer stateful (model-based) tests with `fc.commands` for anything driven by sequences of user or model actions, and record the seed of every failure.

The invariants below are the starting list, not the full one; Claude Code should add to it.

1. **Context containment.** Generate a random vault (notes, links, backlinks, attachments, excluded globs) where every note body carries a unique sentinel token. For any sequence of context actions (add, remove, link depth, folders, `request_context` with any approval subset, each attachment mode, backlink toggle), the outgoing request contains the sentinel of a note if and only if that note is an approved chip, and never one from an excluded path.
2. **Backlink lists carry no content.** With the backlink toggle off, backlinked notes appear in the request as paths and titles only: none of their sentinels appear.
3. **No write without accept.** For any sequence of model outputs (including malformed and adversarial proposals) and user actions, the vault is byte-identical unless an accept action fired, and every change to a note equals exactly the hunks accepted.
4. **Hunk algebra.** For any original and proposed text: accepting all hunks yields the proposed text; rejecting all yields the original; accepting any subset and then the rest equals accepting all; hunks never overlap; accepting non-conflicting hunks in any order gives the same result.
5. **Rebase honesty.** For any proposal and any user edit sequence, every hunk is either still applicable at its anchor or listed as dropped; the dropped list is exactly the original hunks minus the kept ones; a dropped or stale hunk can never be applied.
6. **Undo safety.** Reverting an accepted hunk with no edits since restores the earlier text exactly; with intervening edits it either reverts cleanly or reports a conflict, and never corrupts surrounding text.
7. **History completeness.** The permanent edit log is append-only, and every accepted hunk has exactly one log entry.
8. **Proposal validation.** `propose_edit` applies only when `find` matches exactly once; zero or multiple matches always produce a tool error and no proposal.
9. **Caps hold.** For any sequence of tool calls, executed searches and fetches per message never exceed their caps.
10. **Lockdown flags are unconditional.** For any combination of settings (model, search on or off, preset, paths), the built Claude Code and Codex argument lists always contain every lockdown flag and never contain a forbidden one (`--dangerously-skip-permissions`, `bypassPermissions`, `Bash`, `Read`, `Edit`, `danger-full-access`).
11. **Preset parsing is total.** Any byte string as a preset file either parses or yields an error for that preset alone; it never throws past the loader or affects other presets. Serialising then parsing a valid preset is the identity.

Run 1,000 cases per property in CI and 100 locally; a failing seed becomes a regression unit test.

**Static checks**

- ESLint `no-restricted-imports` / `no-restricted-syntax`: only `ContextBroker` may use `app.vault.read*` / `cachedRead` / `adapter.read` on notes, and only `ReviewController` may use `vault.modify`, `vault.create`, `editor.replaceRange`. The one exception is `PluginStorage`, which may call a fixed set of adapter methods only with resolver-built paths inside the plugin folder (see "How they are enforced"). The exact rules are in `eslint/gates.mjs` and `INVARIANTS.md` (G1–G6).

**Manual test vault.** A fixtures vault in the repo with an excluded folder, attachments, link chains to depth 3, and sample texts seeded with typos, garden-path sentences and wrong facts, used for preset checks against each backend.

## Milestones

Build in this order; each milestone ends usable and with its tests passing. Don't start one before the previous one's tests are green.

1. **Skeleton.** Sample-plugin scaffold, AGPL-3.0-or-later licence, `THIRD_PARTY.md`, esbuild, vitest, fast-check, INVARIANTS.md, ESLint gate rules (including "src/core may not import obsidian"), the src/core and src/obsidian folders, empty React sidebar view, settings tab with zod schema.
2. **Ollama chat.** `ChatProvider` interface, Ollama adapter, streaming, stop, regenerate, model picker. Chat history in plugin data.
3. **Context.** `ContextBroker`, current-note chip, selection, `@` mentions, drag and drop, folders, link depth, excluded folders, token estimates.
4. **Tools.** `ToolRegistry`, native tool loop for Ollama, `web_search` (Tavily first, then the rest), `fetch_page`, caps, no-search warning.
5. **Review: sidebar diff.** `propose_edit`, `ReviewController`, per-hunk accept/reject, accept/reject all, AI undo history.
6. **Review: inline + staleness.** CodeMirror decorations, the editor pill, staleness dot, rebase panel with dropped-hunk list. Prose mode.
7. **`request_context` and attachments.** Approval card, the three attachment modes.
8. **Presets.** Preset files, settings form, the three built-ins, findings rendering, "Suggest fix", slash commands, command palette entries.
9. **OpenAI- and Anthropic-compatible adapters.**
10. **Claude Code bridge.** Lift and trim LLM Hub's spawner, void folder, lockdown flags, loopback MCP server for Lektor tools, lockdown self-test.
11. **Codex bridge.** Same, plus the isolated `CODEX_HOME`, `exec --json` + `resume`.
12. **Polish.** Empty state, tooltips and hotkeys, narrow-sidebar layout, README with screenshots.

## Risks and open questions

| Risk | Why it matters | Mitigation or check |
| --- | --- | --- |
| `--safe-mode` may also block `--mcp-config` | Claude Code would lose Lektor's tools | Test first. If blocked: drop `--safe-mode`, keep `--strict-mcp-config` and `--setting-sources` empty; or use the fenced-block protocol for CLI backends |
| `--tools ""` once failed to disable tools (closed as resolved April 2026) | Rule 2 | The lockdown self-test catches it on every CLI version |
| Isolated `CODEX_HOME` with a symlinked `auth.json` may not keep the session signed in, or token refresh may write back elsewhere | Codex bridge fails to start | Test on the installed version; fall back to the user's `CODEX_HOME` with every feature and MCP server overridden by `-c` flags |
| Codex may gain a non-shell file tool in a future version | Rule 2 | Self-test, plus snapshot tests of flags; review Codex release notes when upgrading |
| Anthropic's subscription terms for wrapping `claude -p` are a grey area | Account risk | Settings page links the current terms; the user opts in to each bridge |
| Dot-folder presets can't be opened in Obsidian's editor | Raw editing needs the settings form or an external editor | Acceptable; switchable to a visible folder + "Excluded files" |
| Small local models handle tool calling unreliably | Searches and edit proposals fail | Fenced-block fallback; validate every tool call; show raw output on parse errors |
| Inline CodeMirror review is the most complex part | Schedule | Ship sidebar diff first (milestone 5), inline later (6) |

**Decided since the first draft**

- Link depth follows outgoing links. Backlinks are sent as a list (no content) by default; a toggle adds their contents.
- Accepted AI edits are logged permanently (append-only), the conservative choice.
- Name: Lektor, after the publishing editor who reads a manuscript closely before it goes out.
