# Auto-refresh the project base branch at orchestration start + end

## Goal

Orchestration worktrees can be cut from, and merged into, a **stale** local
base branch. When the local `main`/`master` lags `origin`, the gap silently
propagates into every new orchestration worktree, and the eventual merge lands
on an out-of-date target.

Today this drift is only *detected and warned* (`warnStaleBase`), never acted
on. We want the local base branch automatically brought current with `origin`
(fetch + fast-forward) at two lifecycle points so worktrees fork from — and
merges target — fresh upstream state.

Motivating incident on record (issue
[lukstafi/ludics#600](https://github.com/lukstafi/ludics/issues/600)):
ocannl-staging PR #69 (task-bfc7c7b5) was dependency-gated on PR #68
(task-6abfb6a9) and even opened "after PR #68 landed…", yet hit a rebase
conflict. Its worktree was cut from a local `master` **20 commits behind**
`origin/master` — PR #68's already-merged pool-allocator fix was invisible to
the coder, who re-derived a divergent version of the same `cuda_backend.ml`
change. Refreshing the local base from `origin` *before the worktree is cut*
would have pulled #68 into the branch, so the fix would already be present and
never re-implemented.

This is the **load-bearing fix**: keep the local base fresh via an automatic
`git pull` (fast-forward). It deliberately does **not** rebase or force-push
the task/PR branch — pushed-history rewrite is explicitly out of scope (see
the issue's resolved Q2).

## Acceptance Criteria

(a) **Start-hook freshness.** Before a new orchestration worktree is cut for a
task, the project's local base branch (`main`/`master`, as resolved by
`defaultMainBranch`) is fast-forwarded to `origin/<base>`.
*Verification:* with the local base set behind `origin/<base>` and the
working tree clean, after `createWorktrees` runs the local `<base>` ref equals
`origin/<base>` (`git rev-parse <base>` == `git rev-parse origin/<base>`); the
freshly-created worktree's `merge-base HEAD origin/<base>` equals
`origin/<base>` (i.e. the worktree forks from the refreshed tip, 0 commits
behind). A regression test exercising the refresh-then-fork sequence asserts
this equality; mutation-test by stashing the refresh call and confirming the
worktree forks from the stale tip (non-zero commits behind).

(b) **End-hook freshness.** On entry to the `merge-execute` phase, and before
the merge is dispatched, the project's local base branch is fast-forwarded to
`origin/<base>` again, so the merge target is current.
*Verification:* a test (or instrumented enterPhase trace) shows
`refreshMainBranchFromRemote(projectDir, <base>)` is invoked on the
`→ merge-execute` entry path before any merge dispatch; with the local base
behind `origin/<base>` at that point, the local `<base>` ref equals
`origin/<base>` afterward. Mutation-test: removing the end-hook call leaves the
local base stale on entry to `merge-execute`.

(c) **Advisory warning retained.** The existing `warnStaleBase` advisory
drift warning (fired on phase entry, gh-ludics-409 dedup) is **not** removed;
it continues to surface drift that accumulates *after* the start refresh.
*Verification:* `warnStaleBase` and its `enterPhase` callsite still exist and
still emit `orchestration_warning`; its existing tests still pass.

(d) **Base-integration conflicts route to the coder only.** When integrating
the task branch against an advanced base produces a conflict, the conflict
handoff dispatches the **coder** only (never both agents simultaneously),
reusing the existing `redispatchForConflict` machinery.
*Verification:* a test where a conflict is signalled shows exactly one
redispatch, targeting the coder role; the reviewer is not redispatched in the
same conflict event. (A rebase-flavoured resolution template is used when the
resolution is a rebase rather than a PR merge — see Approach.)

(e) **No force-push / no PR-branch history rewrite.** The change introduces no
`git push --force`, no `git push --force-with-lease`, and no rewrite of pushed
task/PR-branch history.
*Verification:* `grep -rn -- '--force' src/orchestration/ skills/orchestration/`
shows no new force-push introduced by this change (any pre-existing
`--force-with-lease` in the unrelated `pr-conflict-resolve.md` PR-rebase path
is untouched and not newly added by this work).

**Safety properties (cross-cutting, apply to (a) and (b)):**

- The fetch runs with `GIT_TERMINAL_PROMPT=0` and a bounded timeout so a
  credential-prompt or network hang cannot wedge slot startup or merge entry.
  *Verification:* the refresh code path sets `GIT_TERMINAL_PROMPT=0` and a
  bounded timeout on its `git fetch`.
- The fast-forward is `--ff-only`; on any non-fast-forward condition (local
  base diverged from origin) or a dirty/wrong-branch working tree, the refresh
  **aborts and skips** (best-effort, warn-and-continue) rather than forcing or
  wedging the slot. *Verification:* with the local base diverged from
  `origin/<base>` (a local-only commit on base), the refresh leaves the local
  base unchanged and emits a skip/warning; orchestration proceeds.

## Context

### Start hook already exists — verify and frame, don't rebuild

The start-hook behaviour is **already implemented**. `createWorktrees`
(`src/orchestration/worktrees.ts`) calls `refreshMainBranchFromRemote(projectDir,
resolvedMainBranch)` *after* the project-checkout existence guard and *before*
`addWorktree` cuts the worktree. `refreshMainBranchFromRemote` already encodes
the exact policy this proposal calls for:

- resolves the base via `defaultMainBranch(projectDir)` (handles
  `main`/`master`/`trunk`; `projectDir` holds the shared remote refs);
- skips cleanly with a typed reason on `no-origin`, `wrong-branch` (working
  tree not on base), or `dirty` (uncommitted changes — we don't perturb
  in-flight work);
- `git fetch origin <base>`, then `git merge --ff-only origin/<base>`;
- warns and skips on fetch failure or `diverged` (ff-only refused) —
  **never forces**.

So criterion (a) is largely **satisfied today**; this work's job for (a) is to
add explicit regression coverage for the refresh-then-fork equality and confirm
the policy, not to write new fork-time refresh logic.

### End hook is the genuinely-new piece

There is **no** refresh before `merge-execute` today. The merge-loop
transitions (`merge-vote`/`merge-debate` → `merge-execute`) are handled in
`applyPhaseSideEffects` / `maybeOverrideTransition` in
`src/orchestration/runner.ts`; the per-phase dispatch happens in `enterPhase`.
The end hook belongs on entry to the `merge-execute` phase (phase enum in
`src/orchestration/phases.ts`), before the merge skill (`skills/orchestration/
merge-execute.md`) is dispatched.

### Advisory warning (retain)

`warnStaleBase` (`src/orchestration/runner.ts`) does the detection half:
fetches `origin/<base>` with `GIT_TERMINAL_PROMPT=0` + bounded timeout
(`LUDICS_WARN_FETCH_TIMEOUT_MS`, default 10s), computes `merge-base` and the
behind-count, emits an advisory `orchestration_warning` with per-category
dedup (gh-ludics-409), and is invoked once per phase entry from `enterPhase`
(gated on `staleBaseCategoryOf`). It is a *mid-round drift signal* — drift that
accrues after the start refresh — and is retained unchanged.

### Conflict handoff precedent (mirror for coder-only)

`redispatchForConflict(state, transport, conflictAgents)`
(`src/orchestration/runner.ts`) re-dispatches the named agents against
`skills/orchestration/pr-conflict-resolve.md` and emits `pr_conflict_detected`.
The existing PR-conflict template already does `git fetch` + `git rebase
origin/<base>` + resolve. The Q3-resolved requirement is that base-integration
conflicts route to the **coder only** — pass a single-element `conflictAgents`
(the coder) to this existing machinery, never both agents in one event.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The design is settled (issue #600 Q1–Q3 resolved with the user). The shape:

1. **Start hook (verify + cover).** Keep the existing
   `refreshMainBranchFromRemote` call inside `createWorktrees`. Add a
   regression test asserting (a): set the local base behind `origin/<base>`,
   run `createWorktrees`, assert the local base ff'd to `origin/<base>` and the
   new worktree forks from that tip (0 behind). Mutation-test by stashing the
   refresh call. (No production change needed here unless the test surfaces a
   gap.)

2. **End hook (new).** In `enterPhase` (`runner.ts`), on entry to
   `phase === "merge-execute"`, before merge dispatch, call
   `refreshMainBranchFromRemote(state.projectDir, defaultMainBranch(state.projectDir))`.
   This reuses the identical helper — same ff-only / `GIT_TERMINAL_PROMPT=0` /
   timeout / skip-on-dirty-or-diverged policy as the start hook. It runs in
   `projectDir` (shared remote refs), not in a worktree. Idempotent: a no-op
   when already current. Add a test asserting (b).

3. **Retain advisory warning.** No change to `warnStaleBase` or its callsite;
   its existing tests continue to pass (criterion c).

4. **Coder-only conflict handoff (d).** Genuine task-branch-vs-advanced-base
   divergence is handled by the *existing* merge + conflict path, restricted to
   the coder. Where a base-integration conflict is detected, redispatch via
   `redispatchForConflict` with a single coder agent. If the resolution is a
   rebase (rather than a PR merge), supply a rebase-flavoured variant — either a
   new `skills/orchestration/rebase-conflict-resolve.md` template or a
   `redispatchForConflict(…, template, eventType)` parameter — so the agent
   drives `git rebase --continue` / knows when to `--abort`. The existing
   `pr-conflict-resolve.md` PR-merge path (with its pre-existing
   `--force-with-lease` on the *PR* branch) is unchanged; this work adds no new
   force-push (criterion e).

### Reuse note

The base-freshness fetch policy already lives in two places
(`warnStaleBase` and `refreshMainBranchFromRemote`). Extracting a single shared
base-freshness helper is welcome if it reduces duplication, but is not required
— both already encode the same `GIT_TERMINAL_PROMPT=0` + bounded-timeout policy.

## Scope

**In scope:**
- End-hook `refreshMainBranchFromRemote` call on entry to `merge-execute`.
- Regression coverage for start-hook (a) and end-hook (b) freshness.
- Coder-only conflict handoff for base-integration conflicts, with a
  rebase-flavoured resolution template/variant.

**Out of scope (explicitly, per resolved Q2):**
- Rebasing **and force-pushing** the task/PR branch.
- `git push --force` / `--force-with-lease` on the PR branch (the existing
  PR-merge-conflict path's `--force-with-lease` is untouched, not extended).
- Any rewrite of pushed history.
- Replacing or weakening the `warnStaleBase` advisory warning.

**Worktree-topology note:** pair/solo/pilot share one root worktree; duo has
per-agent worktrees. The base-branch refresh operates on the shared
`projectDir`, not per-worktree, so it is one fetch+ff regardless of mode. The
conflict handoff targets the coder agent specifically.

**Dependencies:** none blocking. Relates to gh-ludics-409 (stale-base warning
dedup) and the worker-stale-ref trap documented in harness memory (the
minipc-wsl local `master` staleness that compounded the #68/#69 incident).
