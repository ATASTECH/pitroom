// Git guard: a `git` shim put first on the worker's PATH.
//
// Worker permission layers match shell commands as written, so `git push` can be
// denied while `sh -c "git push"`, `env git push`, a Makefile or a script calling
// git are not. The shim sees every git invocation that goes through PATH and
// refuses anything that changes history, refs, the index or discards work.
// Layer 1 (this shim) gives friendly, precise refusals but lives on PATH, which
// login shells and absolute paths bypass; layer 2 below (git's own env config)
// catches those. Neither is an OS sandbox: working-tree edits in --write mode are
// undone with `pitroom revert`, and --isolate never touches the user's tree.
import fs from 'node:fs';
import path from 'node:path';
import { renameOver } from '../core/fs-atomic.js';
import { home } from '../core/store.js';

const VERSION = 2;
const WINDOWS = process.platform === 'win32';
// MSYS paths inside Git for Windows' sh accept forward slashes; backslashes in a git config value or an `[ -x ]` test are asking for trouble.
const fwd = (p: string) => (WINDOWS ? p.replace(/\\/g, '/') : p);

const SHIM = `#!/bin/sh
# pitroom git guard v${VERSION}. Blocks git commands that change history, refs, the
# index or discard work. The primary agent reviews and commits, not the worker.
set -f
real="\${PITROOM_REAL_GIT:-}"
if [ -z "$real" ] || [ ! -x "$real" ]; then
  echo "pitroom: git guard cannot find the real git" >&2
  exit 127
fi
block() {
  echo "pitroom: 'git $1' is blocked for workers (the primary agent reviews and commits)" >&2
  exit 1
}
sub=""; skip=""; after=""
for a do
  if [ -n "$sub" ]; then after="$after $a"; continue; fi
  case "$skip" in
    c) skip=""; case "$a" in [Aa][Ll][Ii][Aa][Ss].*) block "-c $a" ;; esac; continue ;;
    v) skip=""; continue ;;
  esac
  case "$a" in
    -c|--config-env) skip=c ;;
    -C|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path) skip=v ;;
    -*) ;;
    *) sub="$a" ;;
  esac
done
[ -z "$sub" ] && exec "$real" "$@"

# Resolve aliases (also those injected via GIT_CONFIG_* env); shell aliases are refused.
depth=0
while def=$("$real" config --get "alias.$sub" 2>/dev/null) && [ -n "$def" ]; do
  depth=$((depth+1)); [ "$depth" -gt 5 ] && block "$sub (alias loop)"
  case "$def" in '!'*) block "$sub (shell alias)" ;; -*) block "$sub (alias with options)" ;; esac
  next=\${def%% *}
  [ "$next" != "$def" ] && after=" \${def#* }$after"
  sub="$next"
done

has() { for f in "$@"; do case " $after " in *" $f "*|*" $f="*) return 0 ;; esac; done; return 1; }
count() { n=0; for w in $after; do case "$w" in -*) ;; *) n=$((n+1)) ;; esac; done; echo "$n"; }

case "$sub" in
  commit|push|pull|reset|checkout|restore|clean|stash|rebase|merge|switch|cherry-pick|revert|am|\\
  worktree|update-ref|update-index|filter-branch|filter-repo|gc|prune|replace|notes|add|rm|mv|\\
  sparse-checkout|read-tree|commit-tree|write-tree|fast-import|bisect)
    block "$sub" ;;
  branch)
    has -d -D --delete -m -M --move -c -C --copy -f --force -u --set-upstream-to --unset-upstream --edit-description && block "branch$after"
    [ "$(count)" -gt 0 ] && ! has -l --list --contains --no-contains --merged --no-merged --points-at && block "branch$after" ;;
  tag)
    has -d --delete -a --annotate -s --sign -u --local-user -f --force -m --message -F --file && block "tag$after"
    [ "$(count)" -gt 0 ] && ! has -l --list --contains --no-contains --merged --no-merged --points-at && block "tag$after" ;;
  config)
    has --unset --unset-all --add --replace-all --rename-section --remove-section -e --edit set unset rename-section remove-section edit && block "config$after"
    [ "$(count)" -ge 2 ] && ! has get --get --get-all --get-regexp --get-urlmatch && block "config$after" ;;
  remote)
    for w in $after; do case "$w" in add|remove|rm|rename|set-url|set-head|set-branches|prune|update) block "remote $w" ;; esac; done ;;
  fetch)
    for w in $after; do case "$w" in -*) ;; *:*) block "fetch $w (writes a local ref)" ;; esac; done ;;
  apply)
    has --index --cached -3 --3way && block "apply$after" ;;
  reflog)
    has expire delete && block "reflog$after" ;;
  symbolic-ref)
    has -d --delete && block "symbolic-ref$after"
    [ "$(count)" -ge 2 ] && block "symbolic-ref$after" ;;
  submodule)
    for w in $after; do case "$w" in -*) ;; status|summary) break ;; *) block "submodule $w" ;; esac; done ;;
esac
exec "$real" "$@"
`;

export function shimDir(): string {
  return path.join(home(), 'shim', `v${VERSION}`);
}

function findRealGit(skip: string): string | undefined {
  const same = (a: string, b: string) => (WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (same(path.resolve(dir), skip)) continue;
    const p = path.join(dir, WINDOWS ? 'git.exe' : 'git');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

// Git for Windows ships its own sh.exe (<root>\bin or <root>\usr\bin), which also runs the hooks below. The shim is
// that same sh script; `git.cmd` is the door for cmd.exe and PowerShell, `git` (no extension) the one for Git Bash.
function findGitSh(realGit: string): string | undefined {
  let dir = path.dirname(realGit);
  for (let i = 0; i < 4; i++) {
    for (const rel of ['bin/sh.exe', 'usr/bin/sh.exe']) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return p;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

// `MSYS2_ARG_CONV_EXCL`: the arguments reached cmd.exe already in Windows form, so sh must not "convert" them again.
const cmdShim = (sh: string) => `@echo off\r\nset "MSYS2_ARG_CONV_EXCL=*"\r\n"${sh}" "%~dp0git" %*\r\nexit /b %errorlevel%\r\n`;

// Second layer, carried in environment variables so it survives what PATH does not:
// login shells (macOS path_helper and ~/.zprofile reorder PATH; Codex runs commands
// through `zsh -lc`), absolute paths like /usr/bin/git, and scripts. Git reads
// GIT_CONFIG_COUNT/KEY_n/VALUE_n on every invocation:
//   core.hooksPath → a reference-transaction hook that refuses every ref update
//                    (commit, reset, branch/tag, stash, rebase, merge; --no-verify
//                    does not skip it);
//   url.<x>.pushInsteadOf "" → every push URL is rewritten to an unreachable one.
const HOOK_VERSION = 1;
const REF_HOOK = `#!/bin/sh
# pitroom git guard (layer 2, v${HOOK_VERSION}): refuse ref updates made by workers.
[ "$1" = prepared ] || exit 0
echo "pitroom: git ref updates (commit, reset, branch, tag, stash, rebase, merge) are blocked for workers" >&2
exit 1
`;

export const hooksDir = () => path.join(home(), 'git-hooks', `v${HOOK_VERSION}`);

function writeIfChanged(file: string, content: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o755 });
  renameOver(tmp, file);
}

/** Appends git config entries to GIT_CONFIG_COUNT/KEY_n/VALUE_n, keeping any the user set. */
function withGitConfig(env: NodeJS.ProcessEnv, entries: [string, string][]): NodeJS.ProcessEnv {
  const out = { ...env };
  let n = Number(env.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of entries) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/**
 * Environment for the worker process: git guard (PATH shim + ref/push guard in git's
 * own env config), and settings that stop git from waiting for a password, an
 * editor or a pager.
 */
export function guardEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const quiet = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
  writeIfChanged(path.join(hooksDir(), 'reference-transaction'), REF_HOOK);
  env = withGitConfig(env, [
    ['core.hooksPath', fwd(hooksDir())],
    ['url.pitroom-push-blocked://.pushInsteadOf', ''],
  ]);
  const dir = shimDir();
  const real = findRealGit(dir);
  if (!real) return { ...env, ...quiet };
  let sh: string | undefined;
  if (WINDOWS) {
    sh = findGitSh(real);
    if (!sh) return { ...env, ...quiet };
    writeIfChanged(path.join(dir, 'git.cmd'), cmdShim(sh));
  }
  writeIfChanged(path.join(dir, 'git'), SHIM);
  // On Windows the variable is `Path` (any casing) and a second `PATH` key would be ambiguous.
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, ...quiet, PITROOM_REAL_GIT: fwd(real), [key]: `${dir}${path.delimiter}${env[key] ?? ''}` };
}

/** Whether the git shim (layer 1) would be put first on a worker's PATH here. */
export function shimReady(): boolean {
  const env = guardEnv({ ...process.env });
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return Boolean(env[key]?.startsWith(shimDir()));
}
