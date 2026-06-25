# Fail loud on stale/missing worker task content + plug worker→harness write leaks

## Goal

Close the silent-failure path where a worker node, running orchestration against
a **stale local harness checkout** that is missing (or carries a divergent copy
of) the assigned task file, launches an agent against an **empty/ID-only task
spec** — and ends up executing whatever sibling work its project checkout
happened to carry, with commits still tagged with the assigned task ID. In the
precipitating incident the wrong work was even auto-merged. "Launch worked" was
indistinguishable from "ran the right thing."

Resolves https://github.com/lukstafi/ludics/issues/609.

Two coupled defects:

1. **Silent degradation on missing/stale task content.** The adapter setup reads
   the task file from the worker's local harness with a silent `existsSync`
   guard. A missing file yields `taskContent = null` → `proposalPath = ""`, which
   *disarms* the proposal-reachability guard (gated behind `if (proposalPath)`),
   and the agent-facing TASK_SPEC degrades to the bare task ID. No throw, no
   event — setup proceeds against an empty spec.

2. **Worker→harness write leaks.** The read-only-worker model that makes "git as
   the content channel" safe is not airtight: `collectAndWriteRetrospective`
   writes `retrospectives/<taskId>.json` and copies `feedback/<taskId>--*.md`
   into the worker's *tracked* harness checkout, ungated. Those untracked files
   then **block the `git pull --ff-only`** that would have refreshed the task
   content — the leak compounds defect 1.

The chosen direction (resolved 2026-06-25 with the user) is **(b)+(c), not (a)**:
keep git as the controller→worker content-delivery channel (workers already write
essentially nothing to the tracked harness — `sync` is controller-only, all
high-frequency writes route to a worker cache + HTTP POST) and add **freshness
discipline + a loud gate** on the worker read path, plus close the write leaks so
pulls can never wedge. A parallel HTTP content-delivery endpoint (a) is redundant
given git already delivers the content; the only defect is reading it stale.

## Acceptance Criteria

### Gate (b) — loud refusal at the adapter setup site

1. **Missing task file fails loudly at setup.** When the assigned task file is
   absent from the executing machine's harness (`existsSync(taskFilePath) ===
   false`) at the adapter setup site — `start(ctx)` in **both**
   `src/adapters/tmux-adapter.ts` and `src/adapters/t3code.ts`, at the point
   where `taskFilePath_`/`taskContent_`/`proposalPath_` are computed, before
   `createWorktrees` — setup throws instead of silently yielding
   `taskContent = null`. The throw surfaces through the existing adapter
   setup-failure path (`slot_setup_failed`, the same surface taken by the
   "project checkout not found" and "proposal unreachable" throws), so the slot
   lands in a visible failed state rather than launching an agent.
   - *Falsifier:* a test that drives the adapter setup (or the extracted guard
     helper) with a harness dir lacking `tasks/<id>.md` asserts a throw whose
     message names the missing task file; deleting the throw makes the test go
     green-then-launch.

2. **Present-but-stale task content is also caught.** When the controller
   supplies an expected content fingerprint (a content hash or the task's
   introducing-commit SHA — see AC4) alongside the dispatch, the worker compares
   it against its local task file and refuses (same `slot_setup_failed` surface)
   on mismatch. A bare `existsSync` passes when *any* file with the right name
   exists; this AC additionally catches the divergent/stale-content near-miss.
   - *Falsifier:* a test supplying a fingerprint that does not match the
     local file content asserts a throw; a matching fingerprint passes. Both the
     mismatch (throw) and match (no throw) limbs are exercised — a guard that
     only checks existence fails the mismatch limb.
   - The fingerprint is *optional on the intent*: legacy/local dispatch that
     carries no fingerprint falls back to the existence-only check (AC1) and
     does not throw on a present file. (A worker with no controller-supplied
     fingerprint is the standalone/local case, where the harness *is*
     authoritative.)

3. **Uniform across orchestration modes.** The gate fires once per setup, at the
   adapter level, before any worktree is forked — so it covers solo, duo (separate
   worktrees), and pair (shared worktree) identically with no per-agent
   special-casing. No agent of any mode launches when the gate trips.

### Precondition (c) — dispatch-time freshness gate on the worker

4. **Controller threads the assigned task's introducing-commit through the
   dispatch intent.** The task file is git-tracked in the harness, so its
   introducing commit is knowable on the controller via
   `git -C <harnessDir> log -1 --format=%H -- tasks/<taskId>.md`. The controller
   attaches this SHA (a new optional field on `PendingIntent`, threaded through
   `ensureRemoteMachineReachable`'s `intentPayload` from `slotStart`'s remote
   branch and validated in `parsePendingIntent` with the same optional /
   string-coerce / drop-when-empty contract as the existing `taskId` and
   `adapterArgs` fields). Legacy intents and on-disk files without the field
   remain valid.

5. **Worker fetches, then requires the intro-commit to be an ancestor of its
   harness HEAD before launching.** On the worker, before the start intent is
   acted on (in `processSlotIntents` / before `slotStart` reaches the adapter
   setup read), the worker refreshes its harness (`git fetch` + fast-forward —
   `statePull` already does fetch + `reset --hard origin/main`) and verifies
   `git merge-base --is-ancestor <introCommit> HEAD` against the harness. If the
   ancestry check fails after the fetch, the start is refused loudly (intent left
   unacked / surfaced as a setup failure) rather than launching against stale
   content.
   - **Fetch-before-ancestry is load-bearing:** a 0-behind `HEAD..origin/main`
     lies if the worker has not fetched (the known "worker deploy stale-ref
     trap"). The fetch must precede the ancestry test.
   - *Falsifier:* a test (or fixture) where the worker HEAD does **not** contain
     the intro-commit asserts the start is refused; a HEAD that does contain it
     (post-fetch) proceeds. The pre-fetch 0-behind-lie case is covered by
     fetching first.

### Write-leak closure

6. **`writeRetrospective` and feedback persistence are worker-context-safe.** On
   a worker (`isWorkerContext() === true`) neither `writeRetrospective`
   (`retrospectives/<taskId>.json`) nor the workflow-feedback copy
   (`feedback/<taskId>--*.md`, in `persistWorkflowFeedback`) writes into the
   tracked harness checkout. Each is routed through the existing
   worker→controller write-back pattern (a new HTTP endpoint mirroring
   `task-update`/`slot-update`, e.g. `POST /api/cluster/retrospective`, and/or a
   `workerCacheDir()` write + POST — the same shape `persistState` already uses).
   On a controller/standalone node the behaviour is unchanged (still writes the
   harness directly).
   - *Falsifier:* a test running `collectAndWriteRetrospective`-equivalent writes
     under a stubbed worker context asserts the harness `retrospectives/` and
     `feedback/` dirs gain **no** new files (and that the controller-write path
     still fires under a controller context).

7. **Audit: no ungated `harnessDir()` writes remain on a worker-reachable path.**
   Grep the codebase for `harnessDir()`-anchored `writeFileSync` /
   `writeJsonFile` / `appendFileSync` / `copyFileSync` / `mkdirSync` writes that
   are reachable from the orchestration runner (worker-executing) and **not**
   guarded by `isWorkerContext()` redirection or HTTP write-back. The
   retrospective + feedback sites (AC6) are the known instances. Any *other*
   site found on a worker-reachable path is brought under the same redirection
   (or explicitly justified as controller-only in the proposal/PR notes — e.g.
   Mag-only paths in `mag.ts`/`notify.ts`/`sessions/` that never execute on a
   worker). The set of remaining ungated worker-reachable harness writes is
   **empty**.
   - *Falsifier:* the audit enumerates each candidate site with a one-line
     reach verdict (worker-reachable vs controller-only); a worker-reachable
     site left ungated fails the AC.

8. **A worker orchestration run leaves its harness checkout clean.** As the
   integration-level invariant the above ACs serve: after a worker completes an
   orchestration run (through retrospective collection), `git -C <harnessDir>
   status --porcelain` reports **no new tracked-or-untracked files** attributable
   to the run — so a subsequent `git pull`/fast-forward can never wedge on a
   dirty worker checkout. This is the load-bearing property; AC6/AC7 are its
   mechanism.

### AC verification reachability — harness path is outside `git -C <project_path>`

The retrospective/feedback paths and the harness `tasks/` directory live in the
**harness repo**, not the project repo this orchestration runs against. When an
AC's evidence concerns those paths, verify with tooling reachable from the
harness checkout (`git -C <harnessDir> status --porcelain`, `find`/`grep` over
`<harnessDir>/retrospectives` and `<harnessDir>/feedback`) — not a
`git -C <project_path>` introspection that would return "not a git repository"
for the harness subtree. The clean-checkout probe (AC8) is explicitly a
`git -C <harnessDir> status --porcelain` over the harness, run on the worker.

## Context

### How worker task/proposal content is resolved today (validated)

Task and proposal content are read from the executing machine's **local** harness
checkout, with no controller fetch and no consistency gate on the task file:

- `harnessDir()` (`src/config.ts`, `function harnessDir`) is purely local —
  `$HOME/<state-repo-name>/<state-path>` (or `$LUDICS_HARNESS_DIR`). On a worker
  this is the worker's own checkout, however stale. No HTTP/remote awareness.
- The adapter setup reads the task file at `join(ctx.harnessDir, "tasks",
  \`${taskId}.md\`)` with a silent guard:
  `taskContent_ = existsSync(taskFilePath_) ? readFileSync(...) : null;
  proposalPath_ = taskContent_ ? parseTaskFrontmatter(taskContent_).proposal ?? "" : ""`
  — identical shape in `start(ctx)` of `src/adapters/tmux-adapter.ts` and
  `src/adapters/t3code.ts`.
- `createWorktrees(projectDir, taskId, ..., proposalPath_)`
  (`src/orchestration/worktrees.ts`) gates its proposal-reachability guard behind
  `if (proposalPath)` — so an empty path means `ensureProposalReachable` is
  **never invoked**. A missing task file zeroes the proposal path and thereby
  disarms the one guard that would have caught a stale project-repo artifact.
- `buildSkillContext` (`src/orchestration/skills.ts`) resolves the task path via
  `taskFilePath(...)` (helper in `src/orchestration/paths.ts`) and degrades
  TASK_SPEC to the bare task ID when content is null. These reads are synchronous.

There is **no** taskId→file fuzzy fallback in the resolver — so the orchestration
did not deterministically substitute the sibling task at the code level; it ran
with an empty/ID-only spec and the sibling's content reached the agent through the
project checkout / in-flight branch state the worker had been dropped into. The
code-level defect is precisely the **silent degradation to an empty spec with no
guardrail**.

### Why git-as-channel makes (a) unnecessary

Workers already write essentially nothing to the *tracked* harness:

- The git `sync` trigger is controller-only (`CONTROLLER_ONLY_TRIGGER_NAMES`,
  `src/triggers.ts`).
- Orchestration state → `workerCacheDir()` (non-tracked) + HTTP
  `clusterPostOrchestrationState` (`persistState`, `src/orchestration/state.ts`).
- Queue ops, journal/events, task field updates, Notes appends, notify — all
  no-op-on-worker or routed to HTTP (`clusterPostTaskUpdate` /
  `clusterPostTaskSectionAppend` / `clusterPostJournal` / `clusterPostEvent`,
  `src/cluster-http.ts`).

So git already delivers human-authored content (task files, proposals) one way
(controller→worker pull) and HTTP carries machine write-back the other
(worker→controller POST). The only delivery defect is the worker reading the git
content **stale** — fixed by pull-before-read freshness (c) + a loud gate (b),
not a second content path.

### Worker-side dispatch flow (where (c) and the fingerprint thread)

- Controller `slotStart` (`src/slots/index.ts`) routes remote starts through
  `ensureRemoteMachineReachable`, which `recordIntent(slotNum, { action, epoch,
  machine, ...intentPayload })`. The `intentPayload` already carries `taskId` and
  `adapterArgs` — the natural place to add the introducing-commit SHA.
- `PendingIntent` (`src/cluster-http.ts`) is the typed intent; `parsePendingIntent`
  is its untrusted-input validator with an established optional /
  string-coerce / drop-when-empty contract for `taskId` and `adapterArgs`.
- On the worker, `processSlotIntents` (`src/mag.ts`) polls `clusterGetIntents`,
  sets `setWorkerSlotsOverride(freshSlots)`, and dispatches
  `slotStart`/`slotStop`/`slotResume` — this is the worker-side point where the
  freshness fetch + ancestry gate runs before the adapter setup read.
- `statePull` (`src/state.ts`) already does `git fetch origin` + `git reset --hard
  origin/main` on the state repo — the existing primitive for the (c) refresh
  (today only used during handoff, explicitly "not used during normal operation").

### Write-leak sites (validated)

- `writeRetrospective` (`src/retrospective.ts`) — `mkdirSync(join(harnessDir(),
  "retrospectives"))` + `writeJsonFile(...<taskId>.json)`, ungated.
- `persistWorkflowFeedback` (`src/retrospective.ts`) — `copyFileSync` into
  `join(harnessDir(), "feedback")`, ungated.
- Both reached from `collectAndWriteRetrospective` (`src/retrospective.ts`),
  called at the end of an orchestration run in `src/orchestration/runner.ts`
  (worker-executing). Confirmed against the incident:
  `retrospectives/task-bfc7c7b5.json` was among the untracked files that blocked
  the worker's pull during cleanup.
- Other `harnessDir()` writes (`src/mag.ts`, `src/notify.ts`,
  `src/sessions/sweep-state.ts`) are on Mag/controller-only paths and are the
  audit's controller-only verdicts to confirm, not fix.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The approach was iterated with the user (resolved questions 2026-06-25); it is
straightforward layering, so it is included:

- **(b)** Extract the existing `taskFilePath_`/`taskContent_`/`proposalPath_`
  block from the two adapters into a shared guard helper that throws on a missing
  file (and on fingerprint mismatch when a fingerprint is supplied), then call it
  from both `start(ctx)` sites before `createWorktrees`. Reuse the
  `slot_setup_failed` surface — no new failure channel.
- **(c)** Add an optional introducing-commit field to `PendingIntent` +
  `parsePendingIntent`; populate it on the controller in `slotStart`'s remote
  branch via `git -C <harnessDir> log -1 --format=%H -- tasks/<id>.md`; consume
  it on the worker in `processSlotIntents` with a `git fetch`/`statePull`-style
  refresh followed by `git merge-base --is-ancestor`. The fingerprint (b) checks
  *content*; the ancestry gate (c) prevents most (b)-triggers from reaching setup
  at all — they compose.
- **Write leaks** Guard `writeRetrospective` + `persistWorkflowFeedback` with
  `isWorkerContext()`, routing the worker case to a `workerCacheDir()` write +
  HTTP POST (new `/api/cluster/retrospective` endpoint mirroring the
  `task-update` handler, plus a feedback equivalent or a bundled payload). Run
  the AC7 audit grep and record per-site verdicts.

The exact content-fingerprint shape (raw `git hash-object` of the task file vs
reusing the introducing-commit SHA from (c) as the integrity token) is a small
implementation choice left to the coder; reusing the (c) SHA avoids a second
controller-side computation and is the suggested default.

## Scope

**In scope:** the loud setup gate (b), the dispatch-time freshness precondition
(c), the retrospective + feedback write-leak closure, and the audit of
worker-reachable `harnessDir()` writes.

**Out of scope (explicitly):**
- The structural HTTP task/proposal *content-delivery* endpoint + the
  sync→async `buildSkillContext`/`composeSkillMessage` refactor (direction (a)) —
  ruled out as redundant given git already delivers content.
- Retroactive detection of an *already-running* wrong-task (commit-vs-content
  scope drift, PR title/scope mismatch). No code-level detector exists today;
  the incident's containment was manual. A post-hoc merged-PR-scope check is a
  separate feature.
- Overloading `ensureProposalReachable` to also cover the task file — the gates
  live in different repos (project vs harness); the cleaner home is a sibling
  guard at the adapter setup site where `ctx.harnessDir` and `taskId` are both
  in hand.

**Dependencies:** none hard. Related but independent: the
`AdapterContext.harnessDir` bypass audit (task-f60547cd,
`docs/proposals/audit-adapter-context-harnessdir-bypass.md`) — that hardens
`ctx.harnessDir` parametrization generally; this task adds the freshness/leak
guarantees on top and does not depend on it.
