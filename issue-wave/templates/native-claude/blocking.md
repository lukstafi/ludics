## Blocking rule (the one that costs the most when broken)

The coordinator reads a turn that ends as a handoff or a hand-back. Never end a turn with a watch,
a wait, a suite or any detached process still running. There is NO `TaskOutput` tool in your
runtime, and `Monitor` or a background-completion notification is not a wait either: it arrives
after your turn has ended, and it may never wake you. What holds a turn is a foreground Bash call,
and only up to the subagent cap, 180 s today (ludics#972). So every run, and `pr-review.sh watch`,
`pr-review.sh merge --wait`, `pr-review.sh local-review` and every `execution leg`/`execution hold`
in particular (never in the foreground), goes through `~/.claude/skills/issue-wave/scripts/bg-run.sh`
in two foreground calls, under one absolute parent for all your runs, `@@SCR@@/runs`:

    # foreground; prints the fresh <dir> at once
    ~/.claude/skills/issue-wave/scripts/bg-run.sh spawn "@@SCR@@/runs" -- <cmd> [arg...]
    # foreground with Bash timeout 600000, re-issued until it prints rc= (spell the printed <dir> out)
    ~/.claude/skills/issue-wave/scripts/bg-run.sh wait <dir>

The other sections call a command run this way a long run. One `wait` per Bash call, and leave
`--within` to its default (170 s, read off the cap). Read
`issue-wave/references/native-claude.md`, *Blocking on a run*, for the verdicts:
- `rc=<n>` (exit 0): finished with status `<n>`; the output is in `<dir>/log`.
- `RUNNING` (3): the designed return: re-issue the wait.
- `STARTING` (4): re-issue it once; a second one means the launch failed.
- `STOPPED` (7): the run was stopped on purpose (`bg-run.sh stop`). Do not re-arm it.
- `DIED` (5): the run was killed. Re-arm it with a new `spawn`, and for `merge --wait` first
  re-read the merge state.

Ending a turn "while the watch runs" costs the coordinator a resume and loses time. The remedy for
a running watch or merge wait is to keep re-issuing `bg-run.sh wait <dir>` until it prints `rc=`.
Never `bg-run.sh stop` your own watch or merge wait in order to end a turn "with nothing running":
stopping is only for a pause the coordinator asks for (ludics#1045).
