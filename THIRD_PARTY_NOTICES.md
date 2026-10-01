# Third-party notices

Pitroom itself is licensed under the [MIT License](LICENSE). The workflow skills in `skills/` (brainstorming, planning, worker-driven development, review, debugging, TDD, verification, worktrees and finishing) are adapted from the skills of **superpowers** by Jesse Vincent, <https://github.com/obra/superpowers>, used under the MIT License reproduced below. They were rewritten so that their subagents are Pitroom workers.

## superpowers

MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## The dashboard (`dist/ui`)

`pitroom dash` serves a React app that is bundled into `dist/ui/app.js` and `app.css` when Pitroom is built. The bundle contains, or was written from, these projects (the licenses are those of the versions used):

| Project | License | Copyright |
|---|---|---|
| [React](https://github.com/facebook/react) and react-dom | MIT | Meta Platforms, Inc. and affiliates |
| [Base UI](https://github.com/mui/base-ui) | MIT | Material-UI SAS (2019) |
| [shadcn/ui](https://github.com/shadcn-ui/ui) components (`ui/src/components/ui`) | MIT | shadcn |
| [Shadix UI](https://github.com/apix-js/shadix-ui) expandable card (`ui/src/components/expandable-card.tsx`) | MIT | gihanrangana (2025) |
| [beUI](https://github.com/starc007/ui-components) agent activity (`ui/src/components/agents`, `motion`, `lib`) | MIT | Saurabh Chauhan (2026) |
| [Motion](https://github.com/motiondivision/motion) (with framer-motion) | MIT | Motion B.V. (2024), Framer B.V. (2018) |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | Tailwind Labs, Inc. |
| [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | MIT | Wombosvideo (2025) |
| [clsx](https://github.com/lukeed/clsx) | MIT | Luke Edwards |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge) | MIT | Dany Castillo (2021) |
| [Lucide](https://github.com/lucide-icons/lucide) | ISC | Lucide Icons and Contributors (2026) |
| [class-variance-authority](https://github.com/joe-bell/cva) | Apache-2.0 | Joe Bell |

The MIT License for the projects above is the one reproduced for superpowers, with each project's own copyright holder in place of the name there. The ISC and Apache-2.0 licenses are in the projects' repositories. Pitroom's own code in `ui/src` is MIT like the rest of the package.

## Not bundled

Pitroom starts worker CLIs you install yourself (OpenCode, Codex CLI, Claude Code). They are not part of this package and keep their own licenses and terms.

## Pixel mascots (CodeIsland)

The animated Claude Code, Codex and OpenCode characters shown on a running card (`ui/src/assets/mascots`) are from [CodeIsland](https://github.com/wxtsky/CodeIsland), MIT License, Copyright (c) 2026 wxtsky. The license text is the one reproduced for superpowers above, with that copyright holder.

## Product names and marks

`docs/architecture.svg` and the dashboard's run cards show the logos of OpenCode, Codex (OpenAI) and Claude Code (Anthropic) only to say which tools Pitroom can drive. The files come from [svgl](https://svgl.app) (OpenCode) and the MIT-licensed [LobeHub icons](https://github.com/lobehub/lobe-icons) set (Codex, Claude Code). The names and logos belong to their owners. Pitroom is not affiliated with or endorsed by them.
