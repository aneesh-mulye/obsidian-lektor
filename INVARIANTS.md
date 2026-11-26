# Lektor invariants

Each invariant names its **generator** (what random inputs we throw at it), its **property** (what must hold for every one of them), and what a **counterexample** would mean. Every invariant is a fast-check property test; the test file is named next to it. Runs: 100 cases locally, 1,000 in CI (`npm run test:ci`). A failing seed becomes a regression unit test in the same folder, named after the seed.

Status: **active** means a property test exists and runs; **planned (Mn)** means it lands with milestone *n*.

Regression tests from failing seeds or surviving mutants so far: `tests/core/settings.test.ts` › "does not let an unreadable list become readable through serialisation" (a mutant of the S5 guard survived the property tests because JSON never produces such a value from disk).

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

## Starting list from the design doc (planned)

These come from `docs/DESIGN.md` § Testing. Each gets a full generator, property and counterexample entry when its milestone starts.

1. **Context containment:** planned (M3, extended in M7).
2. **Backlink lists carry no content:** planned (M3).
3. **No write without accept:** planned (M5).
4. **Hunk algebra:** planned (M5).
5. **Rebase honesty:** planned (M6).
6. **Undo safety:** planned (M5).
7. **History completeness:** planned (M5).
8. **Proposal validation:** planned (M5).
9. **Caps hold:** planned (M4).
10. **Lockdown flags are unconditional:** planned (M10, M11).
11. **Preset parsing is total:** planned (M8).

Also planned: **link-depth preview matches what is sent** (M3; DESIGN.md § Context system).

---

## Known limits of the static gates

The lint gates catch every *ordinary* way of reaching the vault: dot access, computed access with a literal key, destructuring, and imports. They do not catch deliberate obfuscation, such as computing the property name at runtime, reading note text out of the DOM, or `Reflect.get`. That is why each hard rule also has a behavioural property test (invariants 1–3 above), which checks what actually leaves the plugin rather than how the code is written. `eval` and `new Function` are banned outright.
