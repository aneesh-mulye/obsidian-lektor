# Test vault

`vault/` is the manual and end-to-end test vault (DESIGN.md § Testing): an excluded folder (`Private/`, excluded by the test settings), a folder in Obsidian's own "Excluded files" (`Templates/`), an attachment, a link chain to depth 3 (`Chain A` → `D`), a note with many backlinks (`Sources`), and sample text seeded with typos, garden-path sentences and wrong facts (`Drafts/Essay`).

Notes that must never reach a model carry sentinel tokens (`PRIVATE-SENTINEL-…`, `TEMPLATE-SENTINEL-…`).

Never open this folder directly in Obsidian: it would write its workspace files here. Copy it first.
