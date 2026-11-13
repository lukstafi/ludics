## Blocking rule (the one that costs the most when broken)

The coordinator reads only a turn that ends, as a handoff or a hand-back. No background process
outlives your turn and no notification wakes you: when `codex exec` ends, everything it started
dies with it. So never end a turn with a watch, a wait, a suite or any detached process still
running, and never end one "while the watch runs". `pr-review.sh watch`, `pr-review.sh merge
--wait`, `pr-review.sh local-review` and every `execution leg` or `execution hold` run in the
foreground of your turn, like every suite, and you keep polling their session until each exits.
The other sections call a command run this way a long run.

When a long run can outlast what your shell tool allows one call, give it a run record and still
keep it in the foreground, under one absolute parent for all your runs, `@@SCR@@/runs`:

    D=$(~/.claude/skills/issue-wave/scripts/bg-run.sh new "@@SCR@@/runs")   # prints a fresh directory
    ~/.claude/skills/issue-wave/scripts/bg-run.sh start "$D" -- <cmd> [arg...]   # foreground: poll it to its exit
    cat "$D/rc"; tail -n 30 "$D/log"

Never use `bg-run.sh spawn` and then end the turn, and never wait with a sleep loop of your own.
