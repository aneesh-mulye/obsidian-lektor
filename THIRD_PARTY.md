# Third-party code

Lektor is licensed under AGPL-3.0-or-later (see `LICENSE`). It bundles the npm packages below under their own licences.

## Lifted source modules

Files copied from other projects keep their original copyright notice in the file header and an `SPDX-License-Identifier: MIT` line. Each one is listed here with its origin.

| File in Lektor | Origin | Licence | Copyright |
| --- | --- | --- | --- |
| *(none)* | | | |

None was needed: DESIGN.md planned to lift modules from [LLM Hub](https://github.com/takeshy/obsidian-llm-hub) and [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) (both MIT), but Lektor's code was written for it. Checked on 2026-11-27 against both projects' current source (docs/publishing-audit.md): the only lines in common are generic ones, such as CSS declarations built on Obsidian's variables and the JSON shape the MCP specification requires. If code is ever copied from another project, it is listed here, keeps its notice and an SPDX `MIT` line, and needs its author's permission first (Obsidian's developer policies).

## Bundled npm packages

These are compiled into the released `main.js`. The production build (`npm run build`) appends each package's own `LICENSE` file, read from `node_modules`, to the end of `main.js`, so the notices travel with every copy.

| Package | Version | Licence | Why |
| --- | --- | --- | --- |
| react, react-dom | 18.3.1 | MIT | Sidebar UI |
| scheduler | 0.23.2 | MIT | react-dom dependency |
| zod | 4.6.7 | MIT | Settings, chat-file and response validation |
| markdown-it | 15.0.3 | MIT | Rendering model output with raw HTML and images off (see `src/obsidian/ui/markdown.ts`) |
| entities | 8.1.0 | BSD-2-Clause | markdown-it dependency |
| linkify-it | 6.1.0 | MIT | markdown-it dependency |
| mdurl | 2.1.0 | MIT | markdown-it dependency |
| uc.micro | 3.0.0 | MIT | markdown-it dependency |
| picomatch | 4.0.7 | MIT | Glob matching for excluded folders (`src/core/context/exclusions.ts`) |
| @mozilla/readability | 0.6.0 | Apache-2.0 | Readable text from fetched pages (`src/obsidian/HtmlExtractor.ts`) |

markdown-it also depends on argparse (PSF-2.0), which is used only by its command-line tool and is not bundled. The build fails if a bundled package has no licence file.

Development-only tools (TypeScript, esbuild, ESLint, typescript-eslint, vitest, fast-check, the `obsidian` type definitions) are not distributed.
