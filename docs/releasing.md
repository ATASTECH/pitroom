# Releasing Pitroom

## A new version

1. `npm run bump -- patch` (or `minor`, `major`, `X.Y.Z`; add `--dry-run` to look first). It moves the version in `package.json`, `package-lock.json`, the plugin and extension manifests and `server.json` (the MCP Registry entry), and turns `CHANGELOG.md`'s `## Unreleased` section into the version's heading (without one it adds a heading with a `TODO` to replace). A test fails while a file disagrees or the `TODO` is still there. The docs carry no version by hand.
2. `npm test` on Node 22 and a current Node; CI repeats it on Ubuntu and macOS.
3. Commit, push `main`, wait for CI.
4. Create the release: `gh release create vX.Y.Z --target <full sha> --notes-file …`. The `release` workflow then publishes to npm from CI with provenance (see below), after a check that the tag equals the version in `package.json` and a run of typecheck and tests.
5. Once `npm view pitroom@X.Y.Z` answers, update the MCP Registry entry: `mcp-publisher publish` (from the repository root; it reads `server.json`; `brew install mcp-publisher`, and `mcp-publisher login github` once, as a member of the ATASTECH organization). The registry checks that the npm package's `mcpName` matches the entry's name.
   Without the CI setup, publish by hand instead: `npm publish --access public` (needs your npm login and one-time password; `prepublishOnly` runs typecheck and tests first), then create the release. A hand publish has no provenance.

## Publishing from CI (provenance)

`.github/workflows/release.yml` publishes with npm trusted publishing: GitHub proves to npm which repository and workflow is publishing, so no npm token is stored, and the npm page shows a signed "built and published from GitHub Actions" provenance link.

One-time setup, on npmjs.com: the `pitroom` package → Settings → Trusted publisher → GitHub Actions, with organization `ATASTECH`, repository `pitroom`, workflow filename `release.yml`. Leave the environment empty. Afterwards the package may be set to require two-factor authentication and disallow tokens.

The workflow file must exist at the commit the release tag points to, so tag a commit that already contains it. Pre-releases are skipped.

The Claude Code and Codex marketplace (`.claude-plugin/marketplace.json`) installs the npm package with no version pin, so users receive a release as soon as it is on npm. Publish to npm before you tell anyone to update.

## Install from the marketplace

```bash
claude plugin marketplace add ATASTECH/pitroom && claude plugin install pitroom@pitroom
codex plugin marketplace add ATASTECH/pitroom && codex plugin add pitroom@pitroom
```

Try both in a throwaway home before a release: `CLAUDE_CONFIG_DIR=$(mktemp -d)` and `CODEX_HOME=$(mktemp -d)` keep your own settings untouched.

## Vendor directories

Pitroom is deliberately **not** submitted to Anthropic's or OpenAI's plugin directories (the Codex manifest also declares lifecycle hooks, which OpenAI's directory rejects: a submission would first drop the `hooks` key): listing it there would add support and review obligations for a tool people can already install from npm or the marketplace above. The manifests still carry the listing fields (icon, privacy policy URL, neutral descriptions), so a submission stays possible; the requirements are in those vendors' submission docs, and the git history of this file has the steps that were prepared (a ZIP of `.codex-plugin`, `skills`, `assets` and `LICENSE` without hooks for OpenAI; the `claude plugin validate . --strict` check and the developer portal for Anthropic).
