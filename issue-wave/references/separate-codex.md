# App workers: separate Codex conversations (explicit alternative)

Use this path only when the user explicitly chooses app workers - separate Codex app
conversations, each an ordinary user-level task with a dedicated Git worktree and an
independent conversation. A normal Codex wave uses [native workers](native-workers.md); the
request for a supervised wave alone is not a request to create user-visible tasks. Tool names
below refer to the Codex app capabilities (`mcp__codex_app__*` in the current harness);
discover them when deferred and read their current schemas. Do not use `codex exec`, tmux or
`fleet-worker.sh launch --kind codex` for an app worker.

Before any execution leg, follow [execution reservations](executions.md), coordinator
integration included; an agent host does not reserve execution capacity.

## Placement and launch

1. Call `list_projects` and match the repository and the plan's box to a saved project and
   its configured host. Check `isGitRepository`; issue workers need a Git project. ssh reach
   does not make a box an app host (the placement rule of
   [native-workers.md](native-workers.md#placement-and-launch)). If the required project/host
   is unavailable, record that placement gate and defer the issue or obtain a revised
   placement; substituting a local or CLI launch is refused by SKILL.md's *Launch*.
2. Claim the existing fleet coordinator lease. Before each launch run
   `fleet-worker.sh preflight <box> --native-codex`: the deployed checkout, symlink and
   cross-box checks without either CLI's login, a headless probe or tmux. Confirm the project
   setup can supply the task's tools and permissions; a passing filesystem preflight alone does
   not prove the app worker will start.
3. Write the self-contained brief and a pending entry to the board. Recheck rival PRs and
   dependencies, then run `fleet-worker.sh gate --target-repo <owner/repo> [--base-branch
   <branch>] --wait <seconds>` immediately before `create_thread`; SKILL.md's *Base gate* sizes
   `--wait`, says what blocks the call, and gives the `--force --allow-red-base` triage
   exception, which is recorded on the board. `gate` checks
   the anchor lease and halt at that instant; it does not reserve a worker or atomically fence
   the later app call, so an adoption reconciles pending entries before creating anything.
4. Call `create_thread` with `target.type: "project"`, the returned `projectId`, and
   `target.environment: {type: "worktree"}`. Put the complete brief in `prompt` and use a
   recognizable issue title. Omit `model` and `thinking` unless the user requested overrides;
   a tool's current model availability governs any requested setting. Do not create a
   projectless or cloud task for repository work on a named fleet box.
5. Let the app create the worktree. Do not pre-create a second worktree with the shell
   launcher. By default omit `startingState` and use the project's default branch. If the
   user explicitly requested a particular starting ref or the current working tree, use
   the corresponding supported `startingState`. Never invent a branch to fill that field.
   Put required base verification in the brief: before edits, fetch and check the planned
   base, record its SHA, and create a `codex/<topic>` branch if needed. If a nondefault base
   cannot be selected through the permitted tool fields, have the worker set it up in its
   fresh worktree before edits; stop if local changes make that unsafe. Existing-PR adoption
   must preserve the existing branch and first establish that its prior writer has stopped.
6. A ready result supplies `threadId` and `hostId`. Record both. A setup-in-progress result
   may supply only `clientThreadId`: record it as pending, do not pass it to tools requiring
   `threadId`, and do not call `create_thread` again just because setup is slow. A task can
   remain absent from `list_threads` even while it is working, so absence is not a failed
   creation and never justifies a duplicate. Reconcile by project, host and the pending task's
   title/context when possible. More importantly, put the coordinator's actual thread ID in
   the brief and require the worker to send its real thread/host ID, worktree, branch and base
   SHA to the coordinator's recorded thread **and host** at startup. A known real ID can be
   checked directly with `read_thread` even when discovery still omits it. An ambiguous creation
   remains recorded as pending until app or worker evidence establishes its identity.

An example of the creation arguments, after substituting a verified project ID and full brief:

```json
{
  "title": "owner/repo #123: implement the scoped issue",
  "prompt": "<complete worker brief, including base verification and hand-back mode>",
  "target": {
    "type": "project",
    "projectId": "<id from list_projects for the planned box>",
    "environment": {"type": "worktree"}
  }
}
```

The first worker update should identify its real thread and host IDs, worktree path, branch and
base SHA, sent directly to the coordinator thread rather than left only in the worker's own
transcript. Check them against the plan before treating the launch as successful. Require the
same direct message for the final structured hand-back. App-managed worktree paths replace the
CLI launcher's `<checkout>-worktrees/<name>` convention for these workers. The worker owns only
its issue; it must not claim the fleet lease or start another wave.

## Board and recovery

App workers go on the same board as native workers (its location and fields are in
[native-workers.md](native-workers.md#supervision-recovery-and-evidence)), written through the
anchor's filesystem or ssh path, never a coordinator-local copy that another host cannot
recover. For an app worker the board additionally records the project ID, the pending client
ID if any, and the resolved thread ID and host ID. Persist the pending entry before dispatch and
update it after every creation, intervention, merge and hand-back; store the brief durably on
the anchor as well; recheck lease ownership before dispatch, intervention and board updates.
The board is coordinator-maintained, not a script worker record: do not manufacture
tmux/session files to make `ls` include it.

After interruption or lease adoption, read the board and halt state, reconcile app entries with
`list_threads`/`read_thread` and CLI entries with `fleet-worker.sh ls`, then resume supervision
of the same identities. Read archived threads if a recorded task was archived; disappearance
from the recent list is not proof of failure. Do not assume a coordinator interruption stopped
a worker, or that a persistent thread is still running.

Treat discovery and hand-back as administrative evidence gates, distinct from code dependency
gates. A dependent whose prerequisite merge and repository state are independently verified may
start even if the prerequisite task is missing from discovery or its formal hand-back is late;
record the evidence gap and keep pursuing it for close-out. Conversely, missing administrative
evidence is not silently waived: account for every pending identity and hand-back before release.
A user-relayed final hand-back is acceptable when the coordinator independently verifies its PR,
merge, issue and Git/test claims and records that provenance.

## Startup permissions

Have the worker verify one harmless repository read and its first required Git mutation before
substantial work. If the app shows full access but a mutation still opens a Deny/Allow-once gate,
first report the mismatch. Changing the selection or sending guidance into the already-running
turn may not change that turn's effective permissions. A recovery observed in multiple tasks is
for the user to stop that active turn, select the intended access, and send a new `Continue` in
the same task; verify the next mutation before proceeding. Use this only when the mismatch occurs:
it is not a mandatory restart or a guaranteed remedy. Do not have the coordinator execute the
blocked command, weaken configuration, or infer a tool setting that the current schema does not
expose; a transport switch to bypass the gate is refused by SKILL.md's *Launch*.

## Supervision and intervention

Use `wait_threads` to await completion or attention, at most eight thread IDs per call,
with returned cursors to avoid replaying old reports. Use bounded waits and rotate across
batches so one batch does not hide another. `read_thread` supplies progress and recent output;
`list_threads` is discovery and recovery. A completed turn is a returned turn and nothing more
(SKILL.md, Supervise: *A returned turn means the turn ended*): verify PR state, issue state,
commits and tests externally and continue unfinished work in that thread.

Poll according to state, not a fixed forever cadence: short bounded waits for a running turn or
new review, longer backoff for setup/discovery gaps or queued CI, and escalation or a deliberately
slower scheduled recheck after three unchanged observations by default. Persist the last
observation and next check on the board. Keep progressing other authorized, dependency-ready work
while an administrative gate is quiet.

Use `send_message_to_thread` with the recorded thread/host IDs to give corrections, request
progress, continue a finished turn or request the final hand-back. Send a clear human-readable
prompt, preserving model settings unless the user directed a change. Do not use CLI resume,
`codex queue`, tmux kills, or `fleet-worker.sh unstick` on an app thread. Observe the response;
a sent message alone does not prove an active task stopped or obeyed it.

For stalls, compare app status/output over a task-appropriate interval with git, process and
PR evidence. Quiet output during a long test is not a failure. Retry a failed capacity turn in
the same thread with a disk-first note after confirming it ended. Escalation follows SKILL.md's
*Intervene* bullet: after two failed interventions, establish the old worker is stopped and its
child processes cannot write before any takeover, and if the app's controls cannot establish
that, leave the takeover gated and report the blocker. A finisher's brief names the inherited
branch, commits and PR; request the original worker's brainstorm in the original thread when it
remains usable.

Keep long local verification in a bounded harness-tracked foreground session and retrieve its
actual exit verdict. A detached supervisor can disappear across a turn boundary while its child
`dune` keeps running. If tracking is lost, inspect the process and its durable log/session first;
do not start a duplicate build in the same `_build`, and do not claim a root cause the available
evidence does not prove. Recover the existing verdict when possible; otherwise wait for the one
active build to finish before rerunning under tracked supervision.

## CI and review evidence

All gates name a commit. A `pr-review.sh checks --wait` observation snapshots the PR head when it
starts; after a push, identify and retire only this worker's obsolete waiter, then arm a new check
for the new head. Never cancel an unverified process or another worker's watcher, and never count a
green result for an older SHA as current-head evidence.

`gh run view --log-failed` can wait for the entire workflow even when the failed job has already
completed. For early diagnosis, read the completed job's log directly from
`repos/<owner>/<repo>/actions/jobs/<job-id>/logs`, without treating that diagnostic read as the
workflow verdict. Pass `--allow-escape-sequences` to `gh api` when `gh api --help` advertises the
flag; older GitHub CLI releases use the same endpoint without it. The response can contain NUL
bytes and ANSI control sequences: keep the raw log in a file and make a sanitized display copy for
text inspection rather than placing raw output in shell variables or command substitutions.
Continue to gate on the exact-head workflow and required jobs.

Which jobs a project's PR matrix carries, and where evidence it does not carry comes from, is the
project's AGENTS.md's to say (OCANNL: *Windows verification placement*). Ordinary current-head PR
checks remain required. A fleet leg runs as [native Windows verification](executions.md#bounded-native-windows-verification) says.

If sibling fixes become mutually gated on red branches, freeze both writers and confirm their
remote SHAs, unpushed commits, and staged, unstaged and untracked state before changing ownership.
Have the original owner commit useful dirty work, or durably capture its exact diff after proving
the writer stopped. Then designate one owner and one PR, preserve and integrate the useful history,
retire the superseded path only after every commit and saved diff is accounted for, and run review
plus the full exact-head gate on the combined result. Consolidation removes the circular gate; it
does not relax verification or permit two active writers.

For a regression, set the anchor halt and tell app workers through `send_message_to_thread`;
the rest is SKILL.md's *On a regression, stop the world*. Every new app dispatch must pass
`gate` even though the app itself does not know the halt.

For a wave that needs supervision beyond the current turn, use the available app heartbeat or
automation tool when the user's request authorizes ongoing monitoring. Save the board location,
identities and recovery instructions in its prompt. A heartbeat stays silent on unchanged,
non-actionable state and notifies only for a meaningful transition, failure, completion or
required user action; repeated "still missing" or "still pending" notices do not supervise
anything. A waiter or message does not itself schedule a later wakeup. Do not apply Claude
Desktop's `/loop`, `ScheduleWakeup` or pause timing to the Codex app.

## Close-out

Collect the structured hand-back from the worker's direct coordinator message or through
`read_thread` (request it in the same thread if missing), verify merge and issue closure
externally, and consolidate proposals as SKILL.md's *Close out* requires. Confirm no worker or
its child processes can still write, and no outstanding reservation uses the checkout, before
cleanup. Keep the thread and its app-managed worktree through hand-back and any interventions.
Do not apply the CLI worktree-removal recipe to an app-managed worktree; use a documented app
cleanup control when available, otherwise retain it and record that fact. Archiving a thread is
not evidence that its worktree was removed. Release the fleet lease only after every worker on
the board and every CLI record is reconciled and the wave report is durable.

The [official worktree documentation](https://learn.chatgpt.com/docs/environments/git-worktrees)
explains app-managed worktree isolation. The available app tool schemas are the authority for
creation, pending IDs, placement and control; do not infer extra parameters from the CLI.
