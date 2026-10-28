// Shell commands no worker may run, whatever its CLI: history-changing git, bulk deletes and privilege, killing
// processes (which could kill the primary agent), publishing, and other agents (no recursive delegation). Each
// adapter turns the list into its CLI's own rules; the git guard env layer backs the git part up. OpenCode's
// profiles and policies/gemini/shell.toml spell it in their own formats, and a test keeps them in step.
export const FORBIDDEN_COMMANDS = [
  'git commit', 'git push', 'git pull', 'git reset', 'git checkout', 'git restore', 'git clean', 'git stash',
  'git rebase', 'git merge', 'git switch', 'git branch', 'git tag', 'git rm', 'git worktree', 'git update-ref',
  'git config', 'git remote', 'git cherry-pick', 'git revert', 'git am', 'git add',
  'rm -rf', 'rm -fr', 'rm -r', 'rm -R', 'rm --recursive', 'sudo', 'chown', 'kill', 'pkill', 'killall', 'gh', 'npm publish',
  'pitroom', 'opencode', 'claude', 'codex', 'gemini', 'qwen', 'kilo', 'kilocode', 'agy', 'cursor-agent', 'agent',
];
