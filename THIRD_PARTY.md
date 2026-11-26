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

| Package | Version | Licence |
| --- | --- | --- |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| scheduler | 0.23.2 (react-dom dependency) | MIT |
| zod | 4.6.7 | MIT |

Development-only tools (TypeScript, esbuild, ESLint, typescript-eslint, vitest, fast-check, the `obsidian` type definitions) are not distributed.
