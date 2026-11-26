# Lektor — instructions for Claude Code

Lektor is an Obsidian plugin: a sidebar LLM chat that sees only the context the user gives it, uses only the tools the user allows, and changes nothing in the vault without per-hunk approval. Plugin ID `lektor`, repo `obsidian-lektor`, licence AGPL-3.0-or-later.

## Read first

`docs/DESIGN.md` is the spec. Read it in full before writing any code, and re-read the relevant section before each milestone. If the code and the doc disagree, stop and ask; don't silently pick one.

## The two hard rules (never break these)

1. **No write without approval.** Nothing in the vault changes unless the user accepts a specific hunk. Only `ReviewController` may write (`vault.modify`, `vault.create`, `editor.replaceRange`), and only from a user click. No auto-apply setting, ever.
2. **Only what you give it.** A model sees only the context the user attached. Only `ContextBroker` may read the vault. Models can *ask* for more via `request_context`; the user approves.

These are enforced by ESLint rules and property tests. Never weaken, disable or work around those checks. If a feature seems to need breaking a rule, stop and ask.

## Architecture boundary

- `src/core/` must never import `obsidian`. It holds providers, CLI bridges, tools, proposal/diff/rebase logic, presets, the chat session.
- `src/obsidian/` implements the core's interfaces (`ContextSource`, `EditApplier`, `Storage`, `Clock`) plus all UI.

## How to work

- Build **one milestone at a time**, in the order in `docs/DESIGN.md`. Don't start the next one until the current one's tests are green and it's usable.
- **Before writing code for a milestone**, think carefully about which invariants it must preserve. Write them in plain words in `INVARIANTS.md` (generator, property, what a counterexample would mean), then write them as fast-check property tests. Prefer stateful/model-based tests (`fc.commands`) for anything driven by sequences of actions. Then write the code, then the regular unit tests.
- A failing property-test seed becomes a regression unit test.
- Run `npm run lint`, `npm test` and `npm run build` before calling anything done.
- Commit at the end of each milestone, with a message naming the milestone. Don't push unless asked.

## CLI bridges (Claude Code, Codex)

- They run in an empty plugin-owned folder, never in the vault, with every file and shell tool disabled. Use exactly the lockdown flags in `docs/DESIGN.md`; arg-builder snapshot tests guard them.
- The lockdown self-test must pass before any CLI session starts. Fail closed.
- Never read, copy or forward OAuth tokens. Only spawn the official, installed CLIs.
- Verify every flag against the installed CLI's `--help` before relying on it; flags change between versions. Record what you checked.

## Borrowed code

Modules lifted from LLM Hub and Smart Composer (both MIT) keep their original copyright notice in the file header and are listed in `THIRD_PARTY.md`. Every source file gets an SPDX header (`AGPL-3.0-or-later`, or `MIT` for lifted files).

## Don'ts

- Don't type out licence texts from memory; `LICENSE` comes from GitHub.
- Don't add telemetry, analytics or any network call not described in the design.
- Don't add dependencies without saying why; prefer small, well-maintained ones.
- Don't build a generic multi-editor framework; the `core/obsidian` split is the only preparation for that.
