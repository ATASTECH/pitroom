// Antigravity CLI adapter: `agy -p … --output-format stream-json`, locked down with agy's own mechanisms where they
// hold, and with Pitroom's where they do not (checked against agy 1.3.5, docs/backends.md):
//   read-only    agy has no read-only mode for -p runs (google-antigravity/antigravity-cli#45), and --mode plan still
//                writes in them (#1181). So `readOnly: 'snapshot'`: the core gives every read run a read-only snapshot
//                of its own, never the project or a shared one. --mode plan is passed anyway (it answers a question
//                directly); write and isolate use accept-edits.
//   --sandbox    shell commands run in agy's terminal sandbox (the workspace writable, .git read-only, no network)
//   HOME         agy reads its settings only from ~/.gemini/antigravity-cli/settings.json (no variable moves it), so
//                a worker runs with a home of Pitroom's own, one per workspace (<pitroom home>/antigravity-home/<id>),
//                whose settings.json holds Pitroom's rules: commands granted (a headless run refuses an ungranted
//                one), and denied: the workspace's secret files by absolute path, history-changing git and the like,
//                other agents, MCP and the web. The user's sign-in is linked in (the keychain folder on macOS, the
//                token file elsewhere). Conversations of workers stay there too, so a follow-up finds its own.
// Never --dangerously-skip-permissions. A refused tool call can end agy's turn with status SUCCESS, no answer and
// exit 0, so a run without an answer is a failure here.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSecretFiles, looksSecret } from '../../core/secrets.js';
import { home } from '../../core/store.js';
import { FORBIDDEN_COMMANDS } from '../deny.js';
import { findBinary, resolveCommand } from '../exec.js';
import { linkInto, writeIfChanged } from '../home.js';
import { splitModel } from '../text.js';
import type { Backend, DoctorCheck, Failure, FailureKind, ParsedRun, WorkerRequest } from '../types.js';
import { parseEvents } from './events.js';

const binary = () => findBinary('agy', 'PITROOM_ANTIGRAVITY_BIN', ['~/.local/bin/agy', '~/.antigravity/bin/agy']);

function agy(args: string[], timeout = 30_000) {
  const { command, prefix } = resolveCommand(binary());
  const r = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: !!r.error };
}

/** agy's data folder under a home: settings.json, conversations, the sign-in file where there is no keychain. */
const dataDir = (h: string) => path.join(h, '.gemini', 'antigravity-cli');

/** The user's own agy folder. */
const userDir = () => dataDir(os.homedir());

const TOKEN = 'antigravity-oauth-token';

/** Secrets outside any workspace that a worker never reads, as paths under the user's home. */
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.netrc', '.docker', '.kube', '.config/gcloud', '.config/gh', '.gemini', 'Library/Keychains'];

/**
 * The command deny rules, in agy's matching: a rule is a command prefix compared word by word, after agy has split
 * the command line at `;`, `&&`, `|` and the like and taken off wrappers such as `env -i`, `timeout 60` or `xargs`.
 * `regex:` rules compare each word with one regex word (agy splits the pattern at spaces and drops backslashes, so
 * the patterns have neither; `.*` stands for exactly one word). So each forbidden command is denied as it is, by
 * path (`/usr/bin/git commit`), behind git's global options (`git --no-pager push`), and a recursive delete
 * wherever its option stands. The git guard is what holds for git whatever the spelling; .git is read-only in the
 * sandbox too.
 */
export function denyCommandRules(): string[] {
  const subcommands = FORBIDDEN_COMMANDS.filter((c) => c.startsWith('git ')).map((c) => c.slice(4));
  const anywhere = (cmd: string, option: string) => [0, 1, 2, 3, 4, 5].map((n) => `${cmd} ${'.* '.repeat(n)}${option}`);
  return [
    ...FORBIDDEN_COMMANDS.map((c) => `command(${c})`),
    ...FORBIDDEN_COMMANDS.filter((c) => !c.startsWith('git ')).map((c) => `command(regex:.*/${c})`),
    // git by path would bypass the git guard's PATH shim; -C, -c, --git-dir and --work-tree point it elsewhere
    'command(regex:.*/git)',
    'command(regex:git (-C|-c|--git-dir.*|--work-tree.*))',
    `command(regex:git -.* (${subcommands.join('|')}))`,
    `command(regex:git -.* -.* (${subcommands.join('|')}))`,
    // a recursive delete however its options are spelled or placed (rm -Rf, rm -r -f, rm dir -rf, rm --recursive)
    ...['rm', '.*/rm'].flatMap((rm) => [...anywhere(rm, '-[a-zA-Z]*[rR][a-zA-Z]*'), ...anywhere(rm, '--recursive')]).map((r) => `command(regex:${r})`),
    // find runs what follows -exec itself, and agy does not take it apart; such a rule only holds when it spans the
    // whole command (a prefix of it was seen not to match), so find with -exec, -ok or -delete is refused outright,
    // up to six words before and after (grep -r does what find -exec grep did)
    ...['find', '.*/find'].flatMap((find) => [0, 1, 2, 3, 4, 5, 6].flatMap((before) => [0, 1, 2, 3, 4, 5, 6].flatMap((after) => {
      const words = (n: number) => ' .*'.repeat(n);
      return [
        ...(after ? [`${find}${words(before)} -(exec|execdir|ok|okdir)${words(after)}`] : []),
        `${find}${words(before)} -delete${words(after)}`,
      ];
    }))).map((r) => `command(regex:${r})`),
    // xargs runs its arguments as a command, and agy does not take it apart either; with a `{}` in it a rule has
    // to span the whole command again, so the words after the command are spelled out too
    ...['xargs', '.*/xargs'].flatMap((xargs) => [0, 1, 2, 3].flatMap((n) => [0, 1, 2, 3].flatMap((after) => [
      `${xargs}${' .*'.repeat(n)} (.*/)?(${FORBIDDEN_COMMANDS.filter((c) => !c.includes(' ')).join('|')})${' .*'.repeat(after)}`,
      `${xargs}${' .*'.repeat(n)} (.*/)?git (${subcommands.join('|')})${' .*'.repeat(after)}`,
      `${xargs}${' .*'.repeat(n)} (.*/)?rm -[a-zA-Z]*[rR][a-zA-Z]*${' .*'.repeat(after)}`,
    ]))).map((r) => `command(regex:${r})`),
    // a command line with a `{}` in it is not split into commands: a rule is then matched against the whole line,
    // so these find xargs and find wherever they stand in it
    `command(regex:.*git (${subcommands.join('|')}).*)`,
    'command(regex:.*rm -[a-zA-Z]*[rR].*)',
    `command(regex:.*xargs .*rm -[a-zA-Z]*[rR].*)`,
    `command(regex:.*xargs .*git .*(${subcommands.join('|')}).*)`,
    'command(regex:.*find .*-(exec|execdir|ok|okdir) .*)',
    'command(regex:.*find .*-delete.*)',
    // a command inside a string is not matched above
    'command(regex:(ba|z|da|k)?sh -[a-zA-Z]*c[a-zA-Z]*)',
    'command(regex:.*/(ba|z|da|k)?sh -[a-zA-Z]*c[a-zA-Z]*)',
    'command(eval)',
  ];
}

/**
 * Pitroom's settings for agy workers in one workspace. One file for every mode, since a follow-up continues its
 * conversation in the same home: what differs by mode is agy's own --mode. Deny beats allow in agy's rules.
 * `read_file` rules take absolute paths only (a relative one breaks the sandbox), so the workspace's secret files are
 * listed one by one. A denied read also denies the write. `reads` are the folders and files outside the workspace
 * that the task names (`outsideReads`), granted read-only, minus the secret files in them.
 */
export function workerSettings(workspace: string, workerHome: string, reads: OutsideRead[] = []) {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const both = (p: string) => [...new Set([p, real(p)])];
  const secrets = [
    ...findSecretFiles(workspace).map((f) => path.join(workspace, f)),
    ...reads.flatMap((r) => r.secrets),
    ...HOME_SECRETS.map((f) => path.join(os.homedir(), f)).filter((p) => fs.existsSync(p)),
    // the keychain link of the worker's own home
    path.join(workerHome, 'Library'),
  ];
  return {
    ...baseSettings(),
    permissions: {
      // plan mode writes its plan into agy's own data folder, which is outside the workspace; the user's toolchains
      // under their home stay usable in the sandbox (read-only), which sees only what is granted besides the system
      allow: [
        'command(*)',
        ...both(path.join(dataDir(workerHome), 'brain')).map((p) => `write_file(${rulePath(p)})`),
        ...toolchains().flatMap(both).map((p) => `read_file(${rulePath(p)})`),
        // what the task names outside the workspace: a headless agy cannot ask, and would end the turn unanswered
        ...reads.map((r) => r.path).flatMap(both).map((p) => `read_file(${rulePath(p)})`),
      ],
      deny: [
        ...secrets.flatMap(both).map((p) => `read_file(${rulePath(p)})`),
        ...denyCommandRules(),
        'mcp(*)',
        // No web for agy workers: the rule is in the settings file, so --web cannot switch it on per run.
        'read_url(*)',
        'execute_url(*)',
      ],
    },
  };
}

/**
 * The folders of PATH inside the user's home (an nvm or pyenv node/python, ~/.cargo/bin, ~/.local/bin). A `bin`
 * inside a versioned install (…/versions/…, …/toolchains/…) brings its install along, as node needs its lib for npm;
 * other folders only themselves, as their parent may hold credentials (~/.cargo/credentials.toml).
 */
function toolchains(): string[] {
  const homeDir = os.homedir();
  const inHome = (d: string) => {
    const rel = path.relative(homeDir, d);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d) && inHome(d) && fs.existsSync(d));
  const install = (d: string) => (path.basename(d) === 'bin' && /[\\/](versions|toolchains)[\\/]/.test(d) ? path.dirname(d) : d);
  return [...new Set(dirs.map(install))].filter((d) => !inHome(home()) || path.relative(home(), d).startsWith('..'));
}

/**
 * Shell commands run in agy's terminal sandbox without asking: a headless run refuses an ungranted command, which
 * can end the turn without an answer. command(*) grants them; the deny rules still win. Edits are approved by
 * --mode accept-edits.
 */
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const MAX_READS = 20;

/**
 * The absolute paths (or `~/…`) a prompt names: a path starts at the start of the text, after a space, a quote, a
 * bracket or `=`, and ends before a space, a quote, a bracket or trailing punctuation. With where each one stands.
 */
function pathsIn(prompt: string): { raw: string; at: number; abs: string }[] {
  const out: { raw: string; at: number; abs: string }[] = [];
  for (const m of prompt.matchAll(/(^|[\s"'`(\[<{=])((?:~|[A-Za-z]:)?[\\/][^\s"'`)\]>}]*)/g)) {
    const raw = m[2]!.replace(/[.,;:!?]+$/, '');
    const abs = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
    if (raw && path.isAbsolute(abs)) out.push({ raw, at: m.index! + m[1]!.length, abs });
  }
  return out;
}

const realOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/** A path with its links resolved as far as it exists, so a file not yet written still has a place. */
function resolved(p: string): string {
  let dir = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    const r = realOf(dir);
    if (r) return path.join(r, ...rest);
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(p);
    rest.unshift(path.basename(dir));
    dir = up;
  }
}

const inside = (p: string, dir: string) => {
  const rel = path.relative(dir, p);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export interface OutsideRead {
  path: string;
  /** Every secret-looking file in it, to deny. */
  secrets: string[];
}

/** Entries a granted folder may hold: its secret files are found by looking at every one, or it is not granted. */
const MAX_SCANNED = 20_000;

/**
 * All the secret-looking files under `dir`, at any depth and in every folder; undefined when there are too many
 * entries to be sure, when a link in it leads out of it or nowhere (the link's name says nothing about what it
 * opens), or when a folder in it cannot be read: whatever cannot be checked is not granted.
 */
function allSecrets(dir: string): string[] | undefined {
  const root = realOf(dir) ?? dir;
  const found: string[] = [];
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      if (++seen > MAX_SCANNED) return undefined;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        // a link inside the folder is checked where it leads, which is scanned too; one out of it is not granted
        const target = realOf(p);
        if (!target || !inside(target, root)) return undefined;
        if (looksSecret(e.name)) found.push(p);
      } else if (e.isDirectory()) stack.push(p);
      else if (looksSecret(e.name)) found.push(p);
    }
  }
  return found;
}

/**
 * The folders and files outside the workspace that a task names by absolute path (or `~/…`) and that exist, such as
 * "copy the components from /tmp/ui-source": agy's file tools stay in the workspace, and without a grant a headless
 * agy cannot ask, so the read is refused and the turn ends without an answer. They are granted read-only (the
 * sandbox mounts them read-only too), with every secret-looking file in them denied. Never: the root or a top-level
 * folder (/tmp, /usr), your home itself or a folder above it, a folder holding the workspace or the project (that
 * would open the project and its secrets around a snapshot), a dot-folder in your home or ~/Library (they hold
 * credentials and apps' session tokens), Pitroom's own state, a secret-looking file, or a folder too big to check for secrets; and nothing on
 * Windows. The secrets in your home stay denied whatever is named.
 */
export function outsideReads(prompt: string, workspace: string, project?: string): OutsideRead[] {
  // agy compares Windows paths without their drive letter, so a grant would also open the same path on every drive
  if (process.platform === 'win32') return [];
  const homeDir = realOf(os.homedir()) ?? os.homedir();
  const ws = realOf(workspace) ?? path.resolve(workspace);
  const proj = project ? resolved(project) : undefined;
  const own = realOf(home()) ?? home();
  const found = new Map<string, OutsideRead>();
  for (const { abs } of pathsIn(prompt)) {
    // a named path is taken where its links lead, so a link's name does not decide what is opened
    const p = realOf(abs);
    if (!p || found.has(p) || inside(p, ws) || inside(p, own)) continue;
    if (inside(homeDir, p) || inside(ws, p) || (proj && inside(proj, p))) continue;
    if (p.split(/[\\/]/).filter(Boolean).length < 2) continue;
    // dot-folders in your home, and ~/Library on macOS, hold credentials and apps' session tokens
    if (inside(p, homeDir) && /^(\.|Library([\\/]|$))/.test(path.relative(homeDir, p))) continue;
    if (!isDir(p)) {
      if (!looksSecret(path.basename(p))) found.set(p, { path: p, secrets: [] });
    } else {
      const secrets = allSecrets(p);
      if (secrets) found.set(p, { path: p, secrets });
    }
    if (found.size >= MAX_READS) break;
  }
  return [...found.values()];
}

function baseSettings() {
  return {
    enableTerminalSandbox: true,
    toolPermission: 'proceed-in-sandbox',
    artifactReviewPolicy: 'always-proceed',
    allowNonWorkspaceAccess: false,
  };
}

/**
 * A path as agy compares it: agy drops backslashes from a rule, and on Windows it strips the drive letter and turns
 * backslashes into slashes before it compares a path, so a rule is written that way too.
 */
const rulePath = (p: string) => p.replace(/^[A-Za-z]:(?=[\\/])/, '').replace(/\\/g, '/');

const HOMES_KEPT_DAYS = 14;

/**
 * The worker home for a workspace: its settings rewritten when they change, the user's sign-in linked in. Homes
 * not used for two weeks are removed (their conversations with them: a follow-up then starts a new one).
 */
function workerHome(workspace: string, reads: OutsideRead[] = []): string {
  const root = path.join(home(), 'antigravity-home');
  const id = crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16);
  const dir = path.join(root, id);
  fs.mkdirSync(dataDir(dir), { recursive: true });
  writeIfChanged(path.join(dataDir(dir), 'settings.json'), `${JSON.stringify(workerSettings(workspace, dir, reads), null, 2)}\n`);
  // macOS finds the sign-in through the login keychain under $HOME/Library/Keychains; elsewhere it is a file
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.join(dir, 'Library'), { recursive: true });
    linkInto(path.join(dir, 'Library'), path.join(os.homedir(), 'Library', 'Keychains'));
  } else {
    linkInto(dataDir(dir), path.join(userDir(), TOKEN));
  }
  const now = new Date();
  fs.utimesSync(dir, now, now);
  pruneHomes(root, dir);
  return dir;
}

function pruneHomes(root: string, keep: string): void {
  const cutoff = Date.now() - HOMES_KEPT_DAYS * 86_400_000;
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (dir === keep || !/^[0-9a-f]{16}$/.test(name)) continue;
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}

/**
 * The prompt with the project's paths turned into the copy's: a worker in a snapshot or an isolated copy that is told
 * about /…/project/src/a.ts reads and edits its own copy of it, not the project (which it may not read or write at
 * all: agy would end its turn there). Paths are compared with their links resolved (/tmp and /private/tmp alike).
 */
export function inCopy(prompt: string, project?: WorkerRequest['project']): string {
  if (!project || project.root === project.copy) return prompt;
  const root = resolved(project.root);
  let out = '';
  let from = 0;
  for (const { raw, at, abs } of pathsIn(prompt)) {
    const p = resolved(abs);
    if (!inside(p, root)) continue;
    out += prompt.slice(from, at) + path.join(project.copy, path.relative(root, p));
    from = at + raw.length;
  }
  return out + prompt.slice(from);
}

function invocation(req: WorkerRequest) {
  const prompt = inCopy(req.prompt, req.project);
  const args = [
    // -p takes the prompt as its value; one that starts with "-" would be read as an option: a leading space keeps it a value.
    '-p', prompt.startsWith('-') ? ` ${prompt}` : prompt,
    '--output-format', 'stream-json',
    '--mode', req.mode === 'read' ? 'plan' : 'accept-edits',
    '--sandbox',
    // agy's own limit (5m by default) would end a long run with partial output and exit 0; Pitroom's timeout governs.
    '--print-timeout', '24h',
  ];
  // The conversation id of the stream: never --continue (the latest conversation), which is unsafe beside parallel workers.
  if (req.sessionId) args.push('--conversation', req.sessionId);
  const { model, effort } = splitModel(req.model);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  const { command, prefix } = resolveCommand(binary());
  const workerDir = workerHome(req.cwd, outsideReads(prompt, req.cwd, req.project?.root));
  // The worker's commands see this home too: the user's own dotfiles stay out of their reach.
  const env: Record<string, string> = { HOME: workerDir };
  if (process.platform === 'win32') env.USERPROFILE = workerDir;
  return { command, args: [...prefix, ...args], env };
}

export function classify(message: string): FailureKind {
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|too many requests|overloaded|\b503\b|capacity/i.test(message)) return 'rate-limited';
  if (/not (signed|logged) in|\bsign.?in\b|\blog ?in\b|authenticat|PERMISSION_DENIED|oauth|credential|keyring|keychain|\b401\b|unauthori[sz]ed/i.test(message)) {
    return 'auth';
  }
  if (/model.{0,80}(not found|not available|no longer available|does not exist|unknown|unsupported|invalid)|unknown model|invalid model|NOT_FOUND|\b404\b/i.test(message)) {
    return 'model-unavailable';
  }
  return 'other';
}

const TIMED_OUT = /print timeout after/i;
const BLOCKED = /^This request was blocked by \S+ filters\b/;

function failure(run: ParsedRun, stderr: string, exitCode: number | null): Failure | undefined {
  const lines = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  // agy 1.2.6+ prints a structured "AGY_ERROR {…}" line; otherwise the first line that says what went wrong.
  const envelope = lines.find((l) => l.startsWith('AGY_ERROR'));
  const detail = (envelope && fromEnvelope(envelope)) ?? lines.find((l) => /RESOURCE_EXHAUSTED|error|failed|quota|exhausted|denied|not found|\bsign.?in\b/i.test(l) && !TIMED_OUT.test(l));
  if (exitCode === 0 && !run.error) {
    // a prompt the model's safety filter blocks comes back as a normal answer with status SUCCESS
    if (BLOCKED.test(run.finalText)) return { kind: 'other', message: `the model's filter blocked the request: ${run.finalText.split('\n')[0]}` };
    if (run.finalText) return undefined;
    // agy ends with exit 0 and no answer for a used-up quota, its own timeout, a refused tool call (which discards
    // the whole turn) and, in some versions, a pipe it writes nothing to: none of them is an empty answer.
    if (detail) return { kind: classify(detail), message: detail };
    if (lines.some((l) => TIMED_OUT.test(l))) return { kind: 'other', message: 'agy stopped at its own --print-timeout before answering' };
    if (run.usage.denied) return { kind: 'other', message: 'agy ended its turn without an answer when a tool call was refused' };
    if (!run.sessionId && !stderr.trim()) return { kind: 'other', message: 'agy printed nothing (some agy versions write no output to a pipe); update agy' };
    return { kind: 'other', message: 'agy ended without an answer (a refused tool call ends its turn with no other sign)' };
  }
  const message = run.error ?? detail ?? lines.at(-1) ?? `agy exited with code ${exitCode}`;
  return { kind: classify(`${message} ${detail ?? ''}`), message };
}

/** agy continues an unknown conversation id as a new conversation, saying so only on stderr. */
function warnings(_run: ParsedRun, stderr: string): string[] {
  const lost = /conversation "([^"]+)" not found/i.exec(stderr);
  return lost ? [`agy did not find the earlier conversation (${lost[1]}) and started a new one: this answer does not know the earlier turns`] : [];
}

/** `AGY_ERROR: {"short_error": "RESOURCE_EXHAUSTED (code 429): Individual quota reached…", "status": …}` */
function fromEnvelope(line: string): string | undefined {
  try {
    const e = JSON.parse(line.slice(line.indexOf('{')));
    if (typeof e.short_error === 'string' && e.short_error) return e.short_error;
    const text = [e.status ?? e.code, e.message ?? e.error].filter((v) => typeof v === 'string' && v).join(': ');
    return text || undefined;
  } catch {
    return line.replace(/^AGY_ERROR:?\s*/, '') || undefined;
  }
}

function doctor({ models, hasFallback }: { models: (string | undefined)[]; hasFallback: boolean }): DoctorCheck[] {
  const version = agy(['--version']);
  if (version.missing || !version.ok) {
    return [{
      level: 'fail',
      message: `agy not runnable (${binary()}). Install the Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash), or set PITROOM_ANTIGRAVITY_BIN`,
    }];
  }
  const checks: DoctorCheck[] = [
    { level: 'ok', message: `Antigravity CLI ${version.out.trim().split('\n')[0]} at ${binary()}` },
    {
      level: 'warn',
      message: 'the Antigravity worker is in beta (checked against agy 1.3.5). agy has no read-only mode for headless runs, so its read runs always read a snapshot of the project; prefer -i for changes',
    },
  ];
  if (process.platform === 'win32') {
    checks.push({ level: 'warn', message: "agy's permission rules and terminal sandbox are for macOS and Linux; on Windows run the Antigravity worker only with -i (an isolated copy)" });
  }
  // Workers run with a home of Pitroom's own: on macOS the sign-in is found through the linked keychain folder;
  // elsewhere it is a file that is linked in.
  if (process.platform === 'linux' && !fs.existsSync(path.join(userDir(), TOKEN))) {
    checks.push({ level: 'warn', message: 'no Antigravity sign-in file found: if a run fails to sign in, run `agy` once and sign in with your Google account' });
  }
  for (const m of models) checks.push({ level: 'ok', message: m ? `Antigravity model: ${m}` : "Antigravity model: agy's own choice (`agy models` lists yours)" });
  checks.push({ level: 'ok', message: 'Antigravity workers have no web access (--web does not apply to them)' });
  if (!hasFallback) checks.push({ level: 'warn', message: 'no fallback workers configured for Antigravity runs (its quota is per account and can run out for hours)' });
  return checks;
}

export const antigravity: Backend = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  capabilities: { readOnly: 'snapshot', resume: 'by-id', reportsCost: false, attachFiles: false },
  binary,
  invocation,
  parse: parseEvents,
  failure,
  warnings,
  doctor,
};
