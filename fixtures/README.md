# Test vault

`vault/` is the manual and end-to-end test vault (DESIGN.md § Testing): an excluded folder (`Private/`, excluded by the test settings), a folder in Obsidian's own "Excluded files" (`Templates/`), attachments (an image with legible text embedded in `Drafts/Essay`, a CSV linked from `Reference/Sources`, and an image in the excluded `Private/` folder, also embedded in the essay), a link chain to depth 3 (`Chain A` → `D`), a note with many backlinks (`Sources`), and sample text seeded with typos, garden-path sentences and wrong facts (`Drafts/Essay`).

Notes that must never reach a model carry sentinel tokens (`PRIVATE-SENTINEL-…`, `TEMPLATE-SENTINEL-…`). The CSV carries `CSV-SENTINEL-7731`, which should reach a model only once the CSV is shared.

Never open this folder directly in Obsidian: it would write its workspace files here. Copy it first.
