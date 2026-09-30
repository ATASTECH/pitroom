// Git guard: a `git` shim put first on the worker's PATH.
//
// Worker permission layers match shell commands as written, so `git push` can be
// denied while `sh -c "git push"`, `env git push`, a Makefile or a script calling
// git are not. The shim sees every git invocation that goes through PATH and
// refuses anything that changes history, refs, the index or discards work.
// Limits (documented): calling git by absolute path bypasses PATH (also denied
// by the bash profile), and this is not an OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { home } from '../core/store.js';

const VERSION = 1;

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
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (path.resolve(dir) === skip) continue;
    const p = path.join(dir, 'git');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/**
 * Environment for the worker process: git shim first on PATH, and settings that
 * stop git from ever waiting for a password, an editor or a pager.
 */
export function guardEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const quiet = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
  if (process.platform === 'win32') return { ...env, ...quiet };
  const dir = shimDir();
  const real = findRealGit(dir);
  if (!real) return { ...env, ...quiet };
  const file = path.join(dir, 'git');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== SHIM) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, SHIM, { mode: 0o755 });
    fs.renameSync(tmp, file);
  }
  return { ...env, ...quiet, PITROOM_REAL_GIT: real, PATH: `${dir}${path.delimiter}${env.PATH ?? ''}` };
}
