# Claude Code coordinator, native workers

The Claude-specific half of a native wave; the shared body - placement, launch, board,
supervision, recovery, close-out, the two-worker smoke - is [native-workers.md](native-workers.md).
The tools are what this runtime exposes: `Agent` spawns a worker (it returns the agent's name
or ID, which is the address for everything after), `SendMessage` continues a spawned agent
with its context intact, `ListAgents` lists the ones currently running, `TaskStop` ends a
background task. Read their current schemas; a deferred tool is loaded with `ToolSearch` first.

## Blocking on a run

A native worker has no tool that holds its turn on a background task. `TaskOutput` is absent
from its runtime (2026-09-23: three workers, `ToolSearch select:TaskOutput` matched nothing), so
name it only where the runtime lists it. `Monitor` and background-completion notifications are
not waits either: they arrive after the turn has ended, and a worker that yields on one may not be
woken. What holds a turn is a foreground Bash call, capped at 600 s. So:

- a project-runner batch blocks with `tools/test-run.sh wait last --timeout 540`, re-issued
  on exit 124 until the run's own status comes back;
- anything that can outlast the cap, ship-pr's `pr-review.sh watch` and `merge --wait` included
  (never run in the foreground: a live 👀 can stretch a watch to its 20-minute grace), runs under
  [`scripts/bg-run.sh`](../scripts/bg-run.sh) in two calls. `spawn` takes one absolute parent
  for all your runs (under the scratchpad with the issue prefix), allocates a fresh
  `<parent>/run-<N>` no run has used, starts the command there detached, and prints that `<dir>`;
  a slot-held batch is `fleet-worker.sh execution slot --bg <parent>`, which does the same around
  the slot (inside an enclosing slot too). Spell the printed `<dir>` out in the wait, since a Bash
  call's variables do not reach the next one:

  ```bash
  # foreground; each prints <dir> at once
  ~/.claude/skills/issue-wave/scripts/bg-run.sh spawn <parent> -- <cmd> [arg...]
  ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot --bg <parent> -- <batch>
  # foreground, re-issued until it prints rc=
  ~/.claude/skills/issue-wave/scripts/bg-run.sh wait <dir>
  ```

  `wait` blocks for its whole bound, `--within`, default 540 s so it ends under the 600 s cap,
  unless the run settles first, and prints one line led by its verdict; its exit code says the
  same. While it blocks it writes a `bg-run: still waiting after <e> s ...` line to stderr every
  120 s. `rc=<n>` (exit 0): the command finished with status `<n>`, and its
  output is `<dir>/log`. The status is a file of its own, so a review body quoting `rc=` cannot
  end the wait. `RUNNING after <e> s of --within <w>` (3): the bound was spent with the run still
  live, the designed return: re-issue it (an `<e>` under `<w>` is a bug worth reporting). A
  slow CI takes several of these. `STARTING` (4): no pid within a minute of the wait:
  re-issue it once, and a second one means the launch itself failed, so spawn again. `DIED` (5):
  the run was killed before the command returned, which says nothing about what the command was
  reading: re-arm it, and for `merge --wait` first re-read the merge state as ship-pr's *The
  approval is one gate* says. `REFUSED` (6): the directory held a run that had ended; a directory
  `spawn` allocated never does. Every re-arm takes a new `spawn`. A spawned run is no background
  task of the harness's, so a task-stop does not reach it. Stop it through `<dir>/cpid`, whose
  first line is the command's pid and second its start time:

  ```bash
  p=$(head -n 1 <dir>/cpid)
  [ "$(TZ=UTC LC_ALL=C ps -o lstart= -p "$p" | tr -d ' ')" = "$(sed -n 2p <dir>/cpid)" ] && kill "$p"
  ```

  The start-time match is the identity check `wait` makes, so a run that has ended, its pid since
  reused, is left alone. The kill reaches the command's own process and nothing else: a child it
  is running at that moment (a `gh` call, a `sleep`) runs on to its own end, and a `merge` already
  inside its merge call can still land. Never kill the process group instead: a spawned run
  shares its caller's, so a group kill takes the caller down too. Stopping the whole tree is
  #510's `bg-run.sh stop`. The older form, `new` and then `start` as a Bash
  `run_in_background: true` task, still works; the harness killed such a task at ~40 min into a
  `merge --wait`, which is `DIED`. The script's header is the full contract, the run directory's
  layout included, and `test-bg-run.sh` beside it pins the races each verdict closes
  (ludics-lite#357, #388).

## Worker channel

A Claude Code native worker cannot wait mid-turn: nothing lets it block on a coordinator
message, and ending its turn is its only way to yield. So the "message the coordinator and
wait for dispatch" shape of [native-codex.md](native-codex.md#worker-channel) is Codex's; the
Claude shape is turn-shaped, and SKILL.md's brief template names it. It carried four issues
and a release through five PRs on 2026-09-15 with no stranded worker.

1. **Standing reservation, at launch.** The coordinator takes one `kind: correctness`,
   `"standing": true` reservation per worker on its agent host with `fleet-worker.sh execution
   run` (request id `<wave>-<issue>-<host>-iterate`; see [executions.md](executions.md)) and
   names it in the brief. It pre-authorizes the worker's own targeted test batches there -
   each through the project runner (`tools/test-run.sh run ...`), blocked to completion inside
   the turn, reported by run directory in the worker's messages - with no per-batch request. It
   is concluded at hand-back from the last batch's record. Being standing, it consumes no
   correctness slot, so a box holds as many as it has workers and a worker never waits on a
   sibling's brief-reading to start. The brief tells the worker to wrap each batch in the
   run-time lock instead - `fleet-worker.sh execution slot -- <batch>`, which takes one of the
   box's slots for exactly as long as the batch runs (six on mac-studio, four on rog-nv-linux
   with two GPU tokens that a batch declared `--cpu` does not take, four on minix-amd-linux,
   three on tuf-amd-linux, one on a box the spec does not name) and
   refuses while a measurement is outstanding there; a measurement still needs the box to itself through the registry.
   A refusal naming a *measurement window* means the coordinator is measuring on the box and has
   suspended the worker's standing reservation until it concludes: the worker keeps working
   without the batch and retries it once the window closes, with no request.
2. **Request, for everything else.** A measurement, a cross-box leg, a full suite: the worker
   ends its turn with its final message carrying the block, one per request and each naming one
   execution host, back to back with nothing after the last (ahrefs/ocannl#1168 wrote its four
   requests as prose, and none was reserved):

   ```
   EXECUTION_REQUEST
   {"request_id":"<wave>-<issue>-<host>-<n>","execution_host":"rog-nv-linux","kind":"measurement",
    "requested_revision":"<pushed sha>","checkout":"<absolute path on the execution host>",
    "command":"<one bounded runner command>","log":"<intended log path, or ->"}
   END_EXECUTION_REQUEST
   ```

   The task notification that follows is this handoff, not completion. Several blocks are a
   queue: the coordinator assigns them one at a time, in order, each after the previous one's
   result is concluded, so a resumed worker holds one assignment and owes one result line.
3. **Assign.** The coordinator completes the reservation (wave, worker, `transport:
   "subagent"`, agent host, repository, issue, purpose - the request supplies the rest), runs
   `execution run <reserve.json>` - or, for a measurement on a box where workers hold standing
   reservations, `execution window <box> <reserve.json>`, batching the box's pending
   measurements as [executions.md](executions.md#exclusivity-and-the-run-time-slots) says - and
   on exit 0 resumes the worker by its agent ID (the
   runtime's continue-an-agent form: SendMessage to the agent's name or ID, never a fresh
   Agent call) with one line, `EXECUTION_ASSIGNED <request_id>`, followed by the exact
   command, revision, checkout and log to use. On a refusal, hold the worker - idle, it keeps
   its context - or answer `EXECUTION_REFUSED <reason>` so it keeps implementing.
4. **Result.** The resumed worker runs only the assigned command. Correctness uses
   `fleet-worker.sh execution slot -- <command>`, which is what bounds the box's
   concurrent load. An exclusively reserved measurement runs the bounded project runner directly,
   without `execution slot`, as [executions.md](executions.md#reserve-launch-observe-conclude)
   specifies: under `fleet-worker.sh execution hold --request <request_id> -- <command>`, the
   OS-level sleep guard alone, inside which a runner's own `execution slot` runs instead of
   being refused. The hold first waits for any batch still running on the box (`waits for the
   batch in slot <n> to end`) and keeps the box's slots until the command's tree ends. The worker blocks on either kind to completion within the turn ([Blocking on a
   run](#blocking-on-a-run)), and ends that turn with one fixed line,
   so the coordinator concludes without grepping run ids out of prose:

   ```
   EXECUTION_RESULT {"request_id":"<id>","run":"<absolute test-run.sh run directory>","exit":0,"observed_sha":"<sha that ran>"}
   ```

   The coordinator runs `fleet-worker.sh execution conclude --from-run <run> --request <id>
   --sha <observed_sha>`, which reads verdict, log and checkout off the record on the reserved
   box (a record's launch-time `head` must equal the result line's SHA and its `dirty` be empty,
   or the conclusion is refused; a record with neither concludes on the result line's SHA and
   says so; a checkout that has moved on since is noted in the evidence) and refuses an
   unfinished run - or
   `--from-bg-run <run>` when the run is a `bg-run.sh` directory - and then
   resumes the worker with `EXECUTION_CONCLUDED <id> <verdict>` or its next assignment.

The same request and result lines work for a Codex native worker that prefers them; what
differs is only that Codex may keep its turn open and wait.

## What a returned turn means

The rule is SKILL.md's (Supervise: *A returned turn means the turn ended*); on this runtime the
signal is the task notification, and a worker that started `dune` in the background and
yielded produces the same notification as one that finished. Two Claude-specific readings: an
idle worker (turn ended, no background task) disappears from `ListAgents` but keeps its whole
context and resumes by ID with `SendMessage`; a worker still listed as running is mid-turn or
holds a background task and is not stalled, so spawn no finisher on its worktree.

**Stay alive.** The Claude Desktop pause and the coordinator-side heartbeat are SKILL.md's
(Supervise: *Stay alive, but design for dying*). After any interruption reconcile from
`ListAgents`, the board and the PRs rather than from memory; an idle worker is still there to
resume.
