## Blocking rule (the one that costs the most when broken)

For ASSIGNED commands, *Requests* states which run record `EXECUTION_RESULT` must name.

The coordinator reads only a turn that ends, as a handoff or a hand-back. Run `pr-review.sh watch`,
`pr-review.sh merge --wait`, `pr-review.sh local-review`, `execution leg`, `execution hold` and
every suite in the foreground. The other sections call a command run this way a long run.
When `run_command` returns a managed task, stop calling tools and wait for agy's reactive wakeup
without polling.

For a process detached with `bg-run.sh spawn`, block on `bg-run.sh wait <dir>` in the same turn.
Apply the wakeup rule while `run_command` manages that wait. When the wait returns `RUNNING`,
issue it again. Retry `STARTING` once, then treat a second `STARTING` as a launch failure.
Read the batch's exit status from `rc=<n>` and finish waiting before sending the final message.

When a long run can outlast what your shell tool allows one call, give it a run record and still
keep it in the foreground, under one absolute parent for all your runs, `@@SCR@@/runs`:

    D=$(~/.claude/skills/issue-wave/scripts/bg-run.sh new "@@SCR@@/runs")   # prints a fresh directory
    ~/.claude/skills/issue-wave/scripts/bg-run.sh start "$D" -- <cmd> [arg...]
    cat "$D/rc"; tail -n 30 "$D/log"

Never wait with a sleep loop of your own.
