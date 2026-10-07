// Per-run permission profiles, injected through OPENCODE_CONFIG_CONTENT (and KILO_CONFIG_CONTENT: Kilo Code's CLI is
// an OpenCode fork with the same permission system, see ../kilo).
// The user's OpenCode config (models, providers, keys) is never modified, and no
// model is chosen here: agents without a `model` use OpenCode's configured default.
//
// Every rule is "allow" or "deny", never "ask": `opencode run` is non-interactive,
// so an "ask" would stall or silently reject. Later keys win in OpenCode, so the
// broad "*" rule comes first and specific rules follow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Mode } from '../types.js';

export const AGENT = { read: 'pitroom-read', write: 'pitroom-write' } as const;

type Rule = 'allow' | 'deny';
type Perm = Rule | Record<string, Rule>;

const READ_FILES: Record<string, Rule> = {
  '*': 'allow',
  // Keep secrets away from third-party / free model providers.
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
  '*.env.sample': 'allow',
  '*.pem': 'deny',
  '*id_rsa*': 'deny',
  '*id_ed25519*': 'deny',
};

const READ_ONLY_BASH: Record<string, Rule> = {
  '*': 'deny',
  'git status*': 'allow',
  'git diff*': 'allow',
  'git log*': 'allow',
  'git show*': 'allow',
  'git grep*': 'allow',
  'git blame*': 'allow',
  'git ls-files*': 'allow',
  'ls*': 'allow',
  pwd: 'allow',
  'rg *': 'allow',
  'wc *': 'allow',
  // Flags that would let "read" commands execute or write.
  'rg *--pre*': 'deny',
  'git *--output*': 'deny',
  'git *--ext-diff*': 'deny',
};

const FORBIDDEN_BASH = [
  // history, branches and anything that can discard uncommitted work
  'git commit*', 'git push*', 'git reset*', 'git checkout*', 'git restore*', 'git clean*',
  'git stash*', 'git rebase*', 'git merge*', 'git switch*', 'git branch*', 'git tag*',
  'git rm*', 'git worktree*', 'git update-ref*', 'git filter-branch*', 'git filter-repo*',
  'git gc*', 'git prune*', 'git reflog*', 'git config*', 'git remote*', 'git cherry-pick*',
  'git revert*', 'git am*', 'git add*', 'git mv*', 'git pull*', 'git -C*', 'git --git-dir*', 'git --work-tree*',
  // git by absolute path would bypass the PATH shim (see guard.ts)
  '/*/git*',
  // bulk deletion and privilege
  'rm -rf*', 'rm -fr*', 'rm -r *', 'rm -R *', 'rm --recursive*', 'sudo *', 'su *', 'doas *',
  'chown *', 'chmod -R*', 'dd *', 'mkfs*', 'shutdown*', 'reboot*',
  // killing processes could kill the primary agent
  'kill *', 'pkill*', 'killall*',
  // publishing / remote side effects
  'gh *', 'npm publish*', 'pnpm publish*', 'yarn publish*', 'cargo publish*', 'twine upload*',
  // no recursive delegation
  'opencode*', 'kilo *', 'kilocode*', 'pitroom *', '*pitroom*',
];

/** The CLI's own scratch dirs must stay usable (tool output and shell sessions spill there): `app` is its folder name. */
function scratchDirs(app: App): Record<string, Rule> {
  const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  const rules: Record<string, Rule> = {
    '*': 'deny',
    [path.join(data, app, 'tool-output', '*')]: 'allow',
    [path.join(data, app, 'shell', '*', '*')]: 'allow',
  };
  // macOS reports /var/folders/… while OpenCode resolves /private/var/folders/….
  for (const tmp of new Set([os.tmpdir(), realpath(os.tmpdir())])) rules[path.join(tmp, app, '*')] = 'allow';
  return rules;
}

/** Which CLI the profiles are for: OpenCode, or Kilo Code's fork of it (its own data and temp folders). */
export type App = 'opencode' | 'kilo';

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const COMMON: Record<string, Perm> = {
  skill: { '*': 'allow', '*pitroom*': 'deny' },
  task: 'deny', // subagents carry their own, broader permissions
  // v2 "execute" runs namespaced tools (browser automation, the OpenCode API itself).
  execute: 'deny',
  question: 'deny', // nobody is there to answer
  doom_loop: 'deny',
};

/**
 * Web tools are off unless asked for: a prompt injection hidden in the repo could
 * otherwise make a read-only worker send code to an arbitrary URL.
 */
const web = (on: boolean): Record<string, Rule> => ({ webfetch: on ? 'allow' : 'deny', websearch: on ? 'allow' : 'deny' });

export function readProfile(allowWeb = false, app: App = 'opencode'): Record<string, Perm> {
  return {
    '*': 'deny',
    read: READ_FILES,
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    codesearch: 'allow',
    todowrite: 'allow',
    todoread: 'allow',
    ...web(allowWeb),
    // v1 calls the shell tool "bash", v2 "shell"; both get the same rules.
    bash: READ_ONLY_BASH,
    shell: READ_ONLY_BASH,
    edit: 'deny',
    external_directory: scratchDirs(app),
    ...COMMON,
  };
}

export function writeProfile(allowWeb = false, app: App = 'opencode'): Record<string, Perm> {
  const bash: Record<string, Rule> = { '*': 'allow' };
  for (const pattern of FORBIDDEN_BASH) bash[pattern] = 'deny';
  return {
    '*': 'allow',
    read: READ_FILES,
    ...web(allowWeb),
    bash,
    shell: bash,
    external_directory: scratchDirs(app),
    ...COMMON,
  };
}

export function agentFor(mode: Mode): string {
  return mode === 'read' ? AGENT.read : AGENT.write;
}

/** Builds OPENCODE_CONFIG_CONTENT (or KILO_CONFIG_CONTENT), merged over any value the user already set. */
export function configContent(existing: string | undefined, allowWeb = false, app: App = 'opencode', extra: Record<string, unknown> = {}): string {
  const ours = {
    ...extra,
    agent: {
      [AGENT.read]: {
        mode: 'primary',
        description: 'pitroom: read-only worker (research, search, review)',
        permission: readProfile(allowWeb, app),
      },
      [AGENT.write]: {
        mode: 'primary',
        description: 'pitroom: editing worker (no git history changes, no bulk deletes)',
        permission: writeProfile(allowWeb, app),
      },
    },
  };
  let base: unknown = {};
  if (existing?.trim()) {
    try {
      base = JSON.parse(existing);
    } catch {
      base = {};
    }
  }
  return JSON.stringify(deepMerge(base, ours));
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObject(a) || !isObject(b)) return b;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
