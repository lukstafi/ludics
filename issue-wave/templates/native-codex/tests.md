## Running tests

Run each batch from your worktree through its execution host's run-time slot, in the spelling
the project section gives. Keep the command in a local managed `exec_command` session, with its
whole output recorded outside the worktree:

    cd "@@WT@@" && ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot --cpu --wait 1800 --wait-window -- <batch> > "@@SCR@@/runs/<label>.log" 2>&1

Use `--cpu` before `--` for a batch that holds no GPU; drop it for one that does. `--wait 1800`
waits for a shared slot, and `--wait-window` waits out a coordinator's measurement window.
The command after `--` is exec'd, so a shell builtin goes as `sh -c '...'`.
Never pipe a suite: that would report the last stage's status. Join dependent steps with `&&`
or use a script with `set -eo pipefail` that pipes nothing.

If `exec_command` returns a session ID, retain it and observe that session with `write_stdin`
until it reports the command's terminal exit status. Keep your turn open during slot and window
waits too. Read the log afterwards with `tail` or `rg`. `EXECUTION SLOT REFUSED` means the batch
never ran, not that its tests failed. A handle, a log path or elapsed time proves no result.

A commit gated on a batch is made only after that batch's own exit 0, with no intervening edit.
Your standing reservation `@@WAVE@@-@@T@@-@@HOST@@-iterate` (kind correctness, execution host
`@@HOST@@`, checkout your worktree) covers targeted batches. Report each batch's command, log,
wall time and exit status. For work beyond that reservation, message the coordinator using the
request block below and wait for assignment before starting it; report the result immediately
by message, then wait for further dispatch.
