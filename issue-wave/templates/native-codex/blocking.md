## Blocking rule (the one that costs the most when broken)

Keep your turn open until every command you own has actually exited. This includes suites,
`pr-review.sh local-review`, `pr-review.sh watch`, `pr-review.sh checks --wait`,
`pr-review.sh merge --wait`, and every `execution leg` or `execution hold`. Run them in the
foreground of `exec_command`; retain a returned session ID and use `write_stdin` until the
session reports its terminal status. There is no native Codex subagent foreground cap requiring
background launch. The other sections call a command held this way a long run.

When a run record is needed, allocate a fresh directory, then start it in the same managed
foreground session:

    D=$(~/.claude/skills/issue-wave/scripts/bg-run.sh new "@@SCR@@/runs")
    ~/.claude/skills/issue-wave/scripts/bg-run.sh start "$D" -- <cmd> [arg...]
    cat "$D/rc"; tail -n 30 "$D/log"

Keep the session ID, run directory, log path and observed revision in your report.
`bg-run.sh wait <dir>` printing `rc=<n>` means the command finished with verdict `<n>`.
A returned directory or background notification does not prove completion. For local native
runs use managed foreground `start`, as `issue-wave/references/native-codex.md`, *Local managed
command sessions*, describes.

Before retrying a `DIED` or uncertain run, reconcile the session, pid/cpid, surviving processes,
runner records and Git/PR state; re-read merge state before restarting a merge wait. `DIED`
provides no exit status and does not prove every child stopped. Ask the coordinator to reconcile
outstanding reservations before a replacement run or writer starts. `STOPPED` (exit 7) means the
run was stopped deliberately: do not re-arm it without a decision to resume.

Never finish your turn while a command is running or stop a watcher merely to hand back.
Send requests and gate changes to the coordinator mid-turn; keep waiting on live sessions.
