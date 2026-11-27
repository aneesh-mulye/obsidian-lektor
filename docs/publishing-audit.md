# Publishing audit

An audit of the repo against `docs/PUBLISHING.md`, done 2026-11-27. Each item is **done** (already true), **fixed now** (changed in the commit that adds this file) or **needs the author**.

Official pages checked the same day: [Developer policies](https://docs.obsidian.md/Community+directory/Developer+policies), [Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins), [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin). Where they differ from PUBLISHING.md, that is noted under "Differences from the official pages".

## Hard rules

| Item | Status |
| --- | --- |
| No obfuscation | Done. The release build is minified by esbuild (as in Obsidian's sample plugin), not obfuscated. The source is public, and the bundled packages' licences are appended to `main.js`. |
| No telemetry, analytics or error reporting | Done. Checked by INVARIANTS.md U4 and the README. |
| No ads | Done. |
| No self-install or self-update at runtime | Done. Lektor never installs or updates anything; it only runs the `claude` and `codex` programs the user installed. |
| No "Obsidian" in the name or id; not presented as first-party | Done. Name and id are "Lektor"/`lektor`. Checked by `tests/repo/directory.test.ts`. |
| No sample-plugin code | Done. `obsidianmd/no-sample-code` and `sample-names` report nothing. |

## Borrowed code

| Item | Status |
| --- | --- |
| Find copied or closely adapted code from LLM Hub and Smart Composer | Done: none found. See below. |
| List them | Done: there is nothing to list. |
| Draft permission requests | Not needed, since nothing is copied. Drafts are below in case you want to ask anyway. |
| MIT notices, SPDX `MIT`, THIRD_PARTY.md, README credits | Fixed now. There are no MIT-licensed files. THIRD_PARTY.md no longer says code is "planned", and records the check. The README credits both projects as influences on the design and says no code was taken. |

**How this was checked.** DESIGN.md planned to lift modules from both projects ("Fork base"), but every milestone wrote its own code; milestone 10 records the decision for the CLI bridge. To confirm it, both repositories were cloned (`takeshy/obsidian-llm-hub` and `glowingjade/obsidian-smart-composer`, current default branch) and compared line by line with Lektor's `src/` and `styles.css`, counting non-trivial lines of 45 characters or more. The only lines in common are these:

- **Five CSS declarations** using Obsidian's own variables, for example `border: 1px solid var(--background-modifier-border);`. They're in both projects and in most plugins.
- **`capabilities: { tools: { listChanged: false } }`.** This is the response shape the MCP specification requires; it appears in LLM Hub's `codexVaultMcpBridge.ts` and Lektor's `src/core/cli/mcp.ts`.
- **`if (this.timer !== null) window.clearTimeout(this.timer);`.** This is a common idiom.

None of these is protectable expression, and there are no shared files, functions or passages. No `SPDX-License-Identifier: MIT` header exists in `src/`.

**Drafts, only if you want to ask anyway.** Each would go in a GitHub issue on that project.

> **Title:** Credit for Lektor, an Obsidian plugin inspired by LLM Hub
>
> Hi! I'm publishing Lektor, an AGPL-3.0-or-later Obsidian plugin for reviewing notes with an LLM (https://github.com/aneesh-mulye/obsidian-lektor). While designing it I studied LLM Hub, especially how it runs CLI models and serves tools to them over MCP. Lektor's code is its own, but its README credits LLM Hub for the ideas. If you'd rather it didn't, or would like the credit worded differently, please let me know. Thank you for publishing your work under MIT!

> **Title:** Credit for Lektor, an Obsidian plugin inspired by Smart Composer
>
> Hi! I'm publishing Lektor, an AGPL-3.0-or-later Obsidian plugin for reviewing notes with an LLM (https://github.com/aneesh-mulye/obsidian-lektor). Its per-hunk review of proposed edits was inspired by Smart Composer's apply view. Lektor's code is its own, but its README credits Smart Composer for the idea. If you'd rather it didn't, or would like the credit worded differently, please let me know. Thank you for publishing your work under MIT!

## Repository and release

| Item | Status |
| --- | --- |
| `README.md`, `LICENSE`, `manifest.json` at the root | Done. `LICENSE` is the official AGPL-3.0 text (661 lines; same SHA-256 as the FSF's `agpl-3.0.txt`, `8486a10c…f07ef`). `validate-license` passes. |
| `manifest.json` at HEAD has the right version, `x.y.z` | Done: `0.1.0`. It must be pushed to the default branch before submitting (needs the author). |
| Release tag equals the version, with no `v` | Fixed now: the release workflow refuses any other tag. Creating the tag needs the author. |
| `main.js`, `manifest.json` and `styles.css` attached as binary assets | Fixed now: the workflow attaches all three. |
| Fixes ship as new versions; tags are never reused | Done by process. `npm version <x.y.z>` runs `version-bump.mjs`, which updates `manifest.json` and `versions.json` together, and `.npmrc` (`tag-version-prefix=""`) makes its git tag exactly the version, with no `v`. |
| A GitHub Actions workflow that builds and attaches the assets on a tag, and fails if the tag and version differ | Fixed now: `.github/workflows/release.yml`. On a pushed tag it checks the tag against `manifest.json` and `versions.json`, runs lint, the tests and the build, and creates a **draft** release with the three files, which you publish after a look. |
| Release titles and notes (added after the first review) | Fixed: releases are named "Lektor x.y.z", and their notes are that version's section of `CHANGELOG.md` plus GitHub's changelog link. The workflow refuses a version with no section, and a repository test checks there is one for the manifest's version. |

## manifest.json

| Item | Status |
| --- | --- |
| `id` is `lektor` and never changes | Done. |
| `isDesktopOnly: true` | Done. |
| Description starts with a verb, at most 250 characters, ends with a full stop, no emoji | Fixed now: the description in PUBLISHING.md (155 characters). |
| No `fundingUrl` unless you accept donations | Done: there is none. |
| `minAppVersion` is the oldest version tested | Fixed now: `1.15.1`, the only version Lektor has been run on (every live check used Obsidian 1.15.1). It was `1.11.4`, which was never tested, and Lektor now uses 1.13 APIs (declarative settings, `setDestructive`). `versions.json` was updated to match. Lower it only after testing an older version (needs the author). |
| `author` | Done: "Aneesh Mulye". `authorUrl` is optional and needs the author. |

## Code

| Item | Status |
| --- | --- |
| Command ids don't include the plugin id | Done: `open-sidebar`, `new-chat`, … `obsidianmd/commands/*` pass. |
| No sample code, commands or settings | Done. |
| Web APIs over Node APIs where both work; Node only in the CLI bridges | Done. Node modules are imported only under `src/core/cli/` (the lint gates enforce it). The plugin uses the Web Crypto `crypto.randomUUID`. |
| All HTTP through `requestUrl`; no network calls beyond those listed | **Kept as is, and flagged** (see "Differences from the official pages"). Search providers and page fetches use `requestUrl`. Model replies stream through `fetch` and fall back to `requestUrl` when a server refuses the app's origin (DESIGN.md, before milestone 9). There are no other network calls; the CLI bridges' MCP server listens on 127.0.0.1 only. |
| `npm run lint`, with Obsidian's ESLint rules, passes with no warnings | Fixed now. `eslint-plugin-obsidianmd` 0.6.0 is a dev dependency and its `recommended` config is in `eslint.config.mjs`, ahead of Lektor's own blocks and hard-rule gates. One of its rules, `no-restricted-globals`, is left to Lektor's own gates, which set it for every file; INVARIANTS.md G5 requires the gates' exact config. Obsidian's version adds `app`, `fetch` and `localStorage`; Lektor uses neither global `app` nor `localStorage`, and `fetch` is discussed under "Differences". It reported 30 problems, all fixed: <ul><li>window timers;</li><li>`activeDocument`;</li><li>deprecated `passthrough`, `message`, `setWarning` and `setDynamicTooltip`;</li><li>no declarative settings: the settings tab now returns `getSettingDefinitions()`, one page per section, each drawn by the existing code, and Obsidian's settings search finds the sections.</li></ul> Checked in Obsidian 1.15.1: every page draws, changes are saved, pages redraw, and search finds them. |

## README: required disclosures

| Item | Status |
| --- | --- |
| A "Privacy and network use" section near the top | Fixed now: it is the first section after the introduction. |
| Network use: every remote service and why | Fixed now: model endpoints, the chosen search provider, fetched pages, and the CLIs' own services. Also the 127.0.0.1 listener during CLI replies, and "no telemetry, no analytics, no update checks, no other network calls". |
| Accounts | Fixed now: Claude and ChatGPT subscriptions for the CLI bridges; API keys for Tavily, Exa and Brave; core features need no account. |
| Files outside the vault | Fixed now, describing what the code actually does: <ul><li>it runs the installed `claude` and `codex`;</li><li>it uses private temporary folders, removed afterwards;</li><li>Codex signs in from your own `~/.codex`, with its configuration there ignored and its state and logs kept in the temporary folder;</li><li>Lektor never reads, copies or sends a token.</li></ul> |
| What the model sees and changes | Fixed now: the two hard rules. |
| Licence and credits | Fixed now: AGPL-3.0-or-later; LLM Hub and Smart Composer credited. |

## Before the first submission

| Item | Status |
| --- | --- |
| Everything above done or listed for the author | Done. |
| Short usage instructions and screenshots | Done: "Getting started", plus three real screenshots (`docs/images/`). |
| The author creates the release, submits, and reads the review | Needs the author. |

## Differences from the official pages

- **`requestUrl` for all HTTP.** PUBLISHING.md asks for it, and Obsidian's ESLint config warns on `fetch` ("Use the built-in `requestUrl` function instead of `fetch`"), so the automated review will most likely flag `src/obsidian/Http.ts`. The official policy pages, though, don't mention `fetch` or `requestUrl` at all. Lektor keeps streaming model replies through `fetch` (with the `requestUrl` fallback). `requestUrl` can't stream, so switching would mean every reply appears only when it's done. If the automated review flags `fetch`, the fallback path already exists and could become the only path.
- **Codex's isolated home.** PUBLISHING.md describes Codex getting an isolated home folder linked to `~/.codex/auth.json`. The built code doesn't do that: you chose, before milestone 11, to use your own `~/.codex` with its configuration ignored (DESIGN.md). The README describes what the code does.
- **The ESLint plugin.** The official pages don't mention it; PUBLISHING.md and the plugin's own README do. It is in `npm run lint` as asked.
- **The description's verb.** The official page says good descriptions *often* start with an action; it isn't a hard rule. The description used starts with "Review" anyway.
- **Settings.** `display()` is deprecated from Obsidian 1.13, and the review rules forbid disabling the rule that asks for declarative settings, so the settings tab was converted as described under Code.

## Needs the author

1. ~~Decide on `fetch`~~ **Decided 2026-11-27: keep streaming.** Run on its own, Obsidian's review config finds only this one *warning* (`no-restricted-globals` on `fetch` in `src/obsidian/Http.ts`) and no errors. Model replies stream through `fetch`, with `requestUrl` as the fallback; the developer policies don't forbid `fetch`. If a reviewer asks: *"Lektor streams chat replies from the user's own model server as they're generated, which `requestUrl` can't do. It falls back to `requestUrl` when a server refuses the app's origin. All other requests (web search, page fetches) use `requestUrl`."*
2. **Push** the commits to `github.com/aneesh-mulye/obsidian-lektor`, make sure the repository is public, and check that Actions may create releases (Settings → Actions → General → Workflow permissions: "Read and write").
3. **`minAppVersion`:** it is `1.15.1`, the only version tested. Lower it only if you test Lektor on an older Obsidian (1.13.0 is the floor, for the APIs it uses).
4. **`authorUrl`:** optional; add one if you want a link on the directory page.
5. **Release `0.1.0`:** push the tag `0.1.0` (`git tag 0.1.0 && git push origin 0.1.0`). The workflow builds and creates a draft release with the three files; check it and publish it.
6. **Submit** at <https://community.obsidian.md>: sign in, link GitHub, add the plugin, then read the automated review's results.
7. **Optional:** post the credit notes above on the two projects, if you want their authors to know.
8. **Later:** add the install section to the README once Lektor is listed (decided before milestone 12).
