# Contributing to Pitroom

Thanks for helping. Issues and pull requests are welcome, under the [code of conduct](CODE_OF_CONDUCT.md). For a vulnerability, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 18 or newer and git. Worker CLIs are optional for development: the tests use a fake worker.

```bash
git clone https://github.com/ATASTECH/pitroom && cd pitroom
npm install
npm run typecheck
npm test          # builds dist/ first, then runs every test
```

The tests are end-to-end against the built CLI with fake worker CLIs, plus adapter contract tests on recorded real streams. Run them on Node 22.13 and on a current Node; CI repeats them on Ubuntu and macOS.

## Where things live

| Path | What |
|---|---|
| `src/core`, `src/cli` | run lifecycle, reviews, plans, the CLI commands |
| `src/backends/<worker>` | one adapter per worker CLI ([how adapters work](docs/backends.md)) |
| `src/vcs` | the git snapshot, isolation and git guard |
| `skills/` | the `pitroom-*` agent skills and `using-pitroom` |
| `.claude-plugin`, `.codex-plugin`, `hooks` | plugin manifests and the session-start hook |
| `test/` | `*.test.mjs` (Node's test runner) and `fixtures/` |

## Changes

- **Open an issue first** for anything bigger than a fix, so we agree on the direction. A new worker adapter is the easiest big contribution.
- **Tests come with the change.** A bug fix starts with a test that fails for the right reason. Keep test output free of warnings.
- **`dist/` is generated.** `npm test` rebuilds it; commit the rebuilt files with your change and never edit them by hand. They are marked as generated in `.gitattributes`.
- **No runtime dependencies.** Pitroom ships as one bundle with none; keep it that way.
- **Match the code around you:** 2-space indent, single quotes, `node:` imports, comments that say why, `UserError` for failures the user can act on.
- **Safety is not negotiable.** Do not add flags or instructions that weaken a worker's permissions, the git guard or the apply checks. Changes in that area need a test that shows the protection still holds.

## Skills

Skills live in `skills/<name>/SKILL.md` with frontmatter: `name` equals the folder name, and `description` starts with "Use" and says when to use it. A test checks the rules and that every relative link resolves. Keep the session-start text under 8,192 characters (also tested).

## Commits and pull requests

Commit messages follow `type(scope): summary` with types such as `feat`, `fix`, `docs`, `test`, `chore`, `ci`. Explain why in the body when it is not obvious. In the pull request, say what changed, how you tested it, and which Node versions you ran.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Releases

Maintainers: see [docs/releasing.md](docs/releasing.md).

## The dashboard

`pitroom dash` serves a React app from `ui/` ([shadcn/ui](https://ui.shadcn.com) on Base UI, with [Shadix UI](https://shadix-ui.vercel.app)'s expandable card and [beUI](https://beui.dev)'s agent activity; animations by [Motion](https://motion.dev)). `npm run build` bundles it into `dist/ui` (esbuild for the script, the Tailwind CLI for the styles); those files are committed like the rest of `dist/`. The React toolchain is a dev dependency only: the CLI has no runtime dependencies. Add a shadcn component with `npx shadcn@latest add <name>` (the config is `components.json`), then check that it imports `cn` from `@/lib/utils`, and run `npm run typecheck`. The server only answers GET and the page loads nothing from outside, so keep it that way: no CDN scripts, fonts or images.

The screenshots in `docs/dash-*.png` come from `node scripts/demo-dash.mjs` (it builds an invented sample history, serves the dashboard on it and photographs it with Chrome; run `npm run build` first).
