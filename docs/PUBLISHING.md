# Publishing Lektor to the Obsidian Community directory

Lektor is already built. This file lists what Obsidian's Community directory requires so Lektor passes its automated review, and what to change to get there. It adds to `docs/DESIGN.md` and `CLAUDE.md`; it does not replace them, and neither of those files should be edited. Where they say nothing about publishing, this file decides.

Compiled 2026-11-27 from Obsidian's own docs (links at the end). If anything here conflicts with the current official pages, the official pages win; flag the difference.

## How to work through this file

1. Audit the current repo against every checklist below and write the findings to `docs/publishing-audit.md`: each item as done, fixed now, or needs the author.
2. Fix everything that can be fixed in code, config, CI or docs. Keep the two hard rules and all existing tests intact.
3. Run `npm run lint`, `npm test` and `npm run build`; all must pass.
4. Commit with a message like `chore: meet Obsidian Community directory requirements`. Don't push or create a release unless asked.
5. Finish with a short list of what only the author can do (see "Needs the author" at the end of the audit).

## How submission works now

- Submission is at <https://community.obsidian.md>: sign in with an Obsidian account, link GitHub, add the plugin. There is no pull request to `obsidian-releases` any more.
- Every release is scanned automatically (policy, code quality, known vulnerabilities, malware). A plugin must pass before it appears in search; a later release that fails is removed from search within 24 hours.
- Only the first version is submitted through the form. Later GitHub releases are picked up automatically.
- Obsidian publishes an ESLint plugin with the rules the automated review uses. Add it to `npm run lint` now and fix what it reports, so problems show up locally, not after a release.

## Hard rules: never do these

- Obfuscate code.
- Add client-side telemetry, analytics or error reporting (Sentry etc.).
- Show ads of any kind.
- Make the plugin install or update itself or its dependencies at runtime.
- Use "Obsidian" in the plugin name or ID, or present Lektor as a first-party Obsidian product.
- Leave any sample-plugin code in the build.

## Borrowed code

Obsidian's fork policy says not to inherit another project's code without the original author's explicit, publicly verifiable permission, even where the licence (MIT here) allows it. Lektor may contain code taken from LLM Hub or Smart Composer.

- [ ] Find every file or substantial passage copied or closely adapted from either project (check `THIRD_PARTY.md`, file headers, and the code itself).
- [ ] List them in the audit: file, source project and file, roughly how much was taken.
- [ ] **Do not rewrite them yet.** The author will decide per project whether to ask its author for permission or have the code rewritten. For each project, draft a short, polite GitHub issue asking for permission to include the listed code in an AGPL-3.0-or-later Obsidian plugin, with credit; put the drafts in the audit.
- [ ] Make sure each copied file keeps its MIT notice and an SPDX `MIT` line, is listed in `THIRD_PARTY.md`, and that the README credits both projects.

## Repository and release

- [ ] Repo root contains `README.md`, `LICENSE` and `manifest.json`. `LICENSE` must be the official AGPL-3.0 text; never retype it from memory.
- [ ] `manifest.json` on the default branch's HEAD has the correct `version`, in semver `x.y.z`.
- [ ] Each release is a GitHub release whose tag exactly equals that version (no `v` prefix).
- [ ] The release has `main.js`, `manifest.json` and `styles.css` attached as binary assets.
- [ ] Fixes ship as a new release with a higher version; never re-use a tag.
- [ ] A GitHub Actions workflow builds and attaches these assets when a tag is pushed, and fails if the tag and the `manifest.json` version differ.

## manifest.json

```json
{
  "id": "lektor",
  "name": "Lektor",
  "version": "0.1.0",
  "minAppVersion": "<oldest Obsidian version actually tested>",
  "description": "Review your notes with an LLM that sees only what you share: proofread, flag hard-to-parse sentences and fact-check, with every edit approved hunk by hunk.",
  "author": "<author name>",
  "authorUrl": "<optional>",
  "isDesktopOnly": true
}
```

- [ ] `id` is `lektor` and never changes after the first publish.
- [ ] `isDesktopOnly` is `true` (Lektor uses Node's `child_process` and `fs`).
- [ ] `description` starts with a verb, is at most 250 characters, ends with a period, and has no emoji or special characters.
- [ ] No `fundingUrl` unless the author accepts donations; if present it links only to a donation service.
- [ ] `minAppVersion` is the oldest version really tested, or the latest stable build if unsure. If the right value isn't known, list it under "Needs the author".

## Code

- [ ] Command IDs do not include the plugin ID (Obsidian adds the `lektor:` prefix itself).
- [ ] No leftover sample code, sample commands or sample settings.
- [ ] Web APIs are used over Node APIs where both work (e.g. `SubtleCrypto`, `navigator.clipboard`); Node use is limited to the CLI bridges and what they need.
- [ ] All HTTP goes through Obsidian's `requestUrl`; there are no network calls other than those listed under "Network use" below.
- [ ] `npm run lint`, including Obsidian's ESLint rules, passes with no warnings.

## README: required disclosures

Obsidian's policy requires each of these to be stated clearly in the README. Put them in a section called **Privacy and network use**, near the top.

- [ ] **Network use.** Name every remote service and why it's contacted:
  - the model endpoints the user configures (Ollama or other local servers; any OpenAI- or Anthropic-compatible URL);
  - the search provider the user picks (Tavily, Brave, SearXNG, DuckDuckGo, Exa), only for searches the model makes;
  - web pages the model fetches during fact-checks;
  - the Claude Code and Codex CLIs, which contact Anthropic and OpenAI respectively when those backends are used.
  - Also state plainly: no telemetry, no analytics, no other network calls.
- [ ] **Accounts.** The Claude Code and Codex backends need a Claude or ChatGPT subscription and the official CLI installed and signed in. Some search providers need a free account and API key. Core features work with a local model and no account.
- [ ] **Files outside the vault.** Lektor runs the user's installed `claude` and `codex` programs, and for Codex creates an isolated home folder that links to `~/.codex/auth.json` so the CLI can sign in. Explain why, and that Lektor never reads, copies or sends the token itself. If the built code does this differently, describe what it actually does.
- [ ] **What the model sees and changes.** Summarise the two hard rules: the model sees only the context the user attaches, and nothing in the vault changes without the user accepting each change.
- [ ] **Licence and credits.** AGPL-3.0-or-later; credit LLM Hub and Smart Composer.

## Before the first submission

- [ ] Every item above is done, or listed under "Needs the author".
- [ ] The README has short usage instructions and placeholders for screenshots.
- [ ] Then the author (not Claude Code) creates the release, submits at <https://community.obsidian.md>, and reads the automated review's results.

## Sources

- [Developer policies](https://docs.obsidian.md/Community+directory/Developer+policies)
- [Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [The future of Obsidian plugins (announcement, May 2026)](https://obsidian.md/blog/future-of-plugins/)
