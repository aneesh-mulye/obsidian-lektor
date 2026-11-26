# Third-party code

Lektor is licensed under AGPL-3.0-or-later (see `LICENSE`). It includes, or will include, code from the projects below under their own licences.

## Lifted source modules

Files copied from other projects keep their original copyright notice in the file header and an `SPDX-License-Identifier: MIT` line. Each one is listed here with its origin.

| File in Lektor | Origin | Licence | Copyright |
| --- | --- | --- | --- |
| *(none yet)* | | | |

Planned (DESIGN.md § Fork base): modules from [LLM Hub](https://github.com/takeshy/obsidian-llm-hub) (MIT) and [Smart Composer](https://github.com/glowingjade/obsidian-smart-composer) (MIT), from milestone 5 onwards.

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
| punycode.js | 2.3.1 | MIT | markdown-it dependency |
| uc.micro | 3.0.0 | MIT | markdown-it dependency |

markdown-it also depends on argparse (PSF-2.0), which is used only by its command-line tool and is not bundled. The build fails if a bundled package has no licence file.

Development-only tools (TypeScript, esbuild, ESLint, typescript-eslint, vitest, fast-check, the `obsidian` type definitions) are not distributed.
