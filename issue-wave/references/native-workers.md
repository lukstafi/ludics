# Native workers

The provider-agnostic body of a native wave: a Codex or Claude Code coordinator runs
same-provider native workers (its runtime's subagents), one issue per coordinator-created
external worktree, and everything below holds for either. What differs by coordinator is the
worker channel and the tool names, and those live in the per-coordinator files -
[native-claude.md](native-claude.md) for a Claude Code coordinator, [native-codex.md](native-codex.md)
for a Codex one; read yours alongside this. Vocabulary, the transport choice and the rule that
the user's provider, model and transport choices are preserved are SKILL.md's (*Vocabulary*,
*Launch*); the app-worker alternatives are [separate-codex.md](separate-codex.md) (Codex) and
[app-claude.md](app-claude.md) (Claude).

Tool names and concurrency limits come from the runtime in front of you, not from a remembered
wave: they change between builds (Claude Code's `SendMessage` was not loadable on 2026-09-10
and was the whole worker channel on 2026-09-15). Read the current schemas, and never put one
provider's tool names into a brief for the other's worker.

## Placement and launch

Record **agent host** and **execution host** as separate facts on the board and in each
reservation: the plan places execution only (a home box and legs), and the agent host follows
from the transport chosen at launch. A local native worker can drive a reserved CUDA leg on
ROG or HIP leg on Minix over ssh; required hardware constrains execution, not necessarily where
the agent runs. **ssh reach, or the app's Control-other-devices connectivity, does not
establish remote native-worker support**: a native worker runs where the coordinator's runtime
runs its subagents. This is the one statement of that rule. When repeated hardware iteration
argues for an agent resident on the box, the options are a CLI worker there
([cli-claude.md](cli-claude.md)) or an explicitly selected app worker, subject to the app's
actual host-aware tools ([separate-codex.md](separate-codex.md), [app-claude.md](app-claude.md)).
Residence does not preclude checks on other boxes; each execution is reserved separately, runs local to the agent included.

1. Claim the fleet lease and read the plan, the board, the halt, the PRs and the execution
   registry. Resolve the project's development remote (including staging versus upstream),
   fetch it, and verify the intended base ref and exact SHA. Never infer it from a stale local
   default branch.
2. Discover effective agent capacity from the runtime's stated limit and the agents already
   active, the coordinator and other children included. A sprint fills it; a regular wave launches
   only as many as SKILL.md's *Wave mode* lets its coordinator answer promptly. Queue dependency-ready issues when
   slots are occupied and launch as capacity frees. If capacity is unknown, establish it from
   tool evidence; do not invent a fixed limit. Dependency readiness, agent capacity and
   execution capacity on each box are three separate gates.
3. Run `fleet-worker.sh preflight <agent-box> --native-codex` for Codex or `--native-claude`
   for Claude (SKILL.md: *Skill-freshness preflight*), then confirm the runtime's actual tools
   and mutation permissions.
4. Create one external worktree and branch per issue before spawning. For example, with
   resolved absolute paths and a verified base: `git -C <repo> worktree add -b codex/<issue>
   <external-path> <verified-base-sha>`. Record ownership first; do not reuse a checkout with
   an unresolved writer.
5. Persist the complete brief and a pending entry on the board. Run `fleet-worker.sh gate
   --target-repo <owner/repo> [--base-branch <branch>]` immediately before spawning; nonzero
   blocks dispatch, and the `--force --allow-red-base` exception, the point-in-time caveat and
   the base-SHA rules are SKILL.md's *Base gate*.
6. Spawn with that brief, recording the returned agent identity or canonical task name. Do
   not infer a runtime ID from an app thread ID. Validate the worker's startup report before
   calling the launch successful: actual absolute worktree, branch, base SHA, agent identity,
   and a harmless successful Git mutation such as `git update-index --refresh` with exit
   status.

The default self-contained brief (SKILL.md: *The brief*) includes issue repository/number and
comments to read, scope, absolute assigned worktree and branch, verified base SHA, agent and
execution hosts, coordinator runtime identity, applicable project guidance, test bounds,
ship-pr and issue-close responsibilities, and after-merge hand-back mode. Native workers add
two constraints of their own:

- **An explicit command working directory for every shell call, and absolute assigned paths
  for edits.** Native workers share the coordinator's environment: cooperative cross-path reads
  are allowed, but each checkout has one writer, and inherited cwd is never isolation.
- **Scratch files never in the worktree, and prefixed by issue number.** Every native worker
  of a wave shares the COORDINATOR's scratchpad directory (it is keyed on the coordinator's
  session, not the worker's), so the brief requires every scratch file there to carry the
  issue number as a prefix (`<N>-pr-body.md`, or a per-issue subdirectory), never inside the
  worktree - which must be clean of local and ignored data at close-out - and a body file
  re-read immediately before the `gh` command that consumes it (2026-09-16: two workers
  overwrote each other's `pr-body.md` minutes apart, and only timing kept the wrong body off
  a PR).

Workers ask the coordinator for a reservation before any fleet test or experiment beyond their
[standing reservation](executions.md#standing-iteration-reservation), return the actual runner
handle, log and verdict, and leave worktree cleanup to the coordinator.

## Supervision, recovery and evidence

Maintain the board on the anchor with `fleet-worker.sh board`: `board set [--create] <wave>
<task> key=value ...` for a worker's row, `board note <wave> key=value ...` for wave-level facts,
`board log <wave> <text>` for the append-only log, and `board show <wave> [--json]` to read it
(the store and its grammar: `lib/ludics/fleetworker/boardstore.py`). A wave whose board predates
the verb (a markdown file under `FLEET_ANCHOR_STATE`, such as `<wave>-board.md`) keeps that file
to its close-out, and recovery reads it there: `board show` reads only the structured boards and
refuses a wave it has none for. Store wave and coordinator identity as notes, and per worker
the dispatch status, last observation, remaining gates and hand-back beside the **takeover keys**,
written at launch (before the spawn, then `agent` after it) and again whenever one changes:
`worktree`, `branch`, `base`, `agent`, `transport`, `agent_host`, `exec_hosts`, `brief` and
`brief_host` (the durable brief's absolute path and box), `repository` (`owner/name`), `issue`
(`owner/name#N`), `worker` (the registry's `request.worker`), `pr` (the number, once opened),
`runs` (the worker's bg-run parent), `standing` and `requests` (request ids, space-separated, or
`none`), `farside` (`<box>:<path>` far-side worktrees) and `plan_dir`. Their grammars are
`lib/ludics/fleetworker/takeover.py`'s. The writers check the lease themselves; check it before
interventions. A board write that fails may or may not have landed: re-read with `board show`
before retrying it.

When a worker died with its process (a coordinator restart kills every in-process worker), its
replacement's brief is `fleet-worker.sh board takeover <wave> <task>`: the stored brief, then a
generated *State at takeover* from those keys and the live sources (worktree HEAD, the PR, the
registry's outstanding requests for the worker, its bg-run verdicts), each missing key printed as
missing. Exit 3 means the brief itself could not be read, so the output is no brief. It reads and
writes nothing else: establishing that the old writer is gone stays the step below.

Use the runtime's messages and bounded waits, retaining real identities. Follow up in the same
agent when work is unfinished and observe the response. A returned turn is read by its final
message and is never a verdict on a run or a merge (SKILL.md, Supervise: *A returned turn
means the turn ended*; your coordinator file says what the signal is). Verify PR, issue, Git
and test evidence externally (Supervise: *Verify externally*). Keep long tests in bounded
tracked sessions and recover their actual exit code rather than starting a duplicate when
output goes quiet. Re-arm review and check waiters for the current commit after a push. The
exact-head CI and Windows evidence rules of
[separate-codex.md](separate-codex.md#ci-and-review-evidence) apply to native workers too.

After an interruption or an adoption, reconcile what the runtime actually exposes with the
board, the Git/PR evidence and the project runner's records. Restart survival was not
established by the original smoke, so promise no durability and assume neither that agents
and child processes stopped nor that they survived: resolve each pending identity and each
checkout's writer before resuming or replacing it. A missing agent listing is not proof that
its processes cannot write. Use the runtime's controls and process evidence, and leave a
takeover gated when ownership cannot be established. Reconcile outstanding
[reservations](executions.md#adoption-and-halt) separately before reusing boxes. An authorized
heartbeat may resume reconciliation later; it stays quiet on unchanged, non-actionable state
and does not assume native workers survive the gap.

For a regression, follow SKILL.md's *On a regression, stop the world*: halt fleet dispatch,
message each native worker, and keep the named triage exception visible on the board. Keep
administrative identity gaps distinct from dependencies: an independently verified prerequisite
merge can unblock a dependent issue while the coordinator still pursues the missing hand-back.
Do not release the wave with unaccounted identities or reservations.

## Close-out and bounded smoke

Verify each completed hand-back, the landed changes and a clean checkout (local and ignored
data included), then confirm no agent, child process or outstanding reservation still uses that
checkout. Only the coordinator removes its externally created worker worktree, with the
project's cleanup procedure; retain any checkout whose ownership or execution is uncertain.
For Git cleanup use the existing [ship-pr helper](../../ship-pr/SKILL.md#after-it-lands) where
applicable, with the repository's base and explicitly regenerable directories (for example
`--regenerable _build`). Archive unique experiment inputs and instrumentation first. Avoid
rebuilding its ref/ancestry checks in an ad-hoc cleanup script; Dune can copy a worktree's `.git`
file into `_build/default`, which a plain `git clean -fdX` will preserve as a nested repository.
App-managed worktrees follow [separate-codex.md](separate-codex.md#close-out) or
[app-claude.md](app-claude.md#intervention-and-close-out) instead.
Consolidate workers' after-merge proposals and persist the completed wave's board. Route chips
through SKILL.md's selected mode; retain the lease across the default post-wave coordination
loop and release it only at final close-out.

For a bounded transport smoke, create two disposable external worktrees with distinct branches
at one verified base. Spawn two workers with explicit-cwd, absolute-path briefs. Each reports
`pwd`, branch and base, successfully refreshes its index, and reads one tracked file from the
sibling checkout without editing it. Collect both real agent IDs and exit results, check clean
state and reservations, then remove the two checkouts only after both hand-backs. No feature PR
or full issue wave is needed; record observations rather than encoding prose sentences as
tests.
