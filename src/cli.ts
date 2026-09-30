import { backendIds } from './backends/index.js';
import { parse, exitCodeFor, has } from './cli/args.js';
import * as cmd from './cli/commands.js';
import { doctor } from './core/doctor.js';
import { UserError } from './core/errors.js';
import { VERSION, execute } from './core/run.js';
import { readMeta } from './core/store.js';

const HELP = `pitroom ${VERSION} — a free pit crew for your expensive coding agent.
Delegates bounded tasks to a worker agent CLI (${backendIds().join(', ')}), using the
worker's own default model, and returns a compact answer, exact changes and a receipt.

Usage
  pitroom [run] [options] "task"        run a worker (task: argument, "-" for stdin, or --task-file)
  pitroom crew [options] -g NAME "task 1" "task 2" …
                                        start several workers in background as one group
  pitroom status [run | -g NAME]        state / live progress (default: latest run)
  pitroom wait [run… | -g NAME] [--any] [--brief] [--timeout 540]
                                        block until all (or any) are done, then print reports
  pitroom watch [run… | -g NAME] [--json] [--interval 2]
                                        live table (TTY) or one JSON line per change, until done
  pitroom show [run] [--patch|--events|--full|--json]
  pitroom ls [--running] [-g NAME]      recent runs
  pitroom apply [run | -g NAME]         apply --isolate patch(es) to your tree (checked first)
  pitroom discard [run]                 drop an --isolate run's copy (the patch is kept)
  pitroom revert [run]                  undo the changes of a --write run (checked first)
  pitroom stop [run | -g NAME]          stop running or queued workers
  pitroom savings [--since 7d|30d|all] [--card file.svg] [--badge]
  pitroom doctor [--probe]              check workers, models, permissions, skills
  pitroom config                        effective settings, where each comes from, config file path
  pitroom install [--copy] [--force]    link the skills into ~/.agents/skills + ~/.claude/skills,
                                        and the CLI into ~/.local/bin
  pitroom uninstall                     remove what install linked
  pitroom clean [--days 14] [--yes]

Run options
  -r, --read            read-only research / review (default)
  -w, --write           edit your working tree; changes are snapshotted and revertible
  -i, --isolate         edit an isolated copy of your current state; you apply the patch
  -d, --dir PATH        project directory (default: cwd)
  -f, --file PATH       attach a file (repeatable)
  -W, --worker T        worker target "backend[:model]" (default: config "worker", else opencode)
  -m, --model M         model for that worker (default: the worker CLI's own default)
  -t, --timeout DUR     e.g. 900, 20m, 1h (default 30m, or PITROOM_TIMEOUT)
      --verify CMD      run CMD after the worker (in the isolated copy for --isolate)
      --link a,b        isolate: symlink ignored dirs (e.g. node_modules) into the copy
  -c, --continue RUN    follow up in the same worker session (and the same isolated copy)
      --bg              start in background, print the run id, return immediately
  -g, --group NAME      tag the run as part of a group (crew, wait, watch, apply by group)
      --web             let the worker use webfetch/websearch (off by default)
      --no-fallback     do not fail over to fallback workers on model/provider errors
      --json            print the run record as JSON
      --task-file PATH  read the task from a file (crew: tasks separated by --- lines)
      --allow-non-git   allow --write outside a git repository (no tracking/revert)

Parallel: at most maxParallel workers (default 4, PITROOM_MAX_PARALLEL) run at once; others queue.
          One --write run per repository; use --isolate for parallel changes.
Exit codes: 0 ok · 1 worker failed · 2 usage · 3 refused/setup · 4 timeout
            5 read-only violation · 6 verify failed · 75 still running (wait again)
Workers: ${backendIds().join(', ')} (targets: "opencode", "opencode:provider/model", or a bare model)
Env: PITROOM_WORKER, PITROOM_MODEL, PITROOM_FALLBACK="t1,t2", PITROOM_TIMEOUT, PITROOM_MAX_PARALLEL,
     PITROOM_PRIMARY=sonnet|opus|haiku|gpt-5, PITROOM_PRICE="in,out", PITROOM_HOME, PITROOM_CONFIG,
     PITROOM_<WORKER>_BIN
Config: ~/.config/pitroom/config.json (worker, fallback, timeout, primary, price, link, web, maxParallel)`;

type Command = (p: ReturnType<typeof parse>) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  run: cmd.cmdRun,
  crew: cmd.cmdCrew,
  status: cmd.cmdStatus,
  wait: cmd.cmdWait,
  watch: cmd.cmdWatch,
  show: cmd.cmdShow,
  ls: cmd.cmdLs,
  list: cmd.cmdLs,
  apply: cmd.cmdApply,
  revert: cmd.cmdRevert,
  discard: cmd.cmdDiscard,
  stop: cmd.cmdStop,
  savings: cmd.cmdSavings,
  doctor: (p) => doctor(has(p, 'probe')),
  config: cmd.cmdConfig,
  install: cmd.cmdInstall,
  uninstall: cmd.cmdUninstall,
  clean: cmd.cmdClean,
  // internal: the detached process behind --bg
  __exec: async (p) => exitCodeFor(await execute(readMeta(p.positional[0]!))),
};

async function main(argv: string[]): Promise<number> {
  let [name, ...rest] = argv;
  if (name === undefined) name = 'help';
  else if (name !== 'help' && name !== 'version' && !COMMANDS[name]) {
    rest = argv; // a bare task: `pitroom "find where X is handled"`
    name = 'run';
  }
  const p = parse(rest);
  if (has(p, 'help') || name === 'help') return console.log(HELP), 0;
  if (has(p, 'version') || name === 'version') return console.log(VERSION), 0;
  return COMMANDS[name]!(p);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UserError) {
      console.error(`pitroom: ${e.message}`);
      process.exit(e.code);
    }
    console.error(`pitroom: ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
