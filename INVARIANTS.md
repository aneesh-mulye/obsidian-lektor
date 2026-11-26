# Lektor invariants

Each invariant names its **generator** (what random inputs we throw at it), its **property** (what must hold for every one of them), and what a **counterexample** would mean. Every invariant is a fast-check property test; the test file is named next to it. Runs: 100 cases locally, 1,000 in CI (`npm run test:ci`). A failing seed becomes a regression unit test in the same folder, named after the seed.

Status: **active** means a property test exists and runs; **planned (Mn)** means it lands with milestone *n*.

Stateful tests use `fc.commands(…, { size: 'large' })`. With the default size, fast-check generates runs of about five commands (ten at most in 100 runs), too short to reach states that need four specific steps in a row. A surviving mutant in the session test showed this.

Every invariant's test has been mutation-checked: each guard in the code was removed in turn, and the test had to fail. Mutants that survived led to stronger generators or extra tests. The remaining survivors are equivalent (redundant code that changes no behaviour).

Regression tests from failing seeds or surviving mutants so far: `tests/core/settings.test.ts` › "does not let an unreadable list become readable through serialisation" (a mutant of the S5 guard survived the property tests because JSON never produces such a value from disk); "normalises -0 to 0, on load and on update" (S2, seed 1865398749 in a CI-strength run: `-0` was stored as `-0` but saved as `0`). `tests/core/ndjson.property.test.ts` › "returns exactly JSON.parse of each line, -0 included" (N1, seed 316671435: the test's model compared against the in-memory `-0` instead of what JSON puts on the wire; the decoder was right). `tests/core/ollama.property.test.ts` › "sends tool-call arguments as JSON (so -0 becomes 0)" (O2, full-suite run, seed not captured: the same `-0` model mistake, in tool-call arguments). `tests/core/review.property.test.ts` › "reverting a change that emptied the note puts the text back" (W3–W5, seed -1474712944: correct behaviour; the checker treated the empty anchor of an emptied note as "not found").

---

## Milestone 1: skeleton

### G1. The core cannot import Obsidian or the editor — active

`tests/lint/gates.property.test.ts`

- **Generator:** a random file path under `src/core/` (any depth, `.ts` or `.tsx`) × a random way of importing a forbidden module: static `import`, `import type`, `export … from`, `require()`, `window.require()`, dynamic `import()`, for the modules `obsidian` and `@codemirror/*`.
- **Property:** ESLint reports at least one gate error for the snippet.
- **Counterexample means:** the core can reach the vault or editor without going through an adapter, so rule 2 stops being structural.

### G2. Only `ContextBroker` reaches vault content — active

`tests/lint/gates.property.test.ts`

- **Generator:** a random file path under `src/`, including near-misses such as `src/obsidian/ContextBroker.tsx` or `src/obsidian/ui/ContextBroker.ts`, × a random snippet that reaches vault or note content:
  - the handles `.vault`, `.adapter`, `.metadataCache`, `.fileManager`, `.editor`, `.activeEditor` and `.cm`, by dot, optional-chain, computed `['…']`, template-literal and destructuring access (including in parameters), on random receivers (`this.app`, `app`, `plugin.app`, `window.app`, …);
  - the methods `cachedRead`, `readBinary`, `getViewData`, `registerEditorExtension`, and `app.vault.read(…)`;
  - commands with `editorCallback` / `editorCheckCallback`, and `editor-*` workspace events;
  - importing `Vault`, `DataAdapter`, `FileSystemAdapter`, `MetadataCache`, `FileManager`, `MarkdownView`, `MarkdownEditView`, `TextFileView`, `Editor` or `MarkdownFileInfo` from `obsidian`, or anything from `@codemirror/*`.
- **Property:** a gate error is reported **if and only if** the reference model in the test says this file may not do this. The model:
  - `src/obsidian/ContextBroker.ts` may read: `.vault`, `.adapter`, `.metadataCache`, `.editor`, `.activeEditor`, the read methods except `registerEditorExtension`, editor commands and events, and the content imports except `FileManager`. It may not use `.fileManager`, `.cm`, `registerEditorExtension` or `@codemirror/*`.
  - `src/obsidian/ReviewController.ts` may use `.vault`, `.fileManager`, `.editor`, `.activeEditor`, `.cm`, `getViewData`, `registerEditorExtension`, editor commands and events, `@codemirror/*`, and the content imports except `DataAdapter`, `FileSystemAdapter` and `MetadataCache`. It may not use `.adapter`, `.metadataCache`, `cachedRead`, `readBinary` or `vault.read`.
  - Every other file may do none of it. Under `src/core/`, nothing from `obsidian` may be imported at all (G1).
- **Counterexample means:** either a second path to vault content exists (rule 2 broken), or the gate blocks a file that is supposed to have that access, which would push people to disable it.

### G3. Only `ReviewController` writes — active

`tests/lint/gates.property.test.ts`

- **Generator:** a random file path under `src/` × a random write snippet:
  - `replaceRange` / `replaceSelection` on any receiver, by call, computed call or destructuring;
  - vault writes (`modify`, `create`, `process`, `append`, `delete`, `trash`, `rename`, `copy`, …) through `app.vault`, or through a held `vault` reference in `ContextBroker` (which is otherwise allowed to hold one);
  - adapter writes (`write`, `remove`, `mkdir`, …);
  - `fileManager` calls (`processFrontMatter`, `renameFile`, `trashFile`);
  - editor mutators (`setValue`, `setLine`, `transaction`, `undo`, `redo`, `processLines`, `editor.exec`) in `ContextBroker`, which may hold an editor to read the selection.
- **Property:** a gate error is reported in every file except `src/obsidian/ReviewController.ts`, and adapter writes are reported everywhere, `ReviewController` included: it writes through the vault, never the raw adapter. Editor mutators with generic names such as `setValue` are banned only in `ContextBroker`; elsewhere no editor is reachable (G2), and `TextComponent.setValue` in settings must keep working.
- **Counterexample means:** something other than the review UI can change a note, so rule 1 stops being structural.

### G4. No raw filesystem, process or Electron access outside the CLI bridges — active

`tests/lint/gates.property.test.ts`

- **Generator:** a random file path under `src/` × importing `fs`, `node:fs`, `fs/promises`, `node:fs/promises`, `original-fs`, `child_process`, `node:child_process` or `electron`, by any import form.
- **Property:** a gate error is reported unless the path is under `src/core/cli/` (the Claude Code and Codex bridges, milestones 10–11).
- **Counterexample means:** a module can read note files straight off disk, around `ContextBroker`.

### G5. The project config applies the gates unchanged — active

`tests/lint/config.test.ts`

- **Generator:** a fixed set of representative paths (core, CLI, generic obsidian, `ContextBroker`, `ReviewController`, a `.tsx` view). The paths are fixed, not random, because the config is finite.
- **Property:** the rules ESLint actually resolves for each path from `eslint.config.mjs` include the gate rules exactly as `eslint/gates.mjs` defines them for that path's category.
- **Counterexample means:** a later config block overrides or switches off a gate. In flat config the last block that sets a rule wins, so this can happen silently.

### G6. `PluginStorage` can only touch Lektor's own data folder — active

`tests/lint/gates.property.test.ts`

- **Generator:** a random file path under `src/` × a random snippet that uses the adapter: allow-listed calls (`read`, `write`, `append`, `remove`, `exists`, `list`, `mkdir`) whose first argument is `resolveStoragePath(…)` or `resolveStorageDir(…)`; the same calls with a raw path, a template string or a `join(…)` of a resolved directory; methods that are not allow-listed (`getFullPath`, `rename`, `readBinary`, …); computed access; aliasing the adapter in a variable; other vault members (`getMarkdownFiles`, `configDir`); and attempts to fake the resolver (defining a local `resolveStoragePath`, importing it from another module, or importing something else under that name).
- **Property:** in `src/obsidian/PluginStorage.ts`, a gate error is reported unless the code is exactly `<x>.vault.adapter.<allow-listed>(resolveStoragePath(…) | resolveStorageDir(…), …)` with the resolver imported under its own name from `core/storage`. Every other file follows the G2 and G3 model: `ContextBroker` may read through the adapter but never write, and the rest may not touch it at all.
- **Counterexample means:** the storage module can reach a path that the resolver never checked, so it becomes a second, unconfined path into the vault.

### P1. Storage paths are confined — active

`tests/core/storage.property.test.ts`

- **Generator:** any string, or any value at all, as the plugin folder, namespace and key, mixed with adversarial ones: `..`, `.`, `a/b`, `a\b`, absolute paths, `%2e%2e`, NUL bytes, `__proto__`, upper case, Windows reserved names, over-long keys, and valid folders such as `.obsidian/plugins/lektor`.
- **Property:** `resolveStoragePath` either throws `StorageError` or returns exactly `<root>/<namespace>/<key><ext>`. In that case the root has the form `.<config>/plugins/<folder>`, the namespace is one of `chats`/`history`, the key matches `^[a-z0-9][a-z0-9_-]{0,127}$`, and the path has exactly five segments, none of them empty, `.` or `..`, with no backslash. `resolveStorageDir` obeys the same rule with four segments. `keyFromStoragePath` inverts `resolveStoragePath` and returns null for every other path.
- **Counterexample means:** a crafted key or folder escapes the plugin data folder and reads or overwrites a note.

### P2. Distinct keys never collide — active

`tests/core/storage.property.test.ts`

- **Generator:** pairs of valid (namespace, key).
- **Property:** different pairs resolve to paths that differ even when compared case-insensitively, because macOS and Windows file systems ignore case.
- **Counterexample means:** one chat or history log silently overwrites another.

### P3. `PluginStorage` only touches resolved paths, and behaves like a map (stateful) — active

`tests/obsidian/PluginStorage.property.test.ts`, `fc.commands`

- **Generator:** a fake adapter pre-seeded with notes and junk files (including files inside the namespace folders that are not valid keys), then random sequences of `write`, `append`, `read`, `remove`, `list` and `exists`-backed calls, each with a valid or adversarial namespace and key.
- **Model:** a map from (namespace, key) to text.
- **Property:** every path the adapter sees is `<root>/<ns>` or `<root>/<ns>/<valid key><ext>`. Calls with invalid input throw before any adapter call. `read` returns the model's value or null, `list` returns exactly the model's keys (junk files ignored), and pre-seeded notes are never read, changed or removed.
- **Counterexample means:** the storage layer leaks or damages a file outside its folder, or loses data.

### S1. Loading settings is total and conforms — active

`tests/core/settings.property.test.ts`

- **Generator:** any JavaScript value (`fc.anything()`), any JSON value, and *near-valid* settings: a valid settings object with random leaves replaced by random values, random keys added (including `autoApply: true`), and sections deleted.
- **Property:** `SettingsStore.load` never throws, and the settings it holds pass the strict zod schema: every field present and valid, and no key the schema doesn't name.
- **Counterexample means:** a corrupt `data.json` crashes the plugin, or an unknown key such as an auto-apply switch survives loading.

### S2. Valid settings round-trip — active

`tests/core/settings.property.test.ts`

- **Generator:** any valid settings object.
- **Property:** after `load(JSON round-trip of store.toData())`, the settings deep-equal the original, exclusions are intact, and there are no problems. Loading is also idempotent: loading what a store saves gives the same store.
- **Counterexample means:** saving and reopening Obsidian changes a user's settings.

### S3. One bad field doesn't reset the others — active

`tests/core/settings.property.test.ts`

- **Generator:** any valid settings object, with exactly one leaf field replaced by an invalid value.
- **Property:** that field falls back to its default and is named in `problems`; every other field keeps its stored value.
- **Counterexample means:** a single typo in `data.json` silently wipes unrelated settings.

### S4. Exclusions fail closed — active

`tests/core/settings.property.test.ts`

- **Generator:** a stored value that is not null or undefined (that is, not a fresh install), whose `context.excludedFolders` is missing, not an array, or holds any invalid entry.
- **Property:** `exclusionsIntact` is false, and the effective exclusion list is `['**']` (exclude everything), never `[]`. A fresh install (null or undefined) gives `exclusionsIntact: true` and `[]`.
- **Counterexample means:** corrupting the exclusion list would quietly make private folders visible to the model (rule 2).

### S5. Only an explicit edit can restore exclusions (stateful) — active

`tests/core/settings.property.test.ts`, `fc.commands`

- **Generator:** an initial stored value, possibly with corrupt exclusions, then a random sequence of commands: `update` with a random valid or invalid patch, including patches that try to smuggle `excludedFolders` in; `setExcludedFolders` with random lists; and `save → reload` from the JSON-serialised data.
- **Model:** the expected settings, the expected `exclusionsIntact`, and the expected exclusion list.
- **Property:** after every command the store matches the model. `update` never changes `excludedFolders` or `exclusionsIntact`. Invalid patches change nothing. `exclusionsIntact` goes from false to true only through `setExcludedFolders`. Save and reload preserve both the settings and the intact flag, so an unreadable list is written back as it was rather than as `[]`.
- **Counterexample means:** changing some unrelated setting would overwrite a corrupt exclusion list with "exclude nothing".

---

## Milestone 2: Ollama chat

### G7. No network, remote loading or HTML injection except in their owning files — active

`tests/lint/gates.property.test.ts`

- **Generator:** a random file path under `src/` × a random snippet that opens a network channel or injects markup:
  - globals `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `RTCPeerConnection`, `Worker`, `SharedWorker`, `Image`, `Audio` and `open`, by bare, `window.`, `globalThis.`, computed or destructured reference;
  - `navigator.sendBeacon`;
  - importing `requestUrl` / `request` from `obsidian`;
  - Node `http`, `https`, `net`, `tls`, `dgram`, `http2`, `dns`, `undici`;
  - creating `img`, `iframe`, `video`, `audio`, `source`, `script`, `link`, `style`, `object`, `embed`, SVG `image`/`use` and similar elements, by `createEl`/`createElement` or JSX;
  - setting `src` / `srcset` / `srcdoc` / `backgroundImage`, or `setAttribute('src', …)`;
  - `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTMLUnsafe`, `document.write`, `createContextualFragment`, and importing `MarkdownRenderer` / `sanitizeHTMLToDom` from `obsidian`.
- **Property:**
  - Network APIs are allowed only in `src/obsidian/Http.ts`. Node `http` / `net` are also allowed in `src/core/cli/` (the loopback MCP server, milestones 10–11), and the other Node network modules nowhere.
  - Remote-loading elements, `src`-style properties, `MarkdownRenderer`, `innerHTML` and the other raw-HTML APIs are allowed nowhere.
  - `dangerouslySetInnerHTML` is allowed only in `src/obsidian/ui/SafeMarkdown.tsx`.
- **Counterexample means:** code could contact a host the user didn't configure (DESIGN.md § Privacy guarantees). Or model output could load a remote resource (an exfiltration channel) or run script in Obsidian, which would break both hard rules.

### R1. Rendered model output cannot load anything or run anything — active

`tests/obsidian/markdown.property.test.ts`

- **Generator:** arbitrary strings, plus adversarial Markdown built from parts:
  - images (inline, reference-style, inside links);
  - raw HTML (`<img onerror>`, `<iframe>`, `<script>`, `<svg onload>`, `<a href="javascript:…">`, `<style>`);
  - links with the schemes `javascript:`, `JaVaScRiPt:`, `data:`, `vbscript:`, `file:`, `obsidian:` and `app:`, entity-encoded schemes, and control characters inside schemes;
  - autolinks and bare URLs;
  - tables, code spans and fences.
- **Property:** the HTML that `renderSafeMarkdown` produces contains only allow-listed tags (text-level and block Markdown structure, with no `img` and no media) and only allow-listed attributes: `href`, `rel`, `target` and `class` on links, a `language-…` class on code, `text-align` on table cells and `start` on lists. Every `href` is `http:`, `https:` or `mailto:`. No attribute name starts with `on`.
- **Counterexample means:** a model reply, perhaps written by a page it fetched, can make Lektor contact a server just by being displayed, or can run script inside Obsidian.

### N1. NDJSON decoding is exact under any chunking — active

`tests/core/ndjson.property.test.ts`

- **Generator:** a list of JSON values (with non-ASCII and astral text), serialised one per line with `\n` or `\r\n` endings, random blank lines and an optional final newline, then cut into chunks at arbitrary *byte* offsets, including inside multi-byte UTF-8 characters. Some lines are deliberately malformed.
- **Property:** the decoder yields exactly the values in order. Each malformed line yields one `bad` item at its position without disturbing its neighbours, and the decoder never throws on input.
- **Counterexample means:** a reply is garbled or truncated depending on how the network happened to split packets.

### O1. Every Ollama stream ends exactly once — active

`tests/core/ollama.property.test.ts`

- **Generator:** a fake HTTP client that answers with a random status code and a random sequence of NDJSON lines: content and thinking deltas, a final `done` line with a random `done_reason`, `{"error":…}` lines, malformed lines, an early close, or a thrown network error. The bytes are cut at random, and the stream is optionally aborted after a random number of events.
- **Property:** `stream()` never throws. It yields zero or more `text`, `reasoning`, `usage` or `error` events, then exactly one `done`, and nothing after it. The concatenated `text` equals the concatenated content the server sent before the stream ended. A non-200 status or an error line yields `error` and then `done: error`. An abort yields `done: aborted`, with no text after the abort is observed. A close without a `done` line is an error, never a silent success.
- **Counterexample means:** the UI can hang in "streaming" for ever, show a partial reply as complete, or crash on a bad response.

### O2. Ollama requests carry only the conversation, only to the configured server — active

`tests/core/ollama.property.test.ts`

- **Generator:** any configured base URL (valid `http`/`https`) × any model name × any message list.
- **Property:** every request goes to `<baseUrl>/api/<endpoint>` and nowhere else. The `/api/chat` body is exactly `{model, messages, stream: true, options: {num_ctx}}`, plus `think` only when the model reports the `thinking` capability. `num_ctx` is the configured context length capped at the model's maximum. Each message is exactly `{role, content}` and equals the input.
- **Counterexample means:** data reaches a host the user didn't configure, or the request carries something the user didn't send.

### C1–C5. Chat session (stateful) — active

`tests/core/session.property.test.ts`, `fc.commands`

- **Generator:** a fake provider whose streams the test drives by hand, plus random sequences of user actions (`send`, `stop`, `regenerate`, `setModel`) and provider actions (emit text or reasoning, finish with `stop` or `length`, emit an error, end without `done`, throw, keep emitting after being aborted, fail `capabilities`).
- **Model:** the expected transcript, with each message's role, content and status.
- **Properties:**
  - **C1 (the model sees exactly the transcript):** every request's `messages` equals the visible transcript before the pending reply. That means user messages plus non-empty assistant replies that are complete, stopped or cut off. Error replies and reasoning are excluded.
  - **C2 (one stream at a time):** while a reply is streaming, `send` and `regenerate` are refused and do not call the provider. At most one stream's events are ever applied.
  - **C3 (stop is final):** after `stop`, the stopped reply never changes again, even if the provider keeps emitting.
  - **C4 (regenerate replaces only the last reply):** earlier messages are untouched, and the new request is the transcript before the replaced reply.
  - **C5 (every turn ends):** after any provider behaviour (done, error, early end, throw) the session is idle and the reply has a terminal status. The last saved state equals the in-memory state.
- **Also, fail closed:** if `capabilities()` fails, the provider's `stream` is never called and the reply shows the error.
- **Counterexample means:** the model is sent text the user can't see, two replies interleave, a stopped reply keeps growing, or the UI is stuck.

### H1–H3. Chat history store — active

`tests/core/history.property.test.ts`

- **Generator:** random chats (any Unicode text, any statuses), random corrupt files dropped into the chats folder, and random sequences of save, load, delete and clear.
- **Properties:**
  - **H1:** save then load is the identity, except that a reply saved mid-stream loads as `stopped`.
  - **H2:** a corrupt or foreign file never breaks listing or loading other chats; it is counted as unreadable.
  - **H3:** chat ids are valid storage keys, and after `clearAll` nothing is listed.
- **Counterexample means:** history is lost or corrupted, or one bad file hides all chats.

### S6. Settings v1 migrate to v2 losslessly — active

`tests/core/settings.property.test.ts`

- **Generator:** any valid version-1 settings object.
- **Property:** loading gives version 2 with every v1 field unchanged, the new `models` section at its defaults, no problems, and exclusions still intact.
- **Counterexample means:** upgrading Lektor resets or reports a user's settings.

## Milestone 3: Context

Shared generator, the **random vault**: 1–25 Markdown notes in nested folders (including folders named like the exclusion patterns, mixed case, hidden folders, `.lektor/` and the config folder), random outgoing links (with cycles, self-links, links to missing notes and to non-Markdown files), random excluded-folder patterns and Obsidian exclusion filters, and the "respect Obsidian's excluded files" toggle. Every note body carries a unique sentinel token, and its stored size is its UTF-8 byte length.

### X1. Exclusion matching is fail-closed — active

`tests/core/exclusions.property.test.ts`

- **Generator:** random paths and random pattern lists (bare names, anchored paths, globs, trailing slashes, mixed case), Obsidian filters (prefixes and `/regex/`), and invalid patterns.
- **Properties:**
  - **Closed under descendants:** if a folder or path is excluded, so is everything below it.
  - **Monotonic:** adding a pattern never un-excludes anything.
  - **Case-blind:** changing the ASCII case of a path never changes the result.
  - **Hard exclusions:** hidden segments, the config folder and `.lektor/` are always excluded.
  - **Bare names:** a bare name excludes exactly the paths with a segment of that name (ignoring case).
  - **Fail-closed:** an invalid pattern, or the unreadable-list sentinel `**`, excludes everything.
- **Counterexample means:** a note the user excluded can still reach a model.

### X2. Context containment (design invariant 1, milestone 3 part; stateful) — active

`tests/core/context.property.test.ts`, `fc.commands`

- **Generator:** a random vault and a random sequence of context actions: add or remove a note, folder (recursive or not) or selection; set link depth 0–3; toggle backlink contents; pin; toggle following; change the active note; edit exclusion patterns; flip the Obsidian toggle; and add, delete or rename notes. After each action the context is assembled and rendered exactly as a request would be.
- **Model:** an independent breadth-first walk over the raw graph that never enters an excluded note, plus the folder and backlink rules.
- **Property:** the rendered context contains a note's sentinel **if and only if** the model says that note's content is in context. It never contains an excluded note's sentinel. The excluded-note count shown to the user equals the model's. A selection appears only while its source note is not excluded.
- **Counterexample means:** the model sees a note the user did not give it, or doesn't see one they did (hard rule 2).

### X3. Backlink lists carry no content (design invariant 2) — active

`tests/core/context.property.test.ts`

- **Generator:** the X2 generator with backlink contents off for every chip.
- **Property:** every note that appears only as a backlink appears by path and title, and none of its sentinel appears. Each list has at most 50 entries plus a "+N more" line whose N is exact.
- **Counterexample means:** "list only" silently shares note text.

### X4. The link-depth preview matches what is sent — active

`tests/core/context.property.test.ts`

- **Generator:** a random vault, a note chip, and a depth 0–3 with backlink contents on or off.
- **Property:** the preview's note count, token estimate, backlinks-listed count and excluded count, computed from metadata alone, equal those of the context actually assembled for that chip at that depth.
- **Counterexample means:** the menu promises one thing and Lektor sends another.

### X5. Rendering is exact and unambiguous — active

`tests/core/render.property.test.ts`

- **Generator:** assembled contexts whose note contents and selections contain arbitrary text, including the rendering's own markers, near-miss boundary tokens and paths with quotes and newlines.
- **Property:** an independent parser recovers from the rendered message exactly the list of notes (path and content), backlink lists and selections that went in.
- **Counterexample means:** note text could forge another note's boundary (a prompt-injection foothold), or content is altered on its way to the model.

### C6. Over-budget requests are never sent — active

`tests/core/session.property.test.ts`

- **Generator:** the C1–C5 stateful run, with random context sizes and random context windows, and with usage reports that calibrate the estimate.
- **Property:** a request reaches the provider only if its calibrated estimate plus the reply reserve fits the window. Otherwise the reply fails with an explanation and the provider is not called. Every request is exactly the context message (if any) followed by the C1 transcript.
- **Counterexample means:** Ollama silently truncates the start of the prompt, so the model loses context the user gave it.

### H4. History never stores note text, unless full transcripts are on — active

`tests/core/history.property.test.ts`

- **Generator:** chats whose context comes from a random vault with sentinel tokens, saved with "store full transcripts" off or on.
- **Property:** with the setting off, no saved file contains any sentinel, and selections are stored as path, range and hash only. With it on, the context text sent with each reply can be recovered exactly. Restoring a chat drops chips for deleted or now-excluded notes, and selections whose text changed, each with a notice.
- **Counterexample means:** a deleted or private note survives in chat history (DESIGN.md § Privacy guarantees).

### S7. Settings v2 migrate to v3 losslessly — active

`tests/core/settings.property.test.ts`

- **Generator:** any valid version-1 or version-2 settings.
- **Property:** loading gives version 3, keeps every existing field, and sets the new fields to their defaults (`models.ollama.contextLength` 32,768, `context.respectObsidianExclusions` on). It reports no problems.

### Checked in a real Obsidian (milestone 3)

On 2026-11-26, against a copy of `fixtures/vault` in a separate Obsidian 1.15.1 instance (own profile folder, debugging on 127.0.0.1 only), driven with Playwright, and with the real request to Ollama captured on its way out:

- At depth 1 the request contained exactly `Drafts/Essay`, `Reference/Chain A` and `Reference/Sources`, with their backlink lists. Neither the `PRIVATE-SENTINEL` (Lektor-excluded `Private/`) nor the `TEMPLATE-SENTINEL` (Obsidian-excluded `Templates/`) was in it. "2 excluded notes skipped" was shown, `num_ctx` was 65536, and the model answered from the note.
- Following and pinning the current note, opening an excluded note (no chip), the "Add selection" offer, `@`-mentions, dropping an allowed and an excluded note, a new chat, and reopening a chat with all chips (selection included) restored all behaved as specified.
- The saved chat file held paths, ranges and hashes only: no note text.

The user's own Obsidian profile was hashed before and after and was unchanged.

## Milestone 4: Tools

### T1. Tool arguments are validated before anything runs — active

`tests/core/tools.property.test.ts`

- **Generator:** tool calls with random names (registered, unregistered, registered but not enabled for the chat) and random arguments: any JSON value, JSON-in-a-string, missing or extra fields, wrong types.
- **Property:** a tool's `run` is called only when its name is enabled and its arguments pass its zod schema. Every other call returns a tool error to the model, and no network request is made.
- **Counterexample means:** a model can run a tool the user didn't allow, or with arguments the tool never expected.

### T2. Caps hold (design invariant 9) — active

`tests/core/tools.property.test.ts`, `fc.commands`

- **Generator:** random sequences of `web_search` and `fetch_page` calls (valid and invalid, approved and denied) spread across messages and tool rounds, with random caps from 0 to 50.
- **Property:** within one user message, executed searches never exceed the search cap and fetches never exceed the fetch cap, across all rounds. Each call over the cap returns a "limit reached" tool error and makes no request. Counts start again with the next message.
- **Counterexample means:** a model can run up unbounded searches, or fetch unbounded pages, for a single message.

### T3. Fetches need provenance or approval — active

`tests/core/tools.property.test.ts`

- **Generator:** known URLs (from search results, user messages and attached notes) and adversarial variants of them: an appended query or path, a different host or port, userinfo tricks (`https://known.example@evil.example/`), `http` versus `https`, a changed fragment, unicode, and non-http schemes. Approvals and denials are random.
- **Property:** `fetch_page` requests a URL with no approval only if it equals a known URL after normalisation (which only lower-cases the host and drops the fragment). Any other URL asks first, and a denial makes no request. Non-http(s) URLs never reach the network.
- **Counterexample means:** a model can smuggle note text out in a URL without the user seeing it.

### T4. Search providers return clean results or a clear error — active

`tests/core/search.property.test.ts`

- **Generator:** for each provider (Tavily, Exa, Brave, SearXNG, DuckDuckGo), random HTTP statuses and bodies: valid responses with random fields, wrong shapes, invalid JSON, HTML in titles, `javascript:` and relative URLs, huge snippets. Queries and options are random.
- **Property:** `search` either returns results whose URLs are all absolute http(s), whose titles and snippets are bounded plain text, and which are never more than requested, or it rejects with a `ProviderError`. It never throws anything else. Every request goes only to the provider's documented endpoint (or the configured SearXNG URL), carries the key only in the documented header, and never puts the key in the URL.
- **Counterexample means:** a hostile search result injects markup or a dangerous link, or the key leaks into a URL or log.

### C7. The tool loop (stateful) — active

`tests/core/session.property.test.ts`

- **Generator:** the C1–C6 run, extended with tool-call events, tool outcomes (success, error, limit), approvals that are granted, denied or interrupted by Stop, the per-chat tools toggle, and models with and without tool calling.
- **Properties:**
  - Tools are offered only when the chat's toggle is on and the model supports tool calling.
  - After a round that ends in tool calls, the next request is the previous request plus exactly that round's assistant turn and one tool result per call, in order.
  - The loop stops after at most 8 rounds.
  - Stop during a tool call or an approval ends the reply as stopped, with no further request.
  - Every round passes the C6 budget check.
  - In later messages, a finished reply's tool rounds are sent back as they happened, and a failed reply's are not.
- **Counterexample means:** the model sees tool results that don't match what ran, or the loop can run away.

### H5 and S8 — active

- **H5** (`tests/core/history.property.test.ts`): replies with tool rounds round-trip through history exactly. `chatsSending(path)` finds exactly the chats whose context manifests include the note.
- **S8** (`tests/core/settings.property.test.ts`): settings v3 migrate to v4 losslessly. The new tool settings get their defaults: no search provider, 5 results, moderate safe search, no region, fetches capped at 4,000 tokens, and no keys. Settings hold only secret *names*, never key values.

### Checked in a real Obsidian (milestone 4)

On 2026-11-26, in the same kind of separate instance, with `qwen3.8:27b` and the requests to Ollama captured:

- **DuckDuckGo:** a live search ran through `requestUrl` and the native tool loop. The second request was exactly `system user assistant(+1 call) tool`, the tool result was marked as untrusted web text, and the model answered with a source.
- **Fetch provenance:** a URL the model had to construct (never written verbatim) raised an approval card showing the full URL. On Deny, the model received "declined" and the reply said so.
- **The globe:** its label and style follow on, off and "page fetching only".
- **Tavily:** a live search returned 5 results.
- **Exa:** returned HTTP 402 (out of credits). That shows the request and the key were accepted, and the error reached the user verbatim. Exa's result parsing is covered by T4's fakes only.
- **Keys:** neither key appeared in any request to Ollama or in Lektor's `data.json`, which held only the secret names.

The user's own Obsidian profile was unchanged before and after.

## Milestone 5: Review (sidebar diff)

Shared generator, the **edit world**: a few notes with random Unicode text (repeated phrases, so `find` strings can be ambiguous), a context saying which notes are editable, and an in-memory vault behind the `EditApplier` interface that records every write.

### W1. Hunk algebra (design invariant 4) — active

`tests/core/hunks.property.test.ts`

- **Generator:** any `find` and `replace` text (words, punctuation, whitespace runs, newlines, emoji, CJK), including near-identical pairs and empty replacements.
- **Properties:**
  - Hunks are sorted, never overlap, and never cover an unchanged run of three or more words (phrase merging).
  - Accepting all hunks yields `replace`; accepting none yields `find`.
  - Accepting a subset and then the rest equals accepting all.
  - Accepting any set of hunks in any order gives the same text.
- **Counterexample means:** what you accept differs from what you were shown.

### W2. Proposal validation (design invariant 8) — active

`tests/core/review.property.test.ts`

- **Generator:** `propose_edit` arguments with `find` strings that occur zero times, once or several times; overlapping and adjacent edits; empty `find`; no-op edits; paths outside the context, excluded, missing or malformed; and garbage arguments.
- **Property:** a proposal is created only if the path is editable (in context) and every edit's `find` occurs exactly once in the note's current text, with no two edits overlapping and at least one real change. Otherwise the model gets a tool error and no proposal exists. Valid proposals' hunks reproduce the model's edits exactly.
- **Counterexample means:** a proposal points at the wrong place, or at a note the model was never given.

### W3. No write without accept (design invariant 3; stateful) — active

`tests/core/review.property.test.ts`, `fc.commands`

- **Generator:** the edit world, plus random sequences of proposals (valid and adversarial), accept, reject, accept all, reject all, user typing anywhere in a note (including inside a hunk's passage), reverts from the AI history, `propose_note` cards (create or dismiss), and renames.
- **Property:**
  - The vault changes only on accept, create or revert actions.
  - Each change replaces exactly one hunk's `before` with its `after` (or the reverse, for a revert) at a single location, and every other character of the note is untouched.
  - A hunk whose passage no longer matches exactly once is reported as a conflict and changes nothing.
  - An accepted or rejected hunk can't be applied again.
- **Counterexample means:** the vault changed without the user's say-so, or by more than they accepted (hard rule 1).

### W4. Undo safety (design invariant 6) — active

`tests/core/review.property.test.ts`

- **Generator:** accepted hunks, then random user edits (none, elsewhere, touching the hunk, deleting it), then a revert.
- **Property:** with no edits since, a revert restores the earlier text exactly. Otherwise it either reverses that one hunk where its surroundings still identify it uniquely, or reports a conflict and changes nothing. It never corrupts the surrounding text.
- **Counterexample means:** undo damages the note.

### W5. History completeness (design invariant 7) — active

`tests/core/review.property.test.ts`

- **Property:** the AI edit log only ever grows. Every accepted hunk, created note and revert has exactly one entry, and it is filed under the note's id. That id follows renames, so a renamed note keeps its history. Clearing (per note or all) removes exactly what was asked, and only that.
- **Counterexample means:** an AI edit happened with no record, or a record went missing.

### W6. `propose_note` creates only what was approved — active

`tests/core/review.property.test.ts`

- **Generator:** random proposed paths: new, existing, excluded, hidden, `..`, not Markdown, overlong; random content.
- **Property:** a note card exists only for a new, allowed Markdown path. The note is created only by Create, with exactly the proposed content. Reverting a created note moves it to the trash only if its text is unchanged since; otherwise it reports a conflict.

### G8. Only ReviewController writes, and only these ways — active

`tests/lint/review-controller.test.ts`

- **Property:** `src/obsidian/ReviewController.ts` writes only through `vault.process`, `vault.create`, `fileManager.trashFile` and `editor.replaceRange`, and every one of those calls sits inside a method reached from an accept, create or revert action. This is checked by reading the source, as a backstop to G3.

### Checked in a real Obsidian (milestone 5)

On 2026-11-26, in a separate instance, with `qwen3.8:27b` proofreading `fixtures/vault/Drafts/Essay.md`:

- **Tools offered:** `fetch_page`, `propose_edit` and `propose_note` (search was off).
- **The proposal:** three hunks, each with its reason: the doubled "The the", "it's … their" → "its … there", and "fourty" → "forty". The file on disk was unchanged before any click.
- **Accept and reject:** accepting the first hunk and rejecting the second changed the file to exactly the original with "The the lighthouse" → "The lighthouse". The note was open, so the change went through the editor.
- **History and revert:** the AI edit history showed the change, and Revert restored the file byte for byte. The log kept both entries.
- **New note:** `propose_note` showed a card. No file existed until Create, and then the file held exactly the proposed text.

Note for future runs: the test instance had a stray Obsidian Settings window open, and Obsidian opens modals in the focused window. Close it, or focus the main window, before checking for modals.

## Starting list from the design doc (planned)

These come from `docs/DESIGN.md` § Testing. Each gets a full generator, property and counterexample entry when its milestone starts.

1. **Context containment:** active for milestone 3's sources as X2; extended to `request_context` and attachments in M7.
2. **Backlink lists carry no content:** active as X3.
3. **No write without accept:** active as W3.
4. **Hunk algebra:** active as W1.
5. **Rebase honesty:** planned (M6).
6. **Undo safety:** active as W4.
7. **History completeness:** active as W5.
8. **Proposal validation:** active as W2.
9. **Caps hold:** active as T2.
10. **Lockdown flags are unconditional:** planned (M10, M11).
11. **Preset parsing is total:** planned (M8).

Also from the design: **link-depth preview matches what is sent**, active as X4.

---

## Known limits of the static gates

The lint gates catch every *ordinary* way of reaching the vault: dot access, computed access with a literal key, destructuring, and imports. They do not catch deliberate obfuscation, such as computing the property name at runtime, reading note text out of the DOM, or `Reflect.get`. That is why each hard rule also has a behavioural property test (invariants 1–3 above), which checks what actually leaves the plugin rather than how the code is written. `eval` and `new Function` are banned outright.
