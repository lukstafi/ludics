# Codex coordinator, native workers

The Codex-specific half of a native wave; the shared body - placement, launch, board,
supervision, recovery, close-out, the two-worker smoke - is [native-workers.md](native-workers.md).
Read the currently callable runtime tool schemas: Codex typically exposes `spawn_agent`,
`list_agents`, `send_message`, `followup_task`, `interrupt_agent` and `wait_agent`. Model tiers
for Codex workers are SKILL.md's *Codex model choice*.

## Worker channel

A Codex native worker can keep its turn open, so the handoff is message-shaped: before any
fleet correctness or measurement run beyond its
[standing reservations](executions.md#standing-iteration-reservation) (its agent host's, and its
GPU home box's where the coordinator took one), the worker messages the
coordinator with revision, execution host, workload kind, the bounded command, checkout and
intended log path, then waits for dispatch. The coordinator completes the reservation (the
worker's checkout as the payload's `checkout`), runs
`fleet-worker.sh execution run <reserve.json>` (`execution window --deadline <seconds> <box>
<reserve.json>` for a measurement on a box where workers hold standing reservations, its
deadline as [executions.md](executions.md#exclusivity-and-the-run-time-slots) says),
and answers the same agent with the
assignment; the worker runs only that, blocks on it to completion, and reports the run
directory, observed SHA and exit in its reply, which `execution conclude --from-run <run>
--request <id> --sha <sha>` consumes. A Codex worker may also use the fixed `EXECUTION_REQUEST`
/ `EXECUTION_RESULT` blocks of [native-claude.md](native-claude.md#worker-channel); what
differs is only that it may wait instead of yielding.

Name the workload kind in that assignment and use the wrapper specified in
[executions.md](executions.md#reserve-launch-observe-conclude): correctness takes a run-time
slot; an exclusively reserved measurement runs the bounded project runner directly, under
`fleet-worker.sh execution hold --request <request_id> -- <command>` (the OS-level sleep guard
alone, inside which a runner's own `execution slot` runs instead of being refused).

## Local managed command sessions

For local long-running commands on a native Codex runtime with managed exec sessions, keep
the command in the foreground of `exec_command`, retain the returned session ID and observe
it with the runtime's stdin/wait tool until it actually exits. This also applies to review
watchers and merge waits. Keep the turn open; a returned handle or run directory is launch
evidence, never a terminal verdict.

When a `bg-run.sh` record is needed, allocate a fresh directory with `bg-run.sh new <parent>`,
then run `bg-run.sh start <dir> -- <command> [arg...]` in that managed foreground session.
Retrieve its terminal status and read the recorded `rc` and `log`; `bg-run.sh wait <dir>`
reporting `rc=<n>` means the command finished, and `<n>` is the command's verdict. Preserve the
session ID, run directory, log path and observed revision in the board or worker report.
Verification still uses its assigned correctness slot or measurement hold, as above.

This shape recovered local runs in the 2026-10-04 mac-studio wave
([ludics-lite#540](https://github.com/lukstafi/ludics-lite/issues/540)). Local `bg-run.sh spawn`
calls returned directories but later reported `DIED`, with vanished pid/cpid, empty logs and
no `rc`: the coordinator's integration command and a worker's review/checks watchers both
hit it. Managed foreground `start` sessions stayed running and reached actual command
evidence; remote spawn over SSH stayed live. The termination cause is unknown, so this is a
local native-runtime observation, not a universal claim about `spawn` or a change to the
Claude and remote CLI instructions.

Before retrying a `DIED` or uncertain run, reconcile its session, pid/cpid and any surviving
command processes against the runner records and Git/PR state. In particular, re-read merge
state before restarting a merge wait. `DIED` supplies no command exit status and cannot prove
that all child work stopped: do not credit a result, launch duplicate verification or start
a replacement writer until ownership and outstanding execution reservations are accounted
for. Resume the same worker with the same model when it is still resumable. If the worker
itself is gone, use the shared [finisher and reconciliation policy](native-workers.md#supervision-recovery-and-evidence)
only after proving the old writer stopped; the coordinator handles reservation
reconciliation before dispatching further work.

`STOPPED` (exit 7, ludics-lite#638) is not `DIED`: `bg-run.sh stop` ended the run on purpose and
no process of it is left. It is NOT retried or re-armed, since a re-arm would relaunch what was
stopped; re-arm only on a decision to resume, as for a fresh run. `execution conclude
--from-bg-run` concludes it `cancelled`.

## Coordinator supervision

Keep a current snapshot at the top of the board (worker, PR/head, gate, runner handle and
outstanding reservation), with the historical log below it. Routine registry reads use
`execution list --active --compact`; full records remain available for reconciliation.

Let each worker's tracked review/CI watcher own its polling loop. The coordinator independently
checks launches, reported gate changes and merges, and investigates a stale report or failed
watcher; it need not duplicate every unchanged poll. When only a coordinator-owned integration
run remains, wait on that runner's tracked handle rather than on completed agents. Retain live
handles across context compaction and retrieve their actual terminal verdicts. Relay useful
milestones and keep any harness-required progress updates brief.

## What a returned turn means

The rule is SKILL.md's (Supervise: *A returned turn means the turn ended*); on this runtime the
signal is a `wait_agent` return, and a background process the worker started is not finished by
it. Briefs require blocking on every run inside the turn - the project runner's own `wait`, or
keeping the turn open.

Codex still needs the deployed `ship-pr`, `wait-and-proceed`, and `after-merge` skills, a
self-contained brief, and the full implement-through-merge lifecycle. Ask for the PR,
verification results, residuals and chip candidates in its final report. Codex commits carry no
Claude trailer; include relevant project conventions in the brief or `AGENTS.md`.
