# Releasing Pitroom

## A new version

1. Bump `version` in `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (a test keeps them equal) and add a `CHANGELOG.md` entry.
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

## Anthropic's plugin directory

Listing reaches claude.ai, Cowork and Claude Code. It needs a paid claude.ai plan and a GitHub repository holding the plugin.

1. `claude plugin validate . --strict`, then fix what it reports.
2. Open the developer portal at <https://claude.ai/directory/manage>, run **Validate**, fix every **Blocking** finding, then submit.
3. Expect a reviewer hold for two things in this repository: the `package.json` with `package-lock.json` at the plugin root (Claude Code installs a lockfile's packages), and the hook commands that run `dist/pitroom.mjs` (a non-shell file). Both are explained in the pre-submission checklist: <https://claude.com/docs/plugins/pre-submission-checklist>.
4. The plugin only works where a shell and the `pitroom` command exist, so on claude.ai and Cowork it is listed for Claude Code only.

## OpenAI's plugin directory (ChatGPT and Codex)

1. Build the package from the published files only. The directory rejects lifecycle hooks, so leave `hooks/` out:

   ```bash
   zip -r pitroom-codex.zip .codex-plugin skills README.md LICENSE CHANGELOG.md
   ```

2. Upload the ZIP at the plugin submission portal (<https://developers.openai.com/plugins/deploy/submission>) as an organization owner of a verified OpenAI organization.
3. The listing fields come from `.codex-plugin/plugin.json` (`interface`). The portal may ask for an icon and, for plugins with an MCP server, a privacy policy: Pitroom has none.
4. The skills call the `pitroom` command, which is installed separately (`npm i -g pitroom`). The long description says so.
