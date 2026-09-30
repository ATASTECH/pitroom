# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or pull request.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, the Pitroom version (`pitroom --version`), your OS and Node.js version, and which worker CLI was involved.

If you cannot use that form, open an issue that says only that you have a security report, with no details, and ask for a private channel.

This is a small project maintained by one person. I aim to acknowledge a report within 7 days and to tell you what I plan to do about it, but I cannot promise a fix time. I prefer coordinated disclosure: give me a reasonable time to fix it before you publish, and I will credit you in the release notes if you like.

## Supported versions

Only the latest release on npm receives security fixes.

## What Pitroom protects, and what it does not

Pitroom delegates work to worker agents (other AI coding tools). It limits what they can do with permission profiles and, for Codex, the OS sandbox, a git guard on the worker's PATH, isolated working copies and checks before a patch lands (for example, a patch that deletes files is not applied without `--allow-delete`).

These are safeguards, **not a security boundary** against a determined attacker or a malicious repository. Pitroom runs with your user's privileges, worker agents can be manipulated by text in the files they read (prompt injection), and what you delegate is sent to the worker's model provider ([privacy policy](PRIVACY.md)). See [Responsibility](README.md#responsibility).

## In scope

- A worker escaping its mode: a read-only worker that can write, or a worker that can run the commands Pitroom forbids (git history changes, `sudo`, publishing, killing processes).
- A way around the git guard that changes commits, refs, the index or the stash.
- A way around the apply checks, or a patch that writes outside the project.
- Path, symlink or quoting problems in isolated copies, `--link`, run records or review packages that let a task or a config value reach files or commands it should not.
- Secrets written to places the documentation says they are not (run records, the ledger, cards, the status line).

## Out of scope

- A model doing something unwanted within the permissions you gave it, or being talked into misusing a permitted tool.
- Vulnerabilities in the worker CLIs, model providers, Node.js or other software Pitroom calls.
- Commands you ask Pitroom to run on purpose, such as `--verify` or a plan's test commands.
- Problems that need local access to your account, which already has everything Pitroom has.

Thank you for helping keep users safe.
