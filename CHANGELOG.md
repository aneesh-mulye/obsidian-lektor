# Changelog

Each release's notes are the section for its version below; the release workflow publishes them as the GitHub release's description and refuses to release a version that has no section here.

## 0.1.2

Addresses the Community directory's review of 0.1.1.

- Links to international domain names in replies are converted by the platform's own URL parser instead of the bundled punycode library, which the review's scanner mistook for hidden network endpoints. A link written in ASCII form (`xn--…`) now keeps that form in its text, so a look-alike domain shows for what it is.
- Release files now come with GitHub artifact attestations, so anyone can check they were built from this repository.
- The README says exactly what Lektor's code does with the file system, with programs it starts, and with the vault.

## 0.1.1

Fixes the warnings from the Community directory's first review.

- Findings in a note are underlined with a dotted border instead of a styled text underline, which older Obsidian versions only partly support. They look the same.
- A popover in the context bar no longer refers to `globalThis`, for compatibility with popout windows.
- For models without tool calling, proposed edits and findings are read whole even when they contain backticks, for example an edit to a note with a code block. Before, the backticks ended the block early and the proposal was lost.

## 0.1.0

First release of Lektor: a sidebar chat for reviewing your notes with an LLM that sees only what you share.

- Proofread, find garden-path sentences and fact-check, or write your own presets.
- Use a local model (Ollama, or any OpenAI- or Anthropic-compatible server), or Claude Code or Codex on your own subscription, locked down so they can't read your files.
- Every proposed edit is shown as a diff, in the sidebar or inline in the note, and applied only when you accept it, hunk by hunk.
- The model sees only the context you attach; when it asks for more, you decide what to share.

Desktop only; requires Obsidian 1.15.1 or later.
