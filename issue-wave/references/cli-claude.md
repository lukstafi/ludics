# Claude Code coordinator, CLI workers

A CLI worker is a headless `claude -p` process or `codex exec` turn in a detached tmux session
on a fleet box, launched and supervised through `fleet-worker.sh` by a coordinator of either
provider. This file is written for a Claude Code coordinator, and its workers can be Claude or
Codex invocations (`--kind claude` / `--kind codex`); the shared issue requirements of the
brief, the base gate and the preflight are in SKILL.md, and the handoff for a worker that
cannot message the coordinator is the [CLI reservation handoff](executions.md#cli-reservation-handoff).

## Launch

CLI workers use `~/.claude/skills/issue-wave/scripts/fleet-worker.sh`. Each is a detached
tmux session on its agent box running the selected `claude` or `codex` CLI, with events, stderr,
exit code and session id under `~/.local/state/issue-wave/workers/<name>/`. A Codex worker is
one `codex exec` turn per process with its brief on stdin. A Claude worker is one long-lived
`claude -p --input-format stream-json` process whose input is that directory's append-only
`input.jsonl`, the brief its first line: it stays up between turns, and every later message
reaches the same process (the script header has the mechanics and the states). Detached CLI
workers run without permission prompts: retain the triage screen of the full issue body and
comments before launch. Issues with untrusted outside participation are deferred or handled
under ordinary permission controls, not dispatched unscreened.

Write the brief to a file and launch with the selected kind (`--kind claude` with `-- --model
opus --effort high` for requested Opus, or `--kind codex` with the user's supported Codex model
flags):

```bash
fleet-worker.sh launch <box> <repo>-<issue> --target-repo <owner/repo> --kind claude --brief <brief-file> \
  --repo '~/<project checkout>' --branch claude/<topic> [-- <model flags>]
fleet-worker.sh attach <box> <repo>-<issue>     # Bash run_in_background: the wake signal
```

`launch` creates `<checkout>-worktrees/<name>` off `origin/master` on the box (`FLEET_BASE_REF`
for another default, `--base` for one launch, `--cwd` for a worktree that already exists) and
prints the session id that addresses every later intervention. `attach` blocks until the
worker's turn ends and prints one verdict line, riding out ssh drops and box naps by retrying
from the coordinator's side: `IDLE` for a Claude worker whose turn answered the latest message
and whose process now awaits input (`FAILED ... idle` if that turn ended in an error), and
`DONE` / `FAILED` / `VANISHED` for a process that has ended; run it as a harness-tracked
background task, one per worker, and its completion notification is the wake signal - exactly
the wait-and-proceed shape. An `IDLE` or `DONE` line is a returned turn and nothing more
(SKILL.md, Supervise: *A returned turn means the turn ended*): read the turn's final message
with `fleet-worker.sh log <box> <name> --last-result` for a request or a result before calling
the issue finished. It prints that message whole and nothing else (a Claude worker's last
`result`, a Codex worker's last `agent_message` of its last ended turn), or one
`NO RESULT <box>/<name>: <why>` line with exit 1 when no turn has ended with one; plain `log` is
the tail of every turn's text, and cuts a long hand-back.

## Blocking in a headless turn

A Codex worker's turn ending is its process ending, as a one-shot `claude -p` turn's was:
`codex exec` exits, and every background task it started dies with it, so no watch survives to
wake it, no notification or heartbeat reaches it, and only the coordinator's `unstick` runs it
again (2026-09-23: the ocannl#1032 worker armed `pr-review.sh watch` and a CI wait in the
background, ended its turn on "the watch will wake me", and left an exited session with no
watch running; ludics-lite#361). A Claude worker's process outlives its turn, and so do its
background tasks: a task's completion starts a turn of its own (Claude Code 2.1.282, probed
2026-09-26), and `attach` does not report `IDLE` while the stream lists one. A `ScheduleWakeup`
is not in the stream, though, so a Claude worker whose turn ended on one reads as `IDLE`. The
brief of every CLI worker tells it to block inside the turn on every watch, wait and suite until
the command returns - bounded calls re-issued, never an `until`/`sleep` loop:

- a Claude worker runs anything that can outlast the 600 s foreground cap under `bg-run.sh`, as
  [native-claude.md, *Blocking on a run*](native-claude.md#blocking-on-a-run) says: `spawn`
  (`fleet-worker.sh execution slot --bg` for a slot-held batch) prints the run directory, then
  foreground `wait` calls re-issued in the SAME turn until one prints `rc=`;
- a Codex worker keeps the command in the foreground of its turn, as
  [native-codex.md](native-codex.md#what-a-returned-turn-means) says.

`attach` marks a `DONE` or `IDLE` line `PROBABLE STRAND` when the turn's final message announces
a wait still pending (its header lists the phrases it reads); treat it as a returned turn whose
watch is gone (or, on an `IDLE` line, was never a background task), and `unstick` the worker
with the wait to run in the foreground.

## Supervising

- **The stall test is `fleet-worker.sh status <box> <name>`**: one line with the worker's state
  (`RUNNING`, `IDLE`, `ORPHANED`, `EXITED(n)`, `VANISHED`), the stream's event count and quiet
  time, the last event type, and the worktree's head age and dirty count; for a Claude worker
  also its turn state, its listed background tasks, and how many messages it has not echoed
  yet (`unread`). A `RUNNING` worker is silent between events and has no yield signal, so the
  test is **stream quiet AND worktree unmoved over a wall-clock window sized to the task** (a
  long test run is quiet on both for its duration; a review round is not), read the same way
  on every box. The machine-level checks of SKILL.md's *Verify
  externally* apply on top.
- **Nothing is stranded by a coordinator interruption; the wave just went unobserved.**
  Detached workers keep running on their boxes, so after any interruption the recovery is
  `fleet-worker.sh ls` across the fleet, then `attach` again per running worker and
  `status`/verdict per finished one, and `log --last-result` for a turn that ended while
  unobserved. A fleet-length wave (10 h and more) is therefore not a
  heartbeat problem. `attach` itself retries an unreachable box for ~40 minutes before giving
  up (exit 4 - wake the box and re-attach).

## Intervening

- **CLI workers: unstick through the script.** Write the imperative message to a file (do X now,
  in this turn, do not yield; never as command-line text - issue prose is full of backticks and
  `$()`) and run `fleet-worker.sh unstick <box> <name> --message <file>`. Its line says which path
  it took. A live Claude worker takes the message by append (`APPENDED`): one more line of its
  input, read by the same process at its next tool boundary mid-turn, or as its next turn when
  idle - no restart, no second writer. The line says `delivered` once the CLI has echoed the
  message, `queued` while it has not (a worker inside a long tool call reads it when the call
  returns; `status` counts it `unread`), and `attach` then waits for the reply to THAT message. A
  message is not an interrupt. To stop a live Claude worker's turn now, mid-tool-call included,
  add `--interrupt` (`unstick <box> <name> --interrupt [--message <file>]`). It sends the CLI's
  own interrupt request on the same channel and prints `INTERRUPTED ... from=RUNNING|IDLE` once
  the CLI's receipt is in the stream. Only then does it append the message, which runs as the
  next turn of the same process. Without a message, the aborted turn stands as the latest reply,
  and `attach` reads it as `FAILED ... idle error_during_execution ... terminal_reason=aborted_tools`,
  which a crash does not name. A message the CLI had already queued survives the interrupt (the
  receipt's `still_queued` counts it) and runs next.
  With no receipt within `FLEET_DELIVERY_WAIT`, the line reads `INTERRUPT UNCONFIRMED` and the
  message is NOT sent. That is a wedged CLI: use `--kill`. `--interrupt` never falls back to a
  kill or a resume. For a wedged Claude worker, or a live Codex exec (which has no
  input channel), pass `--kill`: the script stops the tmux session, waits for the CLI process to
  be gone, then resumes the recorded session in a new process (`RESUMED`) - full context retained,
  same worktree (resume has no `-C`; the script `cd`s first). A worker whose process has ended
  resumes without `--kill`. Without `--kill` the script REFUSES to resume beside a live exec,
  because that gives the branch two writers, one of them possibly a finisher mid-rebase, and a
  quiet stream does not prove the exec cannot still act. Do NOT reach for `codex queue --thread
  <id> --message` for an exec worker: an entire `codex exec` run is ONE turn and queued messages
  deliver only at a turn boundary - the message sits undelivered while the worker keeps doing the
  thing you queued it to stop (2026-08-30: a tip-chasing worker ran 50 more minutes past its
  queued stop). Escalation is two failed interventions, then the coordinator takes over the
  mechanical remainder or spawns a Claude finisher on the worktree's branch - after `status` shows
  the stalled session gone. A finisher landing a stalled worker's branch does not inherit its
  transcript, so after the merge `unstick` the ORIGINAL session (idle or ended, no `--kill`
  needed) with the hand-back brainstorm prompt - the friction that grounds `after-merge` is in
  that session, on that box, and removal-comes-last has kept its worktree alive; only if the
  session is unresumable does the coordinator brainstorm from the diff and say so.
- **CLI model-capacity errors end execs; resume the recorded session.** A CLI worker whose
  `attach` line reads `FAILED ... turn.failed ... "Selected model is at capacity"` (or a Claude
  worker's `is_error=true` on a provider error) is terminal for that turn, not for the session.
  The work is durable (briefs mandate early commits): `unstick` with a disk-first note (trust
  `git log`/`git status` and the PR state over the session's memory; re-run anything whose
  result is not in a file) recovered 2/2 cleanly on 2026-08-30. Expect kills to cluster
  (capacity is global); resume victims as their `attach` notifications arrive.

## Close-out

A Claude worker's process ends only when its input closes: once its hand-back turn is read
(`log <box> <name> --last-result`),
`fleet-worker.sh close <box> <name>` closes the input, waits for the exit and prints the final
`DONE`/`FAILED` verdict (it refuses a worker mid-turn or with its latest message unanswered; on
an ended worker it prints the verdict as it stands). `fleet-worker.sh ls` must show no `RUNNING`, no `IDLE` and no `ORPHANED` CLI worker on
any box before the wave closes: an orphan is a CLI still writing after its tmux session died -
wait for it, or `unstick --kill` it, never close out over it. Then, and only then, remove CLI
workers' worktrees on their boxes (`ssh <box> 'git -C <checkout> worktree remove <path>'`), once
no outstanding reservation refers to the checkout. The finished worker records under
`~/.local/state/issue-wave/workers/` can stay as evidence; `launch` refuses to overwrite one
without `--replace`.
