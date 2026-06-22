# Guarantee the proposal artifact is reachable from the fork ref before worktrees fork

## Goal

When an orchestration slot forks per-agent worktrees, the task's proposal
artifact must already be a committed, reachable git object on the branch the
worktrees fork from — **and** on `origin/<main>` so a remote worker can fetch
it. Today nothing enforces this at the fork site: every gate checks only the
`proposal:` *frontmatter field*, never git object reachability. The result has
been two distinct production failures this session where coder/reviewer launched
against a tree that lacked the proposal.

Make slot-start the enforcement backstop: when a slot has a `proposal:` set,
slot-start verifies the artifact is reachable from both refs; if it is only on
disk (uncommitted), slot-start **self-heals** by committing+pushing just that
one file; if it cannot self-heal, slot-start **hard-fails setup** rather than
forking a proposal-less tree. Additionally, surface a warning event when
`refreshMainBranchFromRemote` silently skips its sync while a proposal commit is
pending, so the mode-(a) race stops being invisible.

## Motivation

The draft-proposal worker is already the canonical proposal committer (per
`docs/proposals/proposal-commit-on-main-and-worktree-resume.md`, task
`task-a1e55a19`): its step 8 switches to the default branch, fast-forwards,
commits, and pushes. But that commit is **advisory and best-effort** — the
skill's own Error Handling line (`skills/ludics-draft-proposal-worker.md:259`,
"Git push fails: log a warning and carry on — the proposal is still on disk")
means a commit/push that does not land still returns `status: "completed"` with
the artifact only on disk. Two recurrences slipped through this session:

- **Mode (a) — gh-ludics-578.** The proposal was committed to `main` *after* the
  slot had already forked its worktrees. The fork-time sync
  `refreshMainBranchFromRemote` (`src/orchestration/worktrees.ts:467`) is
  best-effort and **silently skips** (never throws) when the controller's shared
  checkout is on a different branch, dirty, or diverged — exactly the window in
  which the proposal had not yet reached the local fork ref. The reviewer's
  parallel plan had no proposal at all; the coder worked around it with a manual
  `git merge --ff-only origin/main`.

- **Mode (b) — gh-ludics-579.** The proposal was **never committed**: the worker
  wrote `docs/proposals/gh-ludics-579-*.md` and set the `proposal:` frontmatter,
  but never `git add`/committed it, so it was absent from every git ref. The
  coder anchored to the task's embedded resolved design + the GitHub-issue ACs
  and shipped anyway (PR #583), flagging in every plan/merge/AC-check that the
  authoritative AC source was missing. Mag committed the artifact manually
  post-merge.

The structural gap common to both: **there is no hard gate that the proposal is
actually reachable from the ref the worktrees fork from, at the moment they
fork.** The precedent for the check already exists —
`proposalFreshnessWarning` (`src/orchestration/skills.ts:59`) git-introspects the
proposal — but it returns benign (`""`) when the proposal was never committed
(`if (!hash) return ""`), which is precisely the blind spot. The reachability
test is `git cat-file -e <ref>:<proposal-path>`.

## Acceptance Criteria

The criteria below implement the user's resolved design (task `task-a8789cf1`
Questions Q1–Q5). Each is verifiable.

### AC1 — Reachability check requires BOTH refs (Q3)

- A new helper (e.g. `proposalReachableFromRef(projectDir, ref, proposalPath)`)
  reports whether `git cat-file -e <ref>:<proposalPath>` succeeds, using
  `safeSyncOutput` so it never throws. `<proposalPath>` is the repo-relative
  `proposal:` frontmatter value, validated by `assertRepoRelativeProposalPath`
  (already exported from `src/adapters/task-launch.ts`).
- The slot-start guard considers the proposal "reachable" only when it is
  reachable from **both** the local fork ref (`resolvedMainBranch`, the ref the
  fork actually uses — `worktrees.ts:556`) **and** `origin/<main>`. Both arms
  must pass. The `origin/<main>` arm is load-bearing for **remote workers**: a
  worker's fork can only see a commit that has reached origin to be fetched
  (gh-ludics-579 cross-machine family).
- A proposal reachable from only one of the two refs is treated as **not
  reachable** (triggers self-heal or block).

### AC2 — Self-heal an orphaned-on-disk proposal (Q1, Q4)

- When the guard finds a `proposal:` set, the artifact present on disk in the
  project checkout, but **not reachable** per AC1, slot-start **self-heals**: it
  commits *only that one proposal file* on `resolvedMainBranch` and pushes it to
  `origin/<resolvedMainBranch>`.
- The self-heal commit is **narrow and safe**:
  - It stages and commits **only the proposal path** (`git add <proposal>` then
    `git commit -- <proposal>`), never a blanket commit of a dirty tree.
  - It commits on `resolvedMainBranch` (the fork ref). If the checkout is not on
    `resolvedMainBranch`, or has *other* uncommitted changes that would be swept
    in, or the commit/push cannot proceed cleanly, self-heal **does not force** —
    it falls through to the AC3 block path. (It must never commit on a wrong/dirty
    branch — the very corruption the worker's fail-loud was added to avoid.)
  - After a successful commit+push, the guard **re-runs the AC1 check**; it
    proceeds with the fork only if the proposal is now reachable from both refs.
- This is the Q4 "commit the existing on-disk artifact" remediation — it does
  **not** re-queue `draft-proposal` (no re-explore / overwrite of the artifact).
- A self-heal emits an informational event (e.g.
  `event_type: "proposal_self_healed"`) recording task, slot, and proposal path.

### AC3 — Hard-fail setup when self-heal is impossible (Q2)

- When the proposal is unreachable per AC1 **and** self-heal per AC2 is not
  possible — the artifact is genuinely absent from disk, or the narrow commit /
  push cannot proceed (wrong/dirty branch, no `origin`, push rejected) — slot
  setup **throws** a clear, actionable error (e.g.
  `proposal <path> for task <id> is not reachable from <ref>/origin and could
  not be self-healed`). The error surfaces through the adapter's normal setup
  failure path (the same seam as the existing `createWorktrees` "project checkout
  not found" throw, `worktrees.ts:550`) so the slot is marked failed for
  operator/Mag remediation.
- The guard **never forks a proposal-less tree**: the throw happens *before*
  `addWorktree` runs. (Self-heal when you can; block when you can't.)
- A hard-fail emits a warning event (e.g.
  `event_type: "proposal_unreachable"`) so Mag/operator see the cause.

### AC4 — Guard placement and proposal-less tolerance

- The guard runs on the **executing machine**, at slot-start, where
  `createWorktrees` runs — so it sees the actual fork ref and works for
  cross-machine slots (a controller-side gate at `src/mag.ts:3314` cannot soundly
  introspect a remote worker's repo). Concretely it lives in / is called from the
  adapter's `setupOrchestratedSlot` just before `createWorktrees`
  (`tmux-adapter.ts:774`, `t3code.ts:1096`), or threaded into `createWorktrees`
  after `refreshMainBranchFromRemote` and before the first `addWorktree`. One
  shared helper is used by both backends (no per-backend drift).
- The guard **no-ops** when the task has no real `proposal:` — keys on
  `proposalValue && proposalValue !== "inline"` (the deprecated sentinel), the
  same shape already used in `taskSpecText` / `taskSpecBriefText`
  (`skills.ts:118-122,153-156`). Proposal-less tasks (direct GH-issue-AC-driven
  work) are legitimate and must not be blocked.
- **Resume tolerance.** On resume the per-agent branches already carry the
  proposal in their history. The guard must tolerate the proposal being reachable
  from the *agent/root* orchestration branch's history, not only from
  `<main>`/`origin` — so a resume whose `main` has since moved does not
  false-block. (The `addWorktree` resume short-circuit at `worktrees.ts:368`
  returns before any fork; the guard either runs before that determination and
  accepts agent-branch reachability, or is skipped on the resume short-circuit
  path. Either is acceptable as long as resume never false-fails.)

### AC5 — `refreshMainBranchFromRemote` surfaces a warning on pending-proposal skip (Q5)

- `refreshMainBranchFromRemote` (`worktrees.ts:467`) currently skips silently
  (dirty / diverged / other-branch / fetch-failed). It gains a way to report
  *that it skipped* to the caller so the slot-start guard can emit a warning
  event when it skips **while a proposal commit is pending** (i.e. the proposal
  is not yet reachable from the local fork ref).
- The warning event (e.g. `event_type: "main_refresh_skipped"`) records the skip
  reason (which condition tripped: no-origin / wrong-branch / dirty / fetch-fail /
  diverged) and the pending proposal path, so mode (a) is no longer invisible.
- This is the only behavioural change to `refreshMainBranchFromRemote`: it does
  **not** start switching branches, stashing, or forcing — those skips remain
  skips; they merely become *observable*. (Refactoring its return type from
  `void` to a small skip-reason result, or adding an out-param/callback, is at
  the implementing agent's discretion as long as existing callers and tests
  remain green.)

### AC6 — Tests

Regression tests, runnable via `bun test` in `~/ludics`:

- **(i) Self-heal path** — a task with `proposal:` set and the artifact present
  on disk but **uncommitted** → slot-start commits it (only that file), pushes,
  and the proposal becomes reachable from **both** the local fork ref and
  `origin/<main>`; the fork then proceeds. Assert the commit touched only the
  proposal path and that a `proposal_self_healed` event was emitted.
- **(ii) Hard-fail path** — a task with `proposal:` set but the artifact
  **genuinely absent** from disk → slot setup throws a clear error and **no
  worktree is forked**. Assert the error message names the task + proposal path,
  and that a `proposal_unreachable` event was emitted.
- **(iii) Both-refs check** — proposal reachable from **both** refs passes;
  reachable from **only one** ref (e.g. committed locally on the fork ref but not
  pushed to origin, and vice-versa) **fails** the reachability check (drives
  self-heal/block). Two-arm assertion.
- **(iv) Refresh-skip warning** — `refreshMainBranchFromRemote` exercised under a
  skip condition (e.g. dirty working tree, or local branch diverged from origin)
  with a pending (unreachable) proposal → a `main_refresh_skipped` warning event
  is emitted carrying the skip reason and proposal path. A control case (clean
  ff-merge succeeds) emits **no** such warning.
- **(v) Proposal-less no-op** — a task with no `proposal:` (or `proposal:
  inline`) runs the guard with **no error, no commit, no event** — the fork
  proceeds unchanged. (Pins AC4's no-op behaviour so the guard never regresses
  legitimate proposal-less tasks.)

### AC7 — Worker remains the canonical committer (no regression)

- The worker (`skills/ludics-draft-proposal-worker.md`) stays the primary
  proposal committer; slot-start self-heal is a **safety net**, not a
  replacement. The worker's step-8 commit/push recipe is unchanged.
- Optionally, the worker's Error Handling line
  (`skills/ludics-draft-proposal-worker.md:259`) MAY be tightened to a
  post-push reachability self-check that flips to `status: "error"` on failure
  (closing mode (b) at the source too); if done, the same edit is mirrored in
  `skills/ludics-revise-proposal-worker.md` to keep the two in lockstep (the
  scope-(1) invariant of the prior proposal). This is **secondary** — the
  load-bearing guard is at slot-start per the user's answers, and the worker-skill
  tightening must not be treated as a substitute for AC1–AC5.

## Context

### The pipeline and where each mode bites

```
draft-proposal-worker (skill)  ── writes file, commits+pushes to origin/<main>, sets proposal: frontmatter
        │                          [mode (b): commit/push can fail/skip → "completed" anyway; :259 "log and carry on"]
        ▼
ludics-draft-proposal (orchestrator skill)  ── routes "completed" → auto-start-evaluate  [no git-reachability check]
        ▼
maybeFillEmptySlots (src/mag.ts:3267)  ── gate at :3314 checks only `content.includes("\nproposal:")` (frontmatter)
        │  slotAssign → slot start
        ▼
setupOrchestratedSlot (tmux-adapter.ts:774 / t3code.ts:1096)   ◄── GUARD GOES HERE (executing machine)
        │  createWorktrees(projectDir, …)  (worktrees.ts:525)
        │    refreshMainBranchFromRemote(projectDir, main)  (worktrees.ts:563/467)
        │      [mode (a): skips silently on dirty/divergent/wrong-branch local checkout — AC5 makes it observable]
        │    addWorktree(…, resolvedMainBranch)  forks coder/reviewer  (worktrees.ts:583,601)
        ▼
plan/work phase  ── coder/reviewer read proposal from their worktree → ABSENT
```

### Key code pointers (verified at HEAD)

- **Fork ref.** `createWorktrees` resolves `resolvedMainBranch = mainBranch ??
  defaultMainBranch(projectDir)` (`worktrees.ts:556`) and forks every root /
  per-agent branch from it via `addWorktree(projectDir, …, resolvedMainBranch)`
  (`worktrees.ts:583,601`). This is the ref the guard must check (AC1 local arm).
- **Fork-time sync.** `refreshMainBranchFromRemote(projectDir, mainBranch)`
  (`worktrees.ts:467`) is `void`-returning and skips silently on: no
  `remote.origin.url`, current branch ≠ `mainBranch`, dirty working tree, `git
  fetch` failure, or ff-only merge failure (divergence). All five are the
  mode-(a) window (AC5).
- **Reachability precedent.** `proposalFreshnessWarning` (`skills.ts:59`) already
  git-introspects the proposal via `gitOutput(projectDir, ["log","-1",…])` and
  `git merge-base --is-ancestor`; it returns `""` when `!hash`
  (`skills.ts:67`) — the never-committed blind spot. Reuse its
  `proposalValue && proposalValue !== "inline"` keying and
  `assertRepoRelativeProposalPath` guard.
- **Existing slot-start throw seam.** `createWorktrees` already throws a
  machine-attributed error for a missing checkout (`worktrees.ts:544-551`); AC3's
  hard-fail should surface through the same adapter setup-failure path.
- **Frontmatter-only gate (do not "fix" here).** `src/mag.ts:3314` checks
  `content.includes("\nproposal:")` on the **controller's** harness, not the
  worker's repo — for remote slots it would introspect the wrong machine, so the
  authoritative guard belongs on the executing machine (AC4). Leave mag.ts:3314
  as-is.
- **Adapters read the task file.** Both `setupOrchestratedSlot`
  (`tmux-adapter.ts:774`, `t3code.ts:1096`) have `taskId` and run on the
  executing machine; the proposal path is read from the task file via
  `parseTaskFrontmatter` (`src/tasks/markdown.ts`), the same parser the
  orchestration skills use.
- **Events.** `emitEvent` (`src/events.ts:30`) is best-effort, forwards to the
  controller over HTTP when called on a remote worker, and never throws the
  caller — suitable for the AC2/AC3/AC5 events from inside slot-start.

### Prior fix this layers on (do not redo)

`docs/proposals/proposal-commit-on-main-and-worktree-resume.md` (task
`task-a1e55a19`) made the worker the canonical committer (step 8 branch
discipline) and added the `addWorktree` resume short-circuit
(`worktrees.ts:368`). This task is **additive on top of it for modes (a)/(b)** —
plus the Q5 revisit of `refreshMainBranchFromRemote`'s silent-skip. The
worker-as-committer choice stands; slot-start self-heal is the safety net for
when that best-effort commit did not land.

## Scope

**In scope:**

- A shared reachability helper (both-refs: `resolvedMainBranch` + `origin/<main>`)
  used by both orchestration backends.
- Slot-start self-heal (narrow commit+push of the on-disk proposal) or hard-fail
  block, run on the executing machine just before `createWorktrees` forks.
- Informational/warning events for self-heal, hard-fail, and
  `refreshMainBranchFromRemote` pending-proposal skip.
- The minimal change to make `refreshMainBranchFromRemote`'s skip observable to
  its caller.
- Regression tests (i)–(v).

**Out of scope:**

- Redesigning the proposal-commit pipeline or the worker-as-committer choice.
- Changing the `src/mag.ts:3314` controller-side frontmatter gate (wrong machine
  for remote slots).
- Re-queuing `draft-proposal` as the orphan remediation (Q4 chose narrow commit,
  not re-explore).
- Making `refreshMainBranchFromRemote` start switching branches / stashing /
  forcing — its skips remain skips, only now observable.
- The worker-skill `status: "error"` tightening is **optional** (AC7); the
  load-bearing fix is at slot-start.

**Dependencies:** none on other open tasks. Builds on `task-a1e55a19`
(`proposal-commit-on-main-and-worktree-resume.md`). Relates to gh-ludics-578,
gh-ludics-579.

## Approach

*Suggested — agents may deviate.*

1. Add `proposalReachableFromRef(projectDir, ref, proposalPath): boolean` (e.g.
   in `worktrees.ts` or a small sibling), wrapping `git cat-file -e
   <ref>:<proposalPath>` via `safeSyncOutput`. Compose a `bothRefsReachable`
   that checks `resolvedMainBranch` and `origin/<mainBranch>`.
2. Add a `selfHealOrBlockProposal(projectDir, taskId, proposalPath,
   resolvedMainBranch, slot)` helper: read frontmatter, no-op if no real
   proposal; if reachable from both refs, return; else if on disk and the
   checkout is on `resolvedMainBranch` with no foreign dirty state, `git add
   <proposal>` + `git commit -- <proposal>` + `git push origin
   <resolvedMainBranch>`, re-check, emit `proposal_self_healed`; else throw and
   emit `proposal_unreachable`. Call it from `setupOrchestratedSlot` (both
   backends) immediately before `createWorktrees`, OR thread it into
   `createWorktrees` after `refreshMainBranchFromRemote`.
3. Refactor `refreshMainBranchFromRemote` to report its skip reason (return a
   small `{ skipped: false } | { skipped: true; reason }`, keeping callers that
   ignore it compiling). Where the guard runs, if the proposal was not reachable
   from the local fork ref and the refresh skipped, emit `main_refresh_skipped`
   with the reason + proposal path.
4. Tests (i)–(v) using the existing `worktrees.test.ts` git-fixture helpers
   (local bare "origin" repo + clone) so the `origin/<main>` arm and the
   committed/pushed/local-only states are all constructible without a network.
5. Build + verify: `bun run build` then `bun test` in `~/ludics`.
