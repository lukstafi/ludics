## Running tests

Run every batch through the box's run-time slot lock, one batch per run, from the worktree, in the
spelling the project section gives, always in the background form, and block on it inside your
turn. Claude Code moves a native worker's foreground Bash call to the background at the subagent
cap (180 s today), so a foreground `execution slot -- <batch>` holds nothing. There is no "will this
fit?" judgment to make:

    # foreground; prints <dir> at once
    cd "@@WT@@" && ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot --bg "@@SCR@@/runs" --cpu --wait 1800 --wait-window -- <batch>
    # foreground, Bash timeout 600000, re-issued until it prints rc= (spell the printed <dir> out)
    ~/.claude/skills/issue-wave/scripts/bg-run.sh wait <dir>

`--cpu` goes before the `--` for a batch that holds no GPU; drop it for one that does.
`--wait 1800`: several workers share the box's slots, so wait for one instead of failing.
`--wait-window` waits out a coordinator's measurement window on the box inside the batch: keep
re-issuing the wait. The command after `--` is exec'd, so a shell builtin goes as `sh -c '...'`.
**Never pipe a suite**, inside that `sh -c` or anywhere: `rc=` is then the pipe's last stage, and a
failed suite reads green (ludics#989). Steps that belong together go joined with `&&`, as a script
under `set -eo pipefail` that pipes nothing, or as one batch each; read `<dir>/log` with `tail` or
`grep` in a later call. A slot refusal prints `EXECUTION SLOT REFUSED`: that batch never ran, and
it is not a test failure.

A commit gated on a batch (the project section names any such gate) reads that batch's own
published status once the wait has printed `rc=`, with no edit in between, and never chains the
commit after the batch with `;`:

    cd "@@WT@@" && [ "$(cat <dir>/rc)" = 0 ] && git commit ...; echo "gate exit=$?"; tail -n 20 <dir>/log

Your standing reservation `@@WAVE@@-@@T@@-@@HOST@@-iterate` (kind correctness, execution host
`@@HOST@@`, checkout your worktree) covers these targeted batches, with no per-batch request.
Report each batch by its run directory, with its command, wall time and exit status, in your
messages.
