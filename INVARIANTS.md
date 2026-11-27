# Lektor invariants

Each invariant names its **generator** (what random inputs we throw at it), its **property** (what must hold for every one of them), and what a **counterexample** would mean. Every invariant is a fast-check property test; the test file is named next to it. Runs: 100 cases locally, 1,000 in CI (`npm run test:ci`). A failing seed becomes a regression unit test in the same folder, named after the seed.

Status: **active** means a property test exists and runs; **planned (Mn)** means it lands with milestone *n*.

Stateful tests use `fc.commands(…, { size: 'large' })`. With the default size, fast-check generates runs of about five commands (ten at most in 100 runs), too short to reach states that need four specific steps in a row. A surviving mutant in the session test showed this.

Every invariant's test has been mutation-checked: each guard in the code was removed in turn, and the test had to fail. Mutants that survived led to stronger generators or extra tests. The remaining survivors are equivalent (redundant code that changes no behaviour).

Regression tests from failing seeds or surviving mutants so far: `tests/core/settings.test.ts` › "does not let an unreadable list become readable through serialisation" (a mutant of the S5 guard survived the property tests because JSON never produces such a value from disk); "normalises -0 to 0, on load and on update" (S2, seed 1865398749 in a CI-strength run: `-0` was stored as `-0` but saved as `0`). `tests/core/ndjson.property.test.ts` › "returns exactly JSON.parse of each line, -0 included" (N1, seed 316671435: the test's model compared against the in-memory `-0` instead of what JSON puts on the wire; the decoder was right). `tests/core/ollama.property.test.ts` › "sends tool-call arguments as JSON (so -0 becomes 0)" (O2, full-suite run, seed not captured: the same `-0` model mistake, in tool-call arguments). `tests/core/review.property.test.ts` › "reverting a change that emptied the note puts the text back" (W3–W5, seed -1474712944: correct behaviour; the checker treated the empty anchor of an emptied note as "not found"). `tests/core/rebase.property.test.ts` › "accepting one hunk cannot make another ambiguous after the user edited the note" (B1, CI-strength run: a real bug; rebase now re-places every hunk whenever the note changed outside the review); "without the previous text, a passage that now appears twice is dropped, never guessed" and "without the previous text, two hunks that would now overlap keep only the first" (two mutants of the context-search fallback survived the properties). `tests/core/attachments.property.test.ts` › "reads a 1 × 1 lossless WebP, which is only 25 bytes" (A2, seed -1506384488: a real bug; the WebP check demanded 30 bytes for every variant). Its generator caps lossy WebP at 16,383 pixels a side (seed 231711628: the format can't express 16,384). Three mutants survived the first milestone 7 properties because a second check backed them up, so each guard now has its own test: the size limit ("a file is sendable only within its converter's size limit", "the limit holds for the bytes actually read"), the read-time exclusion re-check ("an attachment excluded after the index was built is refused at read time"), and the session's filter on ticked ids (`tests/core/share.session.test.ts` › "the session passes on only ticked ids that were offered").

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
- **Since milestone 6 (inline review):**
  - ReviewController's editor transactions carry effects only (decorations), never changes.
  - The inline ✓, ✕, Accept all and Reject all call the `clicks` handlers only from button click handlers.
  - Those handlers, in `src/obsidian/InlineReview.ts`, are the only code there that calls accept, and `main.ts` hands them only to ReviewController.
  - `main.ts` constructs ReviewController once, gives it to the ReviewManager as its applier, and otherwise uses it only to read the open editor's text and register inline review.

### Checked in a real Obsidian (milestone 5)

On 2026-11-26, in a separate instance, with `qwen3.8:27b` proofreading `fixtures/vault/Drafts/Essay.md`:

- **Tools offered:** `fetch_page`, `propose_edit` and `propose_note` (search was off).
- **The proposal:** three hunks, each with its reason: the doubled "The the", "it's … their" → "its … there", and "fourty" → "forty". The file on disk was unchanged before any click.
- **Accept and reject:** accepting the first hunk and rejecting the second changed the file to exactly the original with "The the lighthouse" → "The lighthouse". The note was open, so the change went through the editor.
- **History and revert:** the AI edit history showed the change, and Revert restored the file byte for byte. The log kept both entries.
- **New note:** `propose_note` showed a card. No file existed until Create, and then the file held exactly the proposed text.

Note for future runs: the test instance had a stray Obsidian Settings window open, and Obsidian opens modals in the focused window. Close it, or focus the main window, before checking for modals.

## Milestone 6: Inline review, staleness and Prose mode

### B1. Rebase honesty (design invariant 5) — active

`tests/core/rebase.property.test.ts`

- **Generator:** the edit world's proposals, some hunks accepted or rejected, then random user edits (typing, deleting, pasting copies, rewriting whole passages), then a rebase.
- **Properties:**
  - Every previously pending hunk is either kept (pending, and locatable now) or dropped (with a reason). The dropped list is exactly the pending hunks minus the kept ones.
  - Kept hunks change the same text into the same replacement as before.
  - Decided hunks are untouched.
  - A dropped or stale hunk can never be applied.
  - With no user edits, a rebase is the identity: nothing is dropped.
  - After a rebase, accepting the kept hunks in any order writes each one exactly.
  - When the text the review last saw is known (kept in memory, never stored), positions carry through the change exactly: a hunk the change didn't touch lands where the change moved it, and a hunk it touched is dropped. Without that text, each hunk is searched for by its surrounding text, which must occur exactly once.
  - The one exception (found in milestone 8): an insertion left with none of the model's own text beside it has nothing to anchor on. It is dropped ("nothing is left to anchor it on"), never kept unplaceable.
  - A rebase stores only the model's own text (its edits, with accepted hunks applied), never the user's newer note text (H5). Repeated rebases keep at most one edit per hunk.
- **Counterexample means:** the panel lies about what survived, a hunk lands somewhere the user didn't see it, or chat history picks up note text the model never wrote.

### B2. The staleness dot tells the truth — active

`tests/core/rebase.property.test.ts`

- **Property:** a proposal's stale hunks are exactly its pending hunks that cannot be located in the note's current text. The dot is neutral exactly when there are none.

### B3. Automatic rebase is lossless — active

`tests/core/rebase.property.test.ts`, and the W3 stateful run (`tests/core/review.property.test.ts`), which now also checks notes and rebases

- **Properties:**
  - When a note changes, Lektor rebases a proposal by itself only if no hunk would be dropped. Otherwise it leaves the proposal untouched and reports its stale hunks.
  - After any rebase, accepting kept hunks still writes exactly those hunks, at one place each (W3 holds through rebases).

### B4. Inline marks match what would be applied — active

`tests/core/rebase.property.test.ts`

- **Property:** the inline marks for a note are exactly its locatable pending hunks. Each mark's range is inside the text, covers exactly the hunk's `before` text, and offers exactly its `after` text.
- **Counterexample means:** what you see marked in the editor is not what ✓ would do.

### B5. Prose mode proposes nothing — active

`tests/core/tools.property.test.ts`

- **Property:** for a chat in Prose mode, no request offers `propose_edit` or `propose_note`, and no fenced-edit instructions are added, whatever the model or context. The Prose instruction is sent instead (also checked through a real session in `tests/core/toolloop.property.test.ts`).

### B6. Undo and redo in the editor move the card with them (stateful) — active

Added after milestone 7, to close the gap where Ctrl+Z took an accepted change out of the note but its card still said "Accepted".

`tests/core/undo.property.test.ts`, `fc.commands`, plus the W3 stateful run (where it must not disturb W3–W5).

- **Rule:** the review remembers each accept in memory (never stored): the note's text just before it, the last text it knew before that, the text just after it, and the proposal as it was on each side. The editor reports every undo and redo step to it at once; typing may be reported late.
  - **Undo:** when the note's text becomes exactly one of the texts it had before an accept it still has, that accept and every later one in the note are undone. Their hunks go back to pending, with the proposal as it was before each accept.
  - **Redo:** when the note's text becomes exactly the text right after an undone accept, it is redone, together with the undone accepts before it. Its hunk goes back to accepted, with the proposal as it was right after. An accept undone before some later accept can't be redone this way, because that later accept was made without it.
  - **The card follows when its chat is open:** a chat that isn't open catches up the moment it opens.
  - **The log stays truthful:** an undo is logged as a revert of that accept, and a redo as a new accept, both marked as such. A revert from the AI history that already logged the reversal isn't logged twice.
  - **Hard rule 1 is unaffected:** none of this writes to the vault. It changes only what the card says and what the log records.
- **Generator:** the edit world in an editor-like fake with a linear undo history. Each change (accept, typing, paste) is one undo step; occasionally an accept joins the unreported typing before it, as CodeMirror groups quick adjacent changes. Two chats share the notes. Random sequences of propose, accept, accept all, reject, typing, undo, redo, a late report of typing, and switching chats.
- **Properties:**
  - **Soundness:** a hunk's card goes from Accepted to Pending only when the note's text is exactly one of that accept's before-texts, and from Pending (or Rejected) to Accepted only when it is exactly the text right after that accept or a later one.
  - **Exactness:** a hunk that went back to pending, accepted again from the same text, writes exactly what its first accept wrote.
  - **Decisions survive:** a hunk the user rejected, or a rebase dropped, keeps that status through undo and redo of other hunks.
  - **The log matches the card:** for every hunk, its accepts minus its reverts in the log is 1 if the card says Accepted and 0 otherwise.
  - **Completeness, with nothing but accepts, typing, undo and redo:** after undoing k steps, exactly the accepts in those steps are pending again, and after redoing j of them, exactly those are accepted again.
- **Counterexample means:** the card says a change is in the note when Ctrl+Z took it out, or the other way round; or the AI history disagrees with the card.
- **Known limit:** an undo that doesn't land exactly on a text the review knew from before the accept leaves the card as it is. For example, if the accept joined a run of typing that was never reported, the undo lands on text the review never saw. The card then says Accepted, exactly as before this fix.
- **Regressions:** seed 757111334 was a mistake in the test's model (it let an accept join typing the review never saw); it is now the known-limit test. Mutation testing (14 mutants of the following code, all killed) added the cases where a note is restored on disk in one go, skipping the steps in between (both accepts out, both back, only the later one out), an undone accept in a chat that isn't open, and undo after a rename.

**Checked in a real Obsidian (B6):** on 2026-11-26, in a separate instance, with `qwen3.8:27b` proofreading `Drafts/Essay` in Inline mode (four hunks):

- **Accept:** ✓ in the editor changed the text, and the card went to "3 of 4 to review".
- **Ctrl+Z:** the text matched the original exactly, the mark came back, and the card and pill read "4 of 4" / "4 pending". This confirmed that Obsidian's undo arrives as a CodeMirror `undo` event.
- **Ctrl+Shift+Z:** the hunk was accepted again, with the text exactly as after the first accept.
- **Undo, then ✓ again:** this wrote the same text as the first accept.
- **The AI history** listed, oldest first: Accepted, Undone in the note, Redone in the note, Undone in the note, Accepted. The undone accepts showed "Reverted", and the latest showed Revert.

The user's own Obsidian profile was unchanged.

### Checked in a real Obsidian (milestone 6)

On 2026-11-26, in a separate instance, with `qwen3.8:27b` proofreading `fixtures/vault/Drafts/Essay.md` in a new chat, which started in Inline mode:

- **Inline:** three marks in the editor ("the " deleted; "it's keepers lived their" → "its keepers lived there"; "fourty" → "forty"), each with ✓ / ✕. The pill read "3 pending · Accept all · Reject all". The sidebar card was the folded summary. Disk and editor were unchanged.
- **Typing elsewhere** (" (draft)" after the heading): the same three marks, and the dot stayed neutral. This was the silent lossless rebase.
- **✓ in the editor:** the editor changed exactly "The the lighthouse" → "The lighthouse", and the pill went to 2 pending.
- **Typing inside a hunk** ("keepersX"): that mark disappeared, and both dots (pill and card) turned amber. The pill's dot opened the card's panel. Rebase reported "1 change kept. 1 dropped" and named the dropped change and its reason. Afterwards "fourty" was still marked, with a neutral dot.
- **Sidebar diff:** the editor marks went away, and the card showed all three hunks.
- **Prose:** the next request offered only `web_search` and `fetch_page`, and carried the Prose instruction as a system message. No marks were shown.

## Milestone 7: `request_context` and attachments

Shared generator, the **attachment world**: the X2 random vault, now with attachments beside the notes. Text attachments (`.txt`, `.csv`, `.json`, …) carry their own sentinel; images are tiny valid PNG, JPEG or WebP files whose bytes carry a sentinel; there are also files no converter handles (`.pdf`, `.mp3`, `.canvas`), files too large for their converter, invalid images, and attachments inside excluded folders. Notes link to attachments at random. Models with and without vision.

### A1. Context containment, attachments part (design invariant 1; stateful) — active

`tests/core/attachments.property.test.ts`, `fc.commands`

- **Generator:** the attachment world, and random sequences of context actions: everything X2 does, plus add or remove an attachment chip, remove (withhold) an Upfront attachment chip, switch the chat's attachment mode (Ask, Allowed, Upfront, or back to the setting), change the global mode, and flip the model's vision. After each action the context is assembled exactly as a request would be.
- **Model:** an attachment is *in context* if it has a chip, or if the mode is Upfront, a note whose content is in context (the X2 model) links to it, and the user has not withheld it. It is *sent* if it is in context, not excluded, has a converter, fits that converter's size limit, converts cleanly, and is not an image going to a model without vision.
- **Property:**
  - The request (context message plus images) contains an attachment's sentinel **if and only if** the model says it is sent. Text attachments are in the context message; images go only in the images list, as base64 of the exact bytes.
  - Every attachment that is in context but not sent is listed as skipped, with a reason, and nothing else is.
  - No excluded attachment is ever read, listed, counted as sendable or sent.
  - In Ask and Allowed modes, notes in context list the attachments they link to by path only (excluded ones left out), and none of their content.
  - The manifest lists exactly the sent attachments, with the hash of their bytes.
- **Counterexample means:** a file the user didn't give the model, or one in an excluded folder, reaches it; or one the user did give it is silently dropped.

### A2. Converters are exact, and the path is open — active

`tests/core/attachments.property.test.ts`

- **Generator:** random byte strings and random valid files of each built-in type, with random-case extensions; plus a test converter registered at run time for a new extension (standing in for a later PDF-to-text converter).
- **Properties:**
  - The text converter returns exactly the file's UTF-8 text, or fails for bytes that are not valid UTF-8. It never returns altered text.
  - The image converter accepts only files whose bytes really are PNG, JPEG or WebP with readable dimensions, whatever the extension claims. It returns the exact bytes in base64 with the right media type, and a token estimate that grows with the pixel count, between its floor and its cap.
  - Converter lookup ignores extension case and picks exactly one converter or none. A file with none is skipped with a "no converter" reason, never sent raw.
  - Registering a converter for a new extension makes those files sendable through the same path (chips, Upfront, `request_context`) with no other change: text output joins the context message, image output joins the images list.
- **Counterexample means:** a file reaches the model altered or mislabelled, or binary junk is sent as text.

### A3. `request_context` shares only what the user approved (stateful) — active

`tests/core/request.property.test.ts`, `fc.commands`

- **Generator:** the attachment world, a random context, a random attachment mode, and random `request_context` calls: notes by path or title (existing, missing, excluded, ambiguous), "linked from X to depth N", folders (recursive or not, excluded), title searches, attachments by path or file name, garbage arguments, and requests that match more than 20 files. Each is answered by a random approval: deny, approve all, approve a random subset, or answer with ids that were never offered. Stop can interrupt the card.
- **Properties:**
  - The card lists at most 20 items, never an excluded one, and never one already in context. A request matching more than 20 shows no card, reads nothing and returns an error asking the model to narrow it.
  - Nothing is read before the user answers, except Allowed-mode grants.
  - What the model receives contains an item's sentinel **if and only if** the user ticked it, or it was granted without a prompt. A grant without a prompt happens only in Allowed mode, only for an attachment linked from a note already in context, and never for one the user withheld.
  - Ids the user never saw are ignored.
  - Denying, ticking nothing and "nothing matched" give the model the same answer, so it learns nothing about notes it wasn't given.
  - Shared items become chips: exactly the approved ones.
  - The tool result saved in chat history names the shared paths and contains no sentinel.
- **Counterexample means:** the model can read, or learn about, notes and files the user didn't approve (hard rule 2).

### A4. Shared items flow through the session — active

`tests/core/share.session.test.ts` (a real session, tool run and `request_context`, with random approvals, vision and full-transcript settings) and `tests/core/history.property.test.ts` (H4, H5)

- **Properties:**
  - In the same reply, the round after an approval carries the shared text in its tool result exactly once, and shared images in one user message right after the tool results.
  - The reply's manifest includes every note and attachment shared during the reply, so deleting one later still finds the chat.
  - The approved notes may be proposed edits to in the same reply.
  - From the next message on, the shared items reach the model through the context message (they are chips), and the saved tool result holds only paths. With "store full transcripts" on, the shared text can be recovered exactly.
  - Every round, images included, passes the C6 budget check.
- **Counterexample means:** shared material goes missing, is sent twice, overflows the window silently, or survives in history after the note is deleted.

### O2 (extended in milestone 7)

A message carries Ollama's `images` field (base64, in order) only when it has images, and every other message is still exactly `{role, content}`. Images reach a request only for models that report the `vision` capability (A1).

### Checked in a real Obsidian (milestone 7)

On 2026-11-26, in a separate instance, with `qwen3.8:27b` (which has vision), on a copy of `fixtures/vault`. The fixture vault now has a legible image embedded in `Drafts/Essay`, a CSV linked from `Reference/Sources`, and an image in the excluded `Private/` folder, also embedded in the essay.

- **Ask (the setting):** the first request offered `request_context`, listed `attachments/diagram.png` under the essay by path only, and sent no image. `Private/scan.png` was never listed or sent; it was only counted ("2 excluded items skipped"). That also confirmed that Obsidian's `resolvedLinks` includes links to attachments.
- **Sharing:** the model called `request_context`. The card listed the image with its estimate, all ticked. After "Share all", the next request carried the tool result naming the image and one user message with the image right after it. The model described "a red conical lighthouse … with the text BELL ROCK 1811". The image became a chip.
- **Upfront (paperclip, this chat only):** adding `Sources` brought `keepers.csv` in as a dotted chip of its own. The request carried the CSV's text, and the model answered "7731". Removing that chip kept the CSV out of the next request, which listed it by path only.
- **Deny:** asking for "Chain A" and `Private/Diary.md` produced a card listing only `Reference/Chain A.md`. On Deny, the model got the standard "did not share anything" answer.
- **Allowed:** in a new chat, the linked image was shared without a card, and the model read "BELL ROCK 1811". The reply showed "Asked for context: shared 1 item".
- **History:** the saved chat's tool results held paths only, and the manifests listed the shared image and the CSV. No `PRIVATE-SENTINEL` appeared in any request.

The user's own Obsidian profile was unchanged before and after.

## Milestone 8: Presets

Decisions (2026-11-26, before milestone 8):

- **Where preset files live:** `<plugin folder>/presets/*.md`, through PluginStorage (a new `presets` namespace). This replaces `.lektor/presets`, so hard rule 2 needs no new exception. The plugin folder is also a dot-folder inside the vault, so it is just as hidden and travels with the vault the same way.
- **Running a preset:** it adds the next message to the chat that is open. Its prompt, tools, caps and model apply to that one reply.
- **Built-ins:** they live in code, so they improve with updates. Saving an edited built-in writes a file with the same id, which takes precedence. "Reset to built-in" deletes that file, and a setting hides a built-in.

Shared generator, the **preset world**: preset files made of random bytes, near-misses of valid frontmatter (missing fences, unknown fields, bad enums, tabs, CRLF, BOM, quotes left open, duplicate keys, lists in both styles) and valid presets with random Unicode prompts.

### PR1. Preset parsing is total (design invariant 11) — active

`tests/core/presets.property.test.ts`

- **Generator:** the preset world.
- **Properties:**
  - Parsing any text returns either a preset or an error message for that file. It never throws.
  - For every valid preset, parsing its serialised form gives back exactly the same preset. Serialising again gives the same text.
  - What Lektor writes is valid YAML frontmatter: every field it writes reads back with the same value, and the body is the prompt byte for byte.
  - Loading a folder of files gives each file exactly what parsing it alone gives. One broken file never changes another, and a broken override shows its error instead of the built-in.
  - Built-ins are always listed unless hidden, and an override replaces exactly the built-in with its id.
- **Counterexample means:** one bad preset file breaks Lektor or another preset, or saving a preset changes it.

### PR2. A preset run sends exactly its preset (stateful) — active

`tests/core/presetrun.property.test.ts`, through a real session, tool run and fake provider

- **Generator:** random presets (each output kind; with or without web tools, caps, a model of their own and a display mode), random plain messages in between, regenerate and stop, the globe on or off, a search provider set or not, models with and without native tool calling, and each display mode.
- **Properties:**
  - **The prompt:** a preset reply's every request carries its prompt in exactly one system message. Requests for plain messages before or after it carry no preset prompt. Regenerate sends the same prompt again (the saved snapshot, even if the preset changed since).
  - **Findings output:** offers `report_findings` and never `propose_edit` or `propose_note`.
  - **Edits output:** offers `propose_edit` exactly when a plain message would (an editable note is in context, and the chat is not in Prose mode).
  - **Chat output:** offers neither.
  - **Web tools:** only those the preset lists, and only if they would be available anyway (the globe on, and a search provider set up for `web_search`). The preset's caps replace the global caps for that reply only.
  - **Models without native tool calling:** findings presets get the fenced `lektor-findings` instructions instead.
  - **The model:** a preset's own model is used for that reply, and the chat's model is unchanged afterwards.
- **Counterexample means:** a preset leaks into other messages, or gets tools it shouldn't.

### F1. Findings point at real text — active

`tests/core/findings.property.test.ts`

- **Generator:** the edit world's notes, and `report_findings` arguments with quotes that occur once, several times or not at all, as well as paths outside the context or excluded, sources with known and unknown URLs, and garbage arguments. It also covers fenced `lektor-findings` blocks.
- **Properties:**
  - A findings set exists only for a note in this reply's context.
  - Each stored finding's quote occurs exactly once in the note's text at report time, at its stored position. The rest are refused, and the tool result names them so the model can send longer quotes. If none fit, the model gets a tool error and nothing is stored.
  - A source is shown as a link only if its URL is known to the chat (search results, fetched pages, the user's messages, attached notes). Otherwise it is shown as plain text and can't be clicked.
  - Reporting findings never writes to the vault.
- **Counterexample means:** a highlight points at the wrong passage, or a model-made URL becomes a link the user might click.

### F2. Highlights match the findings — active

`tests/core/findings.property.test.ts`

- **Generator:** findings sets, then random user edits to the note (none, elsewhere, inside a quote, pasting a copy of a quote), and dismissals.
- **Property:** an open finding is highlighted exactly on its quote. If the note is unchanged since the report, the highlight is at the stored position. Otherwise it appears only where the quote occurs exactly once, and never anywhere else. Dismissed findings are never highlighted.
- **Counterexample means:** the highlight in the note isn't the passage the finding is about.

### H6. Findings and preset runs in history — active

`tests/core/history.property.test.ts`

- **Property:** findings sets (status included), the preset snapshot on a user message, and the link from a tool result or a fenced reply to its findings all survive a save and a load. A file with a malformed finding loses only that chat, as for H1.

### Regressions (milestone 8)

- **PR1, YAML agreement:** two real divergences from YAML, each now a unit test.
  - A value starting with "- " (YAML reads a list) was read as text.
  - A comment right after a quoted value or a list, without a space (`"A"#x`, which YAML rejects), was accepted.
- **B1 seed -1905239307, a real bug from milestone 6:** the user deleted the text just before an insertion at the end of the note, so none of the model's text was left beside it. The rebase "kept" it with an empty anchor, so it could never be placed or applied. It is now dropped with its reason, and B1 and B3 allow exactly that case.
- **B1 seed 1504067721, a mistake in the test:** a model edit that changes nothing (`the` → `the`) has no hunk, so a proposal untouched by any rebase can have more edits than hunks. The "at most one edit per hunk" bound now applies only once a rebase has rewritten the proposal.
- **Mutation testing:** 20 mutants of the preset, findings and tool-run code, all killed. One, ignoring hidden built-ins, survived until a test of the library over storage was added.

These three only showed up after hundreds of 1,000-case runs.

### Checked in a real Obsidian (milestone 8)

On 2026-11-26, in a separate instance, with `qwen3.8:27b` on a copy of `fixtures/vault` (DuckDuckGo as the search provider). The stored version-4 settings migrated to version 5.

- **Entry points:** a new chat showed the three sample actions. The preset row had Proofread, Garden paths and Fact-check; the sidebar was under 320 px, so icons only. The command palette had `lektor:preset-proofread`, `-garden-paths` and `-fact-check`.
- **Proofread (sample action):**
  - **The request:** it offered only `report_findings` and `request_context`, carried the proofread prompt as a system message, and the user turn was "Run the “Proofread” preset on the notes in the context."
  - **Findings:** the doubled "The the", "their" → "there", "fourty", a missing "that", and, in a second call, "it's" → "its". Each appeared as a card and as dotted highlights in the note.
  - **On the findings:** clicking a quote selected exactly that passage in the note. Hovering a highlight showed its card with Suggest fix and Dismiss, and dismissing one removed its highlight.
- **Suggest fix:** it sent "Suggest a fix for this doubled-word in Drafts/Essay.md: “The the lighthouse …” … Use propose_edit, changing only that passage." The request had `propose_edit` and no preset prompt. The model proposed the edit, which showed as an inline mark.
- **Slash command:** typing `/gar` offered `/garden-paths`, and Tab completed it. The request carried only the garden-path prompt, not Proofread's. It found the three planted garden-path sentences, each with its misreading explained.
- **Fact-check:**
  - **The request:** it offered web search and page fetching. Over four rounds it searched three times (two DuckDuckGo searches failed), fetched one page, and its second fetch hit the preset's cap.
  - **What it found:** "Robert Louis Stevenson designed the Skerryvore lighthouse himself" was marked wrong (it was Alan Stevenson), and so was "The Eiffel Tower was completed in 1899" (it was 1889).
  - **Sources:** all three source URLs came from its searches, so all three were links.
- **Globe off:** the Fact-check button turned amber, with the "No web search — …" tooltip. Clicking it showed the confirmation, and Cancel sent nothing.
- **Settings:**
  - **Files written by hand:** after Reload, the list showed `tone.md` ("Tone check · Yours · /tone · Chat") and `broken.md` with "This file can't be used: Line 3: "bogus" is not a preset field …".
  - **Hiding a built-in:** turning Garden paths off removed it from the preset row and the command palette, and `data.json` recorded `presets.hidden: ["garden-paths"]`.
  - **The hand-written preset:** `/tone` ran it, and the message showed its badge.
- **History:** the saved chat kept the four preset snapshots and the findings sets, the dismissed finding included.

Note for future runs: Obsidian opens Settings in a separate window here (`activeDocument !== document`), so look for settings elements in `activeDocument`.

The user's own Obsidian profile was unchanged before and after.

## Milestone 9: OpenAI- and Anthropic-compatible adapters

Decisions (2026-11-26, before milestone 9):

- **Keys:** any number of named endpoints, each of kind OpenAI- or Anthropic-compatible, at any http(s) URL. An endpoint may name an Obsidian secret holding an API key. The key is read only when a request is sent, and is never stored in Lektor's settings or chats.
- **Raw HTTP:** both adapters speak their protocol directly, through `Http.ts` (the network gate is unchanged), with no SDK.
- **Capabilities:** each endpoint has settings for context length, tool calling, images and (Anthropic) output limit. What the server reports wins: Anthropic's `max_input_tokens` and `image_input`, vLLM's `max_model_len`, LM Studio's `/api/v0/models`, llama.cpp's `/props`.
- **CORS:** replies stream through `fetch`. If the request fails before any response arrives (a server that doesn't allow Obsidian's origin), Lektor sends it once through Obsidian's `requestUrl`, which isn't subject to CORS but doesn't stream. The reply then arrives all at once, with a notice saying why.
- **Claude's thinking:** the thinking blocks Claude returns with a tool call (signatures included) are sent back unchanged in that turn for the rest of the reply. They are kept in memory only, and later messages start without them.

Shared generator, the **wire world**: random `ChatRequest`s (system messages anywhere, user messages with and without images, assistant turns with text and tool calls, tool results, Unicode everywhere) and random valid SSE streams of each protocol (text, reasoning or thinking, tool calls whose arguments arrive in random fragments, parallel tool calls, usage, every stop reason, error events, pings and comments), cut into random chunks with LF or CRLF line ends.

### E1. Every stream ends exactly once (both adapters) — active

`tests/core/compat.property.test.ts`

- **Generator:** the wire world's streams, plus a random HTTP status, error bodies, malformed `data:` lines, a stream cut off before its end, a thrown network error, and an abort after a random number of events.
- **Properties:**
  - The O1 contract holds: `stream()` never throws, and yields events then exactly one `done`, last.
  - The text, reasoning and tool calls yielded are exactly what the server sent, whatever the chunking. Each tool call's arguments are the concatenated fragments, parsed as JSON (or left as the string if they aren't JSON, for the registry to reject).
  - Stop reasons map faithfully. A finished reply, including one that ends in tool calls, is `stop`. A cut-off one is `length`. Claude's `refusal` becomes an error, never a silent success. A stream that ends without its final event is an error.
  - Usage reports the server's numbers. For Anthropic, input counts the cached tokens too, so calibration sees the whole prompt.
- **Counterexample means:** a reply hangs, is shown complete when it wasn't, loses or garbles text, or runs a tool call the model never finished.

### E2. Requests carry exactly the conversation, only to the endpoint (both adapters) — active

`tests/core/compat.property.test.ts`

- **Generator:** the wire world's requests × random endpoint settings (base URL, key or none, limits).
- **Properties:**
  - **Where requests go:** only to the endpoint's own URLs. For OpenAI-compatible endpoints that is `<base>/chat/completions` and `<base>/models`, plus LM Studio's and llama.cpp's info URLs on the same server. For Anthropic-compatible endpoints it is `<base>/v1/messages` and `<base>/v1/models`.
  - **The key:** if set, it appears only in the auth header (`Authorization: Bearer` or `x-api-key`), never in a URL or a body. With no key, there is no auth header.
  - **OpenAI shape:** every message keeps its role, content and order. An assistant turn's tool calls carry their ids, and each tool result answers its call's id. Images are sent only in user messages, as `data:` URLs of the exact base64.
  - **Anthropic shape:** every system message, in order, goes into the top-level `system`. Messages alternate correctly: tool results become one user turn of `tool_result` blocks, answering their `tool_use` ids, with any images of that round after them. Text and images are exact.
  - **Thinking replay:** Claude's signed thinking blocks from earlier rounds of the same reply come back unchanged, before their turn's `tool_use` blocks, and nowhere else.
  - **Nothing extra:** neither shape includes anything the user or Lektor didn't put in the conversation.
- **Counterexample means:** data reaches a host the user didn't configure, a key leaks, or the model is sent a different conversation from the one shown.

### E3. The key stays out of storage — active

`tests/core/compat.property.test.ts` and `tests/core/settings.property.test.ts`

- **Property:** settings hold only the secret's name, never a key. A key never reaches the settings file, chat history, notices or error messages, even when the server echoes the request or its error body contains the key.
- **Counterexample means:** a key ends up in `data.json` or a chat file, which may be synced or shared.

### E4. Falling back to requestUrl never sends twice — active

`tests/core/compat.property.test.ts`

- **Generator:** a primary client that fails before responding, fails after starting a response, succeeds, or is aborted; and a fallback client that does the same.
- **Property:**
  - The fallback is used only when the primary failed before any response, and not on an abort.
  - Once a response has started, nothing is retried.
  - After one fallback, that endpoint goes straight to the fallback client for the rest of the session.
  - The caller is told once that streaming is unavailable.
- **Counterexample means:** a request is sent to the server twice, or Stop starts a second request.

### S10. Endpoint settings — active

`tests/core/settings.property.test.ts`

- **Properties:**
  - Version-5 settings migrate to version 6 losslessly, with no endpoints.
  - Endpoint ids are unique, and any invalid endpoint is refused with a reason.
  - A stored endpoint list that can't be read loses only the bad endpoints, never the other settings.

### Regressions and mutation testing (milestone 9)

- **Seed 892126910 was a mistake in the test:** random tool arguments can contain the text "sig", which the E2 check took for leaked replay data. The check now looks for a distinctive marker.
- **Mutation testing:** 20 mutants of the adapters, the SSE decoder, the fallback client and the replay wiring, all killed. They covered:
  - tool-call names concatenated, unsorted calls, and a missing `[DONE]` accepted;
  - `reasoning_content` ignored, and refusals passed as success;
  - cached input left out of usage, and unsigned or tool-less thinking replayed, or replayed after `tool_use`;
  - same-role turns left unmerged, and an empty key header sent;
  - an output cap ignored, a CRLF split mishandled, and unscrubbed errors;
  - the fallback taken on abort, or not kept after it was taken.

### Checked in a real Obsidian (milestone 9)

On 2026-11-27, in a separate instance, with `qwen3.8:27b` served through Ollama 0.40.17's own OpenAI-compatible (`/v1`) and Anthropic-compatible (`/v1/messages`) APIs. These were set up as two endpoints, the OpenAI one with a key from SecretStorage. The stored version-4 settings with endpoints migrated to version 6.

- **Picker:** it listed "Ollama · qwen3.8:27b", "Ollama (OpenAI) · qwen3.8:27b" and "Ollama (Anthropic) · qwen3.8:27b".
- **Anthropic-compatible, Proofread:** three requests to `/v1/messages`.
  - **The request:** keys `model, max_tokens, system, messages, tools, stream`; the context and preset prompt as two top-level system blocks; tools `request_context` and `report_findings`; `max_tokens` 16384.
  - **Headers:** only `anthropic-version` among the auth headers (no key set), and no browser-access header (not anthropic.com).
  - **Round 2:** it sent `user:text, assistant:tool_use, user:tool_result`, and findings appeared.
- **OpenAI-compatible, with a key:**
  - The `Authorization` header was exactly `Bearer <key>`, and the body never contained the key.
  - It offered the usual tools, sent `stream_options: {include_usage: true}`, and streamed through `fetch` with no notice.
- **CORS fallback:** the page's `fetch` to `/v1/chat/completions` was made to fail before any response. Lektor sent the request once through `requestUrl`, the reply arrived whole, and it carried the notice "This server doesn’t allow Obsidian to stream replies (CORS)…".
- **Settings:**
  - Both endpoints were listed with their kind, address and key name.
  - "Test connection" on the Anthropic one answered "Connected to Ollama (Anthropic): 1 model (qwen3.8:27b)."
- **The key on disk:** absent from `data.json` and from every chat file. `data.json` kept only the secret's name.

The user's own Obsidian profile was unchanged before and after.

## Milestone 10: Claude Code bridge

Decisions (2026-11-27, before milestone 10; DESIGN.md § Decided):

- Claude Code searches and fetches with its own tools by default, and the chat says so. A setting switches fetching to Lektor's `fetch_page`, over MCP.
- Each run uses a fresh temp folder outside the vault.
- The spawner and MCP endpoint are Lektor's own code.
- Each reply runs one `claude -p` process.
- `--safe-mode` is replaced by `--setting-sources ""` and `--restricted`, because it also drops Lektor's MCP server.

Shared generator, the **bridge world**: random bridge options (model aliases, including hostile strings; globe on or off; preset web tools; fetch mode; the offered Lektor tools; paths with spaces and quotes), random Claude Code stream-json event streams (text and thinking deltas, its own WebSearch and WebFetch with results, MCP tool uses, denied tools, errors, `result` events of every subtype, a process that exits early, garbage lines), and random MCP requests.

### L1. Lockdown flags are unconditional (design invariant 10) — active

`tests/core/cli.property.test.ts`

- **Generator:** the bridge world's options.
- **Properties:**
  - **Present:** every argument list contains every lockdown flag: `-p`, stream-json in and out, `--verbose`, `--include-partial-messages`, `--no-session-persistence`, `--setting-sources ""`, `--restricted`, `--strict-mcp-config`, `--mcp-config <file>`, `--permission-mode dontAsk`, `--permission-prompts none`, `--disable-slash-commands`, `--tools …`, `--system-prompt-file <file>`, `--model <alias>`.
  - **Absent:** no forbidden flag or value ever appears: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `bypassPermissions`, `--add-dir`, `--settings`, `--plugin-dir`, `--plugin-url`, `--agents`, `--resume`, `--continue`, `--chrome`, `--safe-mode`, and the tools `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `Agent`, `Task`.
  - **Tools:** `--tools` names only `WebSearch` and `WebFetch`. `--allowedTools` names only those and `mcp__lektor__<tool>` for the Lektor tools offered.
  - **Web:** with the globe off there are no web tools. With Lektor fetching, there is no `WebFetch`.
  - **The model:** it must be an alias or a plain model name, or the run is refused.
  - **Nothing private in argv:** the arguments carry no conversation text, context, token or key. Those go in files and stdin.
  - A snapshot test pins the exact list.
- **Counterexample means:** a refactor dropped a lockdown flag, or Claude Code could get a file or shell tool (hard rule 2).

### L2. The lockdown self-test fails closed — active

`tests/core/cli.property.test.ts`

- **Generator:** random self-test event streams: a clean run, extra tools in the init event, another permission mode, other MCP servers, a tool use outside the allowed set, either canary token anywhere in the output (reply text, a tool result, a thinking delta), a process error or early exit.
- **Properties:**
  - The test passes only if all of these hold: the init event lists exactly the expected tools; the permission mode is `dontAsk`; the only MCP server is Lektor's; no tool outside the allowed set was used; neither canary appears anywhere in the output; and the run finished.
  - A pass is cached for 24 hours for that CLI version only, and a failure is never cached as a pass.
  - Until a test passes, no chat request is sent to Claude Code, and there is no override.
- **Counterexample means:** the bridge runs with a lockdown that wasn't proven (hard rule 2).

### L3. The run folder is the only place the bridge touches — active

`tests/core/cli.property.test.ts` (real temporary folders) and `tests/lint/cli-sources.test.ts`

- **Properties:**
  - **Where:** every file the bridge writes or removes is inside a folder it created with `mkdtemp` under the system temp directory, with the `lektor-` prefix. Only the names `void/`, `mcp.json`, `system.txt` and `canary.txt` are written. Paths with `..`, absolute paths and other names are refused.
  - **Afterwards:** the run folder is removed after every run, whether it finished, failed or was stopped, and when a waiting spare is discarded (L8).
  - **The void:** `void/` is empty when Claude Code starts.
  - **One module each:** the bridge never reads a file's contents. `fs`, `os` and `path` are imported only by `src/core/cli/fs.ts`, `child_process` only by `src/core/cli/spawn.ts` (never with a shell), and `http` only by `src/core/cli/mcp.ts`.
- **Counterexample means:** the bridge could read or change something outside its own temp folder, notes included.

### L4. The loopback MCP server answers only its run, and only with the offered tools — active

`tests/core/cli.property.test.ts`

- **Generator:** random HTTP requests (methods, paths, headers, a missing or wrong token, wrong Host or Origin) and random JSON-RPC messages (valid and malformed, unknown methods, batches, tool calls by name and with arguments).
- **Properties:**
  - **Who:** it listens on 127.0.0.1 only. It answers a request only if it carries the run's token, Host `127.0.0.1:<port>` and no Origin. Everything else gets an HTTP error and runs nothing.
  - **What:** `tools/list` lists exactly the tools offered for this reply. A call to any other tool is an error and runs nothing. Calls run one at a time, through the same registry, approvals and caps as every other backend.
  - **Bad input:** malformed input gets a JSON-RPC error, and the server never throws.
  - **Afterwards:** it is closed when the run ends.
- **Counterexample means:** another program on the machine could use Lektor's tools (show approval cards, propose edits), or Claude Code could run a tool the chat didn't offer.

### L5. Claude Code streams end exactly once — active

`tests/core/cli.property.test.ts`

- **Generator:** the bridge world's event streams, cut into random chunks, with stderr noise, exit codes, and Stop at a random point.
- **Properties:**
  - The O1 contract holds: events, then exactly one `done`, last.
  - Text and thinking are exactly the deltas Claude Code streamed.
  - Its own WebSearch and WebFetch uses are reported as tool activity, with the query or URL and the result's links, named as Claude Code's.
  - An error `result`, a non-zero exit or a missing `result` is an error.
  - Stop kills the process and yields `done: aborted`, after which nothing else happens.
- **Counterexample means:** a reply hangs, passes off a failure as an answer, or hides that Claude Code searched or fetched on its own.

### L6. A Claude Code reply goes through Lektor's review and approvals (session) — active

`tests/core/cli.session.test.ts`, a real session with a fake Claude Code process

- **Properties:**
  - Lektor tools Claude Code calls over MCP run through the same tool run as native tool calls. Their proposals and findings land in the chat, `request_context` and fetch approvals show their cards, and each call appears in the reply's steps, in order, between the text before and after it.
  - **The globe and presets:** the globe and a preset's web tools decide whether Claude Code gets its web tools.
  - **Fetch mode:** in Lektor-fetch mode `fetch_page` is offered over MCP and `WebFetch` is not.
  - **Stop:** it declines a waiting approval and ends the process.
  - **What the model sees:** exactly the visible transcript and the chips, as with every other backend (C1, X2).
- **Counterexample means:** Claude Code changes notes, reads context or fetches past Lektor's gates.

### L7. Claude Code prompts are complete and prefix-stable — active

Added after milestone 10, from a measurement on 2026-11-27. Five turns on haiku, with about 14k tokens of context:

- **Before:** sending the earlier turns as one changing block meant the cache never matched past the context. Every message wrote the whole history fresh (824 → 1,090 tokens per turn, growing).
- **With a long-lived process:** only the newest exchange was written.
- **Process start-up:** each per-message process cost about 0.5–0.7 s of overhead.

`tests/core/cli.property.test.ts`

- **Generator:** random visible transcripts: user turns, assistant turns with and without tool calls, tool results, Unicode, and text that looks like turn labels. With and without context images. Then one more exchange (an assistant reply and a new user message).
- **Properties:**
  - **Prefix-stable:** the stdin message's content blocks for the longer conversation begin with exactly the blocks for the shorter one. Claude Code caches up to the end of each request, so the next request reads the whole earlier conversation from the cache.
  - **Complete:** every visible turn appears exactly once, in order, as its own block, with its exact text. The last block is the newest user message, and nothing else is added.
  - **The system prompt is constant:** Lektor's fixed instructions only, never the context or the transcript. It stays cached, and a process started ahead of time is never stale (L8).
  - **Lektor's own blocks have fixed places** (since the warm spare): the system messages that come before the conversation (the context, and the Prose-mode instruction) are the first blocks. A preset's prompt for this reply is the last block, after the newest user message.
- **Counterexample means:** every message re-processes the whole history (more delay, and more of the user's plan used), or the model sees turns altered or out of order.
- **After the change, measured the same way:**
  - The tokens read from the cache grew with the conversation: 14,335 → 14,452 → 14,554 → 14,590.
  - Fresh writes stayed level at 400–480 tokens per turn. About 365 of those are something Claude Code adds after the conversation; each request writes them again. The long-lived process wrote 158–522 per turn.
  - The process start-up overhead is unchanged, at about 0.5 s per message.
  - The model handled the format: same answers as before.
- **Mutation testing:** five broken versions of the prompt builder, all caught:
  - a header on the newest message;
  - tool calls left out;
  - the transcript leaking into the system prompt;
  - images after their note;
  - a turn dropped.
  The one about images was caught only after the test pinned the exact block order.

### L8. The warm spare never changes what a reply gets (stateful) — active

Added after milestone 10 (DESIGN.md § Decided). One Claude Code process may be started ahead of time, after a finished reply, so the next message skips start-up (about 0.4 s).

`tests/core/cli.spare.property.test.ts`, `fc.commands`, with a fake Claude Code and a manual clock

- **Generator:** random sequences of messages, each with:
  - **settings:** the model, Claude Code's web tools, and the set of Lektor tools offered;
  - **an outcome:** finishes, fails, or is stopped.

  Between messages: idle timeouts, an idle spare that dies, the setting turned off and on, and unload.
- **Properties:**
  - **Matching:** a message uses the spare only if it was started with exactly that message's settings: the same command, model, web tools and tool definitions. Otherwise the spare is discarded and a fresh process starts. A spare therefore can't run with flags or tools the message didn't ask for, and L1 holds for every reply.
  - **Single use:** each spare serves at most one message, and its input receives exactly one message.
  - **How many:** at most one spare is ever waiting.
  - **When one starts:** only after a reply that finished, and only while the setting is on and Lektor is loaded.
  - **Which settings it gets:** those the next message will most likely use. After a normal message, that's the same settings. After a preset run, it's the chat's own settings without the preset (its model, the globe, and the tools a normal message gets), so a "Suggest fix" or a follow-up question finds it ready.
  - **Cleanup:** an unused spare is killed and its run folder removed: on a mismatch, after 10 idle minutes, if it dies, when the setting is turned off, and on unload.
  - **No conversation in files:** a spare's files hold no conversation or note text. Its prompt file is the constant instructions, which is true of every run now; notes reach Claude Code only on stdin.
  - **Tools before use:** a tool called on a waiting spare's MCP server runs nothing.
- **Counterexample means:**
  - a reply runs with settings or tools it didn't ask for;
  - two messages share a process;
  - or idle Claude Code processes and temp folders pile up.
- **Mutation testing:** 14 broken versions, 13 caught.
  - **Caught:** matching that ignores the model, web tools or Lektor tools; a spare kept after use; a spare after an error; the setting ignored; no idle timeout; a death ignored; a mismatched spare not closed; unload not stopping spares; tools running before a message; a spare used while the daily check is due; a folder left behind.
  - **Caught only after changes to the test:**
    - Ignoring the web tools, and starting a spare while the setting is off, slipped through at first. The test spent too many steps on unload and setting changes, so they were rarely exercised. It now weights its steps towards messages and counts the processes started.
    - A spare kept after use is otherwise masked by its exit handler; a direct test with two messages sent at once catches it.
  - **The survivor** removes the "has this spare died?" check when a message takes it. The exit handler always clears a dead spare before a message can see it, so that check is a safety net that can't be reached; it stays as one.
- **Measured** with Claude Code 2.1.332 on haiku, about 14k tokens of context, and a 2 s pause between messages:
  - **Overhead outside the API:** 513 ms on the first (fresh) process, then 56, 57 and 55 ms on the spares.
  - **Caching:** reads grew 14,412 → 14,662 tokens, with 433–498 written fresh per turn. Caching held after the context moved into the message.
- **After a preset run** (added the same day): the session tells the provider the settings the next message will most likely use (the chat's model, the globe and the normal tools), and the spare gets those. Five broken versions of this were all caught: the provider ignoring the hint; the session sending none; the preset's model, the preset's tools, or web tools regardless of the globe, used in the hint.
- **Checked in a real Obsidian** (2026-11-27, Claude Code 2.1.332, haiku, in a separate instance; the stored version-4 settings with a `cli` section migrated to `warm: true`):
  - A spare (haiku, web tools, normal Lektor tools) was waiting after the first reply.
  - The next message ran on it: mid-reply, it was the only Claude Code process alive. Afterwards a new spare had replaced it, and the old folder was gone.
  - Proofread ran on a fresh process, with no web tools and `report_findings`. The spare after it had the chat's normal settings, and the next message ran on it.
  - Turning "Keep Claude Code ready" off removed the spare and its folder, and saved `warm: false`. Turning it on started no spare until a reply finished, then one.
  - Disabling Lektor removed the spare and its folder, leaving no `lektor-` folders.
  - The user's own Obsidian profile was unchanged.
- **When Obsidian quits without unloading:** a waiting Claude Code exits about a second after its input closes. Only its small temporary folder (the fixed instructions and a stale MCP config, no notes) is left in the system temp directory.

### Mutation testing and regressions (milestone 10)

- **25 mutants, all killed.** They covered:
  - the argument list: a dropped `--restricted` or `--setting-sources`, `Read` slipped into the tools, an unchecked model or Lektor tool;
  - the self-test's verdict and its cache;
  - a chat sent before the self-test passed;
  - run-file names;
  - a run folder left behind;
  - the MCP server's Origin, Host and token checks, an unknown tool run anyway, and calls run in parallel;
  - an error `result` treated as success;
  - web tools offered twice, the globe and the fetch mode ignored, and Claude Code's own activity dropped.
- **One mutant (no kill on Stop) survived at first.** A `finally` also kills the process, but only after Claude Code prints something more. If it hangs silently, Stop would leave it running and still able to call Lektor's tools. A test now stops a silent process, and the mutant is killed.
- **A test-model mistake from milestone 4 surfaced in a CI run:** O1 expected tool-call arguments exactly as generated, but they reach Lektor as JSON, and `fc.jsonValue()` sometimes makes `-0`, which JSON writes as `0` (about once in 1,800 values). O1's model, and the H1 history model, which had the same latent mistake, now expect what crosses the wire. A regression test covers it. The adapter was right.
- **The live check found one bug, now fixed:** the globe's tooltip kept the old fetch mode, because capabilities were read again only when the model changed. They are now read again for each new chat and after each message.

### Checked in a real Obsidian (milestone 10)

On 2026-11-27, in a separate instance, with Claude Code 2.1.332 as installed and signed in. The bridge was turned on in the test vault's settings; the stored version-4 settings migrated to version 7.

- **Picker:** "Claude Code · Opus (latest)", "· Sonnet (latest)", "· Haiku (latest)" and "· Fable (latest)".
- **The globe:** "Tools on: Claude Code searches the web and fetches pages itself, as in its own app." In Lektor-fetch mode (after the fix above) it read "Claude Code searches the web itself; Lektor fetches pages, asking first for ones that didn't come from a search, your messages or your notes."
- **Proofread with haiku:**
  - The first reply ran the self-test first. The reply said "Lektor checked Claude Code 2.1.332's lockdown before using it", and `meta/cli-selftest.json` recorded a pass.
  - Claude Code called `report_findings` over MCP: "Reported Drafts/Essay.md: 4 findings". The card and four highlights appeared. The whole reply took 13 s.
- **Its own search:** the reply showed "Claude Code searched: 1 query", then answered "about 48 metres (156 feet) … according to Wikipedia's Skerryvore article", with the link.
- **Lektor fetching pages:** the model built `https://en.wikipedia.org/wiki/Bell_Rock_Lighthouse` itself. The approval card "Fetch a page the model chose?" appeared, Deny worked, and the model said the fetch was declined.
- **`request_context` through Claude Code:** the card listed `Reference/Chain A.md`. After Share all, the model quoted its first line.
- **Opus:** it answered "OK".
- **Cleanup:** no run folder was left in `/tmp`, and no Claude Code process was still running.

Probing the flags first (DESIGN.md § Decided, before milestone 10) took about ten short haiku requests on the user's subscription, with the user's permission.

The user's own Obsidian profile was unchanged before and after.

## Milestone 11: Codex bridge

Codex 0.162.1 was checked on 2026-11-27 (DESIGN.md § Decided, before milestone 11). Codex puts the model's tools in the request, not in its events, so the deterministic check runs Codex against a scripted model on Lektor's loopback server and reads the request.

### C1. The Codex lockdown is unconditional — active

`tests/core/codex.property.test.ts`

- **Generator:**
  - **models:** valid ones, and strings with spaces, quotes, `=`, newlines or leading dashes;
  - **web:** on or off;
  - **Lektor tools:** any subset;
  - **images:** 0–3;
  - **feature lists:** random names, stages (stable, experimental, under development, deprecated, removed) and on/off values, always including the vetted features and some real names (`shell_tool`, `view_image`, `hooks`, `image_generation`).
- **Properties:**
  - **Present:** every argument list starts with `exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules --strict-config`. It contains `-C <void> --sandbox read-only`, `approval_policy="never"`, `project_doc_max_bytes=0`, the skills, agents, apps, plugins and history keys, `sqlite_home`, `log_dir`, `model_instructions_file` and `model_catalog_json` inside the run folder, and Lektor's MCP server with its token taken from the environment. It ends with `-`.
  - **Features:** every listed feature that isn't removed and isn't vetted is disabled, except a deprecated one that is already off. No vetted feature is disabled, and nothing is ever enabled.
  - **Absent:** never any of these: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--full-auto`, `--yolo`, `--approve-for-me`, `--add-dir`, `--oss`, `--profile`/`-p`, `--worktree`, `--enable`, `--search`, `danger-full-access`, `workspace-write`, `resume`. No `-c` key outside the fixed set, and no MCP server but `lektor`.
  - **Web:** `web_search` is `"live"` only when web is on and Codex does web work, otherwise `"disabled"`.
  - **Refused:** an invalid model name, a feature name that isn't a plain identifier, or an empty feature list, so the run fails closed.
  - **Nothing private in argv:** no conversation text, context or token. Those go to stdin, the files and the environment.
  - **A snapshot test** pins the exact list for one input.
- **Counterexample means:** a refactor dropped a lockdown flag, or Codex could get a file, shell or patch tool (hard rule 2).

### C2. The per-run model catalog changes only the tool fields — active

`tests/core/codex.property.test.ts`

- **Generator:** catalogs of random model entries (random extra fields, nested values), and model names that are in the catalog or not.
- **Properties:**
  - The written catalog holds exactly one entry: Codex's own entry for that model, unchanged, except that `apply_patch_tool_type` is `null` and `experimental_supported_tools` is `[]`.
  - A model that isn't in the catalog is refused.
  - The model list Lektor shows is the catalog's visible models, in its order.
- **Counterexample means:** `apply_patch` or the clock tools come back, or Codex runs a model with metadata Lektor changed by mistake.

### C3. Codex's events become chat events exactly — active

`tests/core/codex.property.test.ts`

- **Generator:** random JSONL streams:
  - **items:** agent messages, reasoning, web searches (search, open_page, find_in_page and other actions, with results), Lektor MCP tool calls, errors (warnings);
  - **endings:** `turn.completed` with usage, `turn.failed`, or a top-level `error`;
  - **noise:** junk lines and unknown types, and a stream that just ends.
- **Properties:**
  - **Ending:** exactly one `done`, and it comes last. An ended stream with no `turn.completed` gives an error first. `turn.failed` or a top-level `error` gives an error and `done: error`.
  - **Text:** the reply text is the agent messages in order, joined by blank lines, each exactly as sent. The reasoning is the reasoning items' text.
  - **Codex's web work:** each completed web search gives one `codex_web_search` activity (a search) or `codex_web_fetch` activity (opening or searching in a page), with its query or URL and the result URLs.
  - **Lektor's tools:** MCP calls to Lektor's tools give no activity, because Lektor already records them.
  - **Never** throws.
  - **Usage:** input tokens include the cached ones.
- **Counterexample means:** a reply is lost, doubled or cut, or Codex's own web work goes unshown.

### C4. Codex prompts are complete and prefix-stable — active

`tests/core/codex.property.test.ts`

- **Generator:** as L7, with the prompt as one stdin text and context images as files.
- **Properties:**
  - **Prefix-stable:** the next message's prompt begins with this message's prompt, leaving out this reply's own instruction.
  - **Complete:** every visible turn appears once, in order, in the same block format as Claude Code's (L7).
  - **Images:** the image files are the context images, in order, and the same each turn.
  - **Constant files:** the instructions file never depends on the conversation.
  - **The run's folders:** two runs in one session use the same working folder.
- **Counterexample means:** the conversation stops being cached, or the model sees turns altered or out of order.

### C5. The Codex self-test fails closed — active

`tests/core/codex.property.test.ts`

- **Generator:**
  - **inventory runs:** the tool list offered at the top and inside code mode, with an extra tool, a missing `exec`, another MCP server's tool, or non-empty resource lists; instructions other than Lektor's; a canary in any request; no second request; a request carrying another token;
  - **real runs:** command, file-change and other item types, a canary in a message, reasoning or tool result, an unfinished run.
- **Properties:**
  - **The inventory** passes only if all of these hold:
    - the tools are exactly the allowed ones (Lektor's tools offered, Codex's MCP-resource tools, `exec`, `wait`, `request_user_input`);
    - both resource lists are empty;
    - the first developer message is exactly Lektor's instructions;
    - no canary appears in any request;
    - every request carried the run's token.
  - **The real check** passes only if it finished, reported no item outside messages, reasoning, web searches and Lektor MCP calls, and no canary appears in its output.
  - **Caching:** a pass is cached for 24 hours, the real check per version and the inventory per version and model. A failure is never cached as a pass.
- **Counterexample means:** Codex could run with a file tool, or after reading a file, and Lektor wouldn't notice.

### C6. A Codex reply goes through Lektor's review and approvals (session) — active

`tests/core/codex.session.test.ts`, with a fake Codex

- **Generator:** a scripted fake Codex that calls Lektor's tools over the real loopback MCP server and prints JSONL.
- **Properties:**
  - **Same tools as everyone:** calls run through the same tool run as every backend (approvals, caps, proposals), and the proposal lands in the chat.
  - **Codex's searches** show as "Codex searched" steps.
  - **The globe off:** `web_search="disabled"`.
  - **With Lektor doing web work:** Codex's search is off, and Lektor's `web_search` and `fetch_page` are offered over MCP.
  - **Stop** ends the process at once.
  - **Run folders:** after every run, whether finished, failed or stopped, the run folder is gone. The shared working folder stays empty, and unload removes it.
- **Counterexample means:** Codex could bypass review or approvals, or files and processes pile up.

### Mutation testing and regressions (milestone 11)

- **Mutation testing:** 39 broken versions of the bridge, all caught (`codex.property`, `codex.session` and the source tests, at CI counts).
  - **Caught first time:**
    - **Arguments:** the lockdown flags dropped or changed; `shell_tool` vetted; deprecated features handled wrongly; live search in the check; any model name or path accepted; an unreadable feature line tolerated.
    - **Catalog and events:** `apply_patch` or the experimental tools kept; hidden models shown; Lektor's calls shown twice; no `done` on failure; messages run together; lines after the end read; pages opened shown as searches.
    - **Checks and provider:** every one of the inventory's and the real check's checks removed; either check skipped; the run folder left behind; Stop not killing; images per run; web ignoring the setting; the shared folder kept on unload; the prompt joined wrongly; image names not by content.
  - **Caught only after new tests:**
    - The working folder per run: the test compared the process's folder but not `-C`.
    - A failed inventory remembered as a pass. A second message would then have skipped the check, so this mattered. No test sent a second message after a failure; one does now.
    - The working folder's emptiness check removed.
- **A real bug the new test found:** a shared working folder that wasn't empty was dropped but never deleted. It is now removed, and the next reply gets a fresh one.
- **Test-side mistakes, now fixed:**
  - **C3 model:** it ignored lines after a stream that never ended.
  - **The real-check property:** it returned `expect(...)`'s value, which fast-check read as `false`.
  - **The session helper:** it waited for a reply that was meant to be paused.
  - **Leftover folders:** test worlds now dispose their provider, so no shared folder outlives a test.
- **Checked against the real Codex 0.162.1:**
  - **The inventory fails when the lockdown is broken:** with `shell_tool` and `view_image` left on, it reported `exec_command`, `write_stdin` and `view_image`; with `apply_patch` left in the catalog, it reported `request_user_input_async`. The clean inventory passes in about 1.6 s.
- **Checked in a real Obsidian** (2026-11-27, separate instance, `gpt-6-luna`):
  - **Settings:** they migrated from version 4 to 9 with the Codex section.
  - **The first message:** the real check and the inventory ran first, then "OK" in 13 s.
  - **Proofread:** 6 findings through `report_findings`, with Codex's search off.
  - **Web search:** Codex searched on its own and cited the official site.
  - **Proposals:** `propose_edit` gave a proposal for review.
  - **`request_context`:** the share card appeared, and after Share all the model quoted the shared note.
  - **The globe:** off gave `web_search="disabled"`; on, the tooltip named Codex.
  - **Folders:** every chat run used one shared working folder; the checks used their own.
  - **Unload:** no folders or processes were left.
  - **`~/.codex`:** no file there contains the essay's text. Only Codex's own model cache (refreshed by `codex debug models`) and a temporary lock folder changed.
  - **The user's Obsidian profile** was unchanged.
- **Caching across replies is best effort:** Codex sets `prompt_cache_key` to a new session id in every process, and there is no setting for it. In three measured turns, the second read 12,672 tokens from cache, from its own first request, made before the web search; the third read none. The prompt's start is kept identical (shared working folder, images named by content) so a cache hit is possible whenever OpenAI routes there.

## Starting list from the design doc (planned)

These come from `docs/DESIGN.md` § Testing. Each gets a full generator, property and counterexample entry when its milestone starts.

1. **Context containment:** active as X2 (milestone 3 sources), A1 (attachments) and A3 (`request_context`).
2. **Backlink lists carry no content:** active as X3.
3. **No write without accept:** active as W3.
4. **Hunk algebra:** active as W1.
5. **Rebase honesty:** active as B1.
6. **Undo safety:** active as W4 (reverts from the AI history) and B6 (Obsidian's own undo and redo).
7. **History completeness:** active as W5.
8. **Proposal validation:** active as W2.
9. **Caps hold:** active as T2.
10. **Lockdown flags are unconditional:** active as L1 (Claude Code; Codex in M11).
11. **Preset parsing is total:** active as PR1.

Also from the design: **link-depth preview matches what is sent**, active as X4.

---

## Known limits of the static gates

The lint gates catch every *ordinary* way of reaching the vault: dot access, computed access with a literal key, destructuring, and imports. They do not catch deliberate obfuscation, such as computing the property name at runtime, reading note text out of the DOM, or `Reflect.get`. That is why each hard rule also has a behavioural property test (invariants 1–3 above), which checks what actually leaves the plugin rather than how the code is written. `eval` and `new Function` are banned outright.
