# Releasing Pitroom

## A new version

1. `npm run bump -- patch` (or `minor`, `major`, `X.Y.Z`; add `--dry-run` to look first). It moves the version in `package.json`, `package-lock.json`, both plugin manifests and adds a heading to `CHANGELOG.md`; replace its `TODO` with the release notes. A test fails while a file disagrees or the `TODO` is still there. The docs carry no version by hand.
2. `npm test` on Node 18 and a current Node; CI repeats it on Ubuntu and macOS.
3. Commit, push `main`, wait for CI.
4. `npm publish --access public` (needs your npm login and one-time password). `prepublishOnly` runs typecheck and tests first.
5. Tag the published commit and create the release: `gh release create vX.Y.Z --target <full sha> --notes-file …`.

The Claude Code and Codex marketplace (`.claude-plugin/marketplace.json`) installs the npm package with no version pin, so users receive a release as soon as it is on npm. Publish to npm before you tell anyone to update.

## Install from the marketplace

```bash
claude plugin marketplace add ATASTECH/pitroom && claude plugin install pitroom@pitroom
codex plugin marketplace add ATASTECH/pitroom && codex plugin add pitroom@pitroom
```

Try both in a throwaway home before a release: `CLAUDE_CONFIG_DIR=$(mktemp -d)` and `CODEX_HOME=$(mktemp -d)` keep your own settings untouched.

## Vendor directories

Pitroom is deliberately **not** submitted to Anthropic's or OpenAI's plugin directories: listing it there would add support and review obligations for a tool people can already install from npm or the marketplace above. The manifests still carry the listing fields (icon, privacy policy URL, neutral descriptions), so a submission stays possible; the requirements are in those vendors' submission docs, and the git history of this file has the steps that were prepared (a ZIP of `.codex-plugin`, `skills`, `assets` and `LICENSE` without hooks for OpenAI; the `claude plugin validate . --strict` check and the developer portal for Anthropic).
