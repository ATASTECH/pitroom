## What this changes

<!-- What and why, in a few lines. Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran. Node versions (18 and a current one). A bug fix starts with a test that failed for the right reason. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass (this rebuilds `dist/`; commit the rebuilt files, never edit them by hand)
- [ ] Tests cover the change, and their output has no warnings
- [ ] No worker permission, git guard or apply check is weaker than before (or the change says why and proves the protection still holds)
- [ ] User-visible changes are in `CHANGELOG.md` and the README
- [ ] No secrets, tokens or private code in the diff
