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
  # foreground, with Bash timeout: 600000, re-issued until it prints rc=
  ~/.claude/skills/issue-wave/scripts/bg-run.sh wait <dir>
  # foreground; ends the run's whole tree
  ~/.claude/skills/issue-wave/scripts/bg-run.sh stop <dir>
  ```

  `wait` blocks for its whole bound, `--within`, default 540 s so it ends under the 600 s cap,
  unless the run settles first, and prints one line led by its verdict; its exit code says the
  same. Give the Bash call `timeout: 600000`: the tool's default of 120 s cuts the wait short.
  While it blocks it writes a `bg-run: still waiting after <e> s ...` line to stderr every 120 s.
  `rc=<n>` (exit 0): the command finished with status `<n>`, and its output is `<dir>/log`. The status is a file of its own, so a review body quoting `rc=` cannot
  end the wait. `RUNNING after <e> s of --within <w>` (3): the bound was spent with the run still
  live, the designed return: re-issue it (an `<e>` under `<w>` is a bug worth reporting). A
  slow CI takes several of these. `STARTING` (4): no pid within a minute of the wait:
  re-issue it once, and a second one means the launch itself failed, so spawn again. `DIED` (5):
  the run was killed before the command returned, which says nothing about what the command was
  reading: re-arm it, and for `merge --wait` first re-read the merge state as ship-pr's *The
  approval is one gate* says. Every re-arm takes a new `spawn`. `STOPPED` (7): `bg-run.sh stop`
  ended the run on purpose and no process of it is left. It is NOT re-armed: a re-arm would
  relaunch what was stopped (a merge wait stopped for a pause merges with nobody there).
  Re-arm only on a decision to resume, as for a fresh run. The command starts with SIGINT,
  SIGQUIT, SIGHUP and SIGTERM at their default dispositions, so a suite that signals its own
  children runs under `spawn` and `execution slot --bg` as it does in the foreground
  (ludics-lite#524).

  A spawned run is no background task of the harness's, so a task-stop does not reach it;
  `bg-run.sh stop <dir>` does (ludics-lite#510). `spawn` gives the run a session of its own, and
  `stop` ends that session's process group - the command, its `gh` calls and `sleep`s, and a
  grandchild whose parent has already exited - with SIGTERM, then SIGKILL after 10 s
  (`BG_RUN_STOP_GRACE`). It prints `STOPPED <dir>: ...` (exit 0), and a `wait` there then reads
  `STOPPED` (ludics-lite#638), not `DIED`. A run that has already ended, or whose pid the system has since reused for another
  process (the start-time check `wait` makes), is left alone: `NOT RUNNING: <verdict>`, exit 1.
  The caller is never in the run's group, so the stop cannot take the caller down. A `merge`
  already inside its merge call when the stop lands may still have reached GitHub, so re-read the
  PR's state before acting on it. The older form, `new` and then `start` as a Bash
  `run_in_background: true` task, still works (`start` runs only in a directory `new` allocated);
  the harness killed such a task at ~40 min into a `merge --wait`, which is `DIED`. Its task-stop
  ends it, and `stop` refuses it, because such a run shares its caller's process group. The
  script's header is the full contract, the run directory's layout included, and `test-bg-run.sh`
  beside it pins the races each verdict closes (ludics-lite#357, #388).

**The wait keeps the cache only under a 1-hour subagent TTL.** A subagent's prompt cache lives 5
minutes from its last request (a main session's an hour) unless the coordinator's host sets
`"subagentPromptCacheTtl": "1h"` in `~/.claude/settings.json` (or exports
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`; Claude Code 2.1.242 and later). Without it every wait
that returns past ~300 s makes the worker's next turn rewrite its whole context: over
2026-10-09..17, 1147 worker turns wrote 299M tokens that way, 95% of them after a `bg-run.sh
wait`, none after a gap under 300 s. With it that turn re-reads the cache at a tenth of the input
price, and the price is a cache write at twice the input price instead of 1.25 times, which those
misses dwarf. [`scripts/cache-misses.py`](../scripts/cache-misses.py) counts such turns (SKILL.md,
*Close out*).

## Worker channel

A Claude Code native worker cannot wait mid-turn: nothing lets it block on a coordinator
message, and ending its turn is its only way to yield. So the "message the coordinator and
wait for dispatch" shape of [native-codex.md](native-codex.md#worker-channel) is Codex's; the
Claude shape is turn-shaped, and SKILL.md's brief template names it. It carried four issues
and a release through five PRs on 2026-09-15 with no stranded worker.

1. **Standing reservation, at launch.** The coordinator takes one `kind: correctness`,
   `"standing": true` reservation per worker on its agent host with `fleet-worker.sh execution
   run` (request id `<wave>-<issue>-<host>-iterate`, its payload's `checkout` the worker's
   worktree; see [executions.md](executions.md#standing-iteration-reservation)) and
   names it in the brief, and by default one more on the task's GPU home box
   ([executions.md](executions.md#the-gpu-home-box) says when, and the batch's `execution leg` form). It
   pre-authorizes the worker's own targeted test batches there -
   each through the project runner (`tools/test-run.sh run ...`), blocked to completion inside
   the turn, reported by run directory in the worker's messages - with no per-batch request. Each
   is concluded at hand-back from its own box's last batch, in the [standing
   form](executions.md#standing-iteration-reservation). Being standing, it consumes no
   correctness slot, so a box holds as many as it has workers and a worker never waits on a
   sibling's brief-reading to start. The brief tells the worker to wrap each batch in the
   run-time lock instead - `fleet-worker.sh execution slot -- <batch>`, which takes one of the
   box's slots for exactly as long as the batch runs (six on mac-studio, four on rog-nv-linux
   with two GPU tokens that a batch declared `--cpu` does not take, four on minix-amd-linux,
   three on tuf-amd-linux, one on a box the spec does not name) and
   refuses while a measurement is outstanding there; a measurement still needs the box to itself through the registry.
   The brief's wrapper adds `--wait-window`, which waits out a coordinator's *measurement
   window* on the box instead of refusing (SKILL.md, *The brief*, execution handoff).
2. **Request, for everything else.** A measurement, a one-off cross-box leg, a full suite: the worker
   ends its turn with its final message carrying the block, one per request and each naming one
   execution host, back to back with nothing after the last (ahrefs/ocannl#1168 wrote its four
   requests as prose, and none was reserved):

   ```
   EXECUTION_REQUEST
   {"request_id":"<wave>-<issue>-<host>-<n>","execution_host":"rog-nv-linux","kind":"measurement",
    "requested_revision":"<full 40-hex pushed SHA (git rev-parse), or a ref>",
    "checkout":"<absolute path on the execution host>",
    "command":"<one bounded runner command>","log":"<intended log path, or ->"}
   END_EXECUTION_REQUEST
   ```

   `requested_revision` may be `"head-of:<branch>"` instead of a SHA: the coordinator resolves
   it when it assigns the request (`run`/`dispatch` read the branch's head on GitHub and record it
   as `resolved_revision`), so a request that waits behind a halt or a busy box never goes stale
   and is not re-pinned after a push. A cross-box leg's `command` is usually `fleet-worker.sh
   execution leg --request <id> --rev <sha|branch> --checkout <dir> --worktree <dir> -- <runner
   args>` ([executions.md](executions.md#a-leg-on-another-box)), run from the worker's own box.

   The task notification that follows is this handoff, not completion. Several blocks are a
   queue: the coordinator assigns them one at a time, in order, each after the previous one's
   result is concluded, so a resumed worker holds one assignment and owes one result line.
3. **Assign.** The coordinator completes the reservation (wave, worker, `transport:
   "subagent"`, agent host, repository, issue, purpose - the request supplies the rest, its
   `checkout` kept beside the request as the record's), runs
   `execution run <reserve.json>` - or, for a measurement on a box where workers hold standing
   reservations, `execution window <box> <reserve.json>`, batching the box's pending
   measurements as [executions.md](executions.md#exclusivity-and-the-run-time-slots) says - and
   on exit 0 resumes the worker by its agent ID (the
   runtime's continue-an-agent form: SendMessage to the agent's name or ID, never a fresh
   Agent call) with one line, `EXECUTION_ASSIGNED <request_id>`, followed by the exact
   command, revision, checkout and log to use. For a `head-of:` request the revision is the
   record's `resolved_revision` (the `EXECUTION RESOLVED` line), never the branch. On a refusal, hold the worker - idle, it keeps
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
   EXECUTION_RESULT {"request_id":"<id>","run":"<absolute test-run.sh run directory>","exit":0,"observed_sha":"<full 40-hex SHA that ran (git rev-parse HEAD)>"}
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

## Auto-fix events on worker PRs

In the Claude desktop app, a PR's "Auto-fix CI & address comments" monitor wakes the session the
PR is bound to with a `<ci-monitor-event>` on a CI failure, a merge conflict or a review comment,
each asking that session to push a fix. It is a wake source only: it reads no review state,
counts no rounds, gates no merge, and exists only in desktop sessions, so ship-pr stays on
`pr-review.sh`. Under a desktop coordinator a worker's PR lands in the coordinator's session: a
native worker's `gh pr create` bound it there with Auto-fix already on (2026-10-16,
ludics-lite#653: `mcp__ccd_pr__get_status` from the worker read `bound: true`, `auto_fix: true`).
One writer per branch (SKILL.md, *Supervise*) rules out acting on its events:

- **Log-only on a worker-owned PR.** An event gets one board line, never a push and never a turn
  spent on the PR. A finding the coordinator judges silent (must-fix, SKILL.md *Converge long
  reviews*) and that the worker may have missed is forwarded to the worker with `SendMessage`,
  naming the PR, the round and the thread.
- **The monitor goes off only on the operator's word, which can be standing.** `set_monitor`'s
  own contract reads: "The user is asked to approve each call (in auto mode the app may approve
  without asking, and in bypass permissions mode it does not ask), so only call it when the user
  asked for that switch." Bypass mode removes the prompt, not the contract (wave-20261016: three
  of four agents declined the call on that sentence). The word is the operator's own, never this
  skill's: a standing one is `FLEET_AUTOFIX_OFF=standing` in the site file the operator keeps
  (SKILL.md, *Site configuration*), which the coordinator reads before the Decision gate with
  `( . ~/.config/fleet/env.sh 2>/dev/null; printf '%s\n' "${FLEET_AUTOFIX_OFF:-}" )`. When it is
  unset, the wave asks in the Decision gate's batch, and that answer covers that wave only; the
  board records which word it acts on. Without either, the first bullet is the whole rule and
  nobody touches the switch. With one, the brief cites it, and: a session holds one bound PR,
  and the app binds one whenever the session runs `gh pr create` or pushes a branch that has a
  PR (`get_status`'s own unbound reply says so), so a sibling's next PR or push can take the
  binding. The moment a PR is known to be bound is just after the worker's own `gh pr create`.
  The brief of a worker in bypass permissions mode has it call `mcp__ccd_pr__get_status`
  (session `"self"`, the default) then, and when it shows the worker's own PR,
  `mcp__ccd_pr__set_monitor` with `auto_fix: false` and that PR's url as `get_status` reports it
  (`address_comments` is the same switch). Any other PR there means the binding has already
  moved, and the worker leaves it alone. Outside bypass mode the call can prompt, and an unseen
  prompt stalls a worker, so that brief leaves the step out. The coordinator makes the same call
  whenever `get_status` shows it a wave PR still on, its own takeover or finisher PRs included.
  The worker's backgrounded `pr-review.sh watch` is that PR's wake source either way.

Why it matters: in wave-20261015 about 40 such events each cost a coordinator turn, and since
they covered only the ludics-lite PRs they also gave a false picture of review progress
(ludics-lite#650: lukstafi/ocannl-staging#1170 reached 12 rounds unseen).
