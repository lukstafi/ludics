# Runner plan-time warnings: stale-base + missing regression-tests section

## Goal

Add two runner-side, phase-boundary early warnings that save orchestration rounds by flagging conditions a reviewer would otherwise catch only after a full round:

- **(A) Stale-base warning**: when entering the `plan` phase (and `work` phase for plan-skip modes) the coder's worktree's merge-base is significantly behind `origin/<main>`, emit a warning that nudges the operator toward rebasing. Prevents the reviewer's `git diff main..HEAD` output from showing phantom "deletions" caused by commits landed on `main` after fork.
- **(B) Missing `## Regression Tests` section warning**: after `plan-merge` completes, if the merged plan file does not contain a top-level `## Regression Tests` section, emit a warning. The reviewer template (`pair-reviewer-plan-review.md`, landed in PR #344 for gh-ludics-310) already requests changes in this case; this warning just fires earlier, giving the coder a chance to add the section before implementation.

Both are advisory — never block, never raise, never retry. Failing git commands or missing files silently skip the check.

Sourced from the gh-ludics-310 retrospective (items 2 + 4). Same orchestration phase (plan / plan-merge), same shape (warn-not-fail), both expressed via `emitEvent`.

## Acceptance Criteria

1. **Item A (stale-base warning)**
   - On entry to the `plan` phase, and on entry to the `work` phase when the plan phase was skipped or when staleness is newly detected, the runner:
     - Runs `git fetch origin <main>` in the coder's worktree (tolerating failure silently).
     - Measures `git rev-list --count $(git merge-base HEAD origin/<main>)..origin/<main>` in the coder's worktree.
     - If the count meets or exceeds `LUDICS_WARN_BASE_STALENESS_THRESHOLD` (default `5`), emits an `orchestration_warning` event via `emitEvent` naming the worktree, the main branch, and the commit count.
     - The warning message recommends `git rebase origin/<main>` before continuing.
   - Dedup is "newly needing rebase" per round: remember the last commit count warned at for the current round; re-warn only when the new count is greater than the remembered count (or when no prior warning has fired this round). An already-fired, not-yet-acted-on warning does not re-fire.
   - The round counter for dedup is `state.round`; when `state.round` changes, the remembered count resets so the warning can fire once in each new round as needed.
   - A threshold of `0` or negative disables Item A entirely.
   - Any git failure (missing `origin/<main>`, shallow clone, spawn error, etc.) silently skips the check.

2. **Item B (missing regression-tests section warning)**
   - After the `plan-merge` phase completes (i.e., during the on-entry-to-`plan-review` artifact-validation path), the runner reads the merged plan file at `mergedPlanFilePath(peerSyncDir, state.round, state.planMergeRound)` and checks for a `^## Regression Tests$` line (multi-line regex, exact match).
   - If absent, emits an `orchestration_warning` event via `emitEvent` naming the merged plan filename.
   - The warning message notes that the reviewer backstop still catches this structurally (`pair-reviewer-plan-review.md` enforces it) but suggests adding the section before implementing.
   - The check is skipped entirely when `LUDICS_WARN_MISSING_TESTS_SECTION=0` (default: on). Any truthy value (unset, `"1"`, anything other than `"0"` / `"false"`) keeps the check enabled.
   - Skipped when the merged plan file is absent or unreadable (existing `validatePreviousPhaseArtifacts` already warns about missing artifact; this check is strictly a content-level add-on that runs only when the file exists).
   - In solo mode there is no `plan-merge` phase, so the check naturally self-skips; no extra mode guard is required beyond the existing `ctx.phase === "plan-merge"` gating.

3. **Dispatch & dedup wiring**
   - Warnings are emitted from the one-shot phase-entry code path (inside `enterPhase`, same block as `validatePreviousPhaseArtifacts`), so the `state.phaseDispatched` guard gives once-per-dispatch semantics. Re-entry after crash-recovery may duplicate a warning at most once per phase entry — acceptable.
   - Neither warning mutates orchestration state beyond the dedup memo. Neither raises. Both are wrapped in try/catch that swallows and continues.

4. **Env-var surface**
   - `LUDICS_WARN_BASE_STALENESS_THRESHOLD` — integer, default `5`. Parsed once per warning trigger with `parseInt(..., 10)` and `NaN` fallback to `5`; `<=0` disables Item A.
   - `LUDICS_WARN_MISSING_TESTS_SECTION` — string, default on. Disabled only when the value is exactly `"0"` or `"false"` (case-insensitive). Documented in the runner module docstring or the task's follow-up CHANGELOG entry.

5. **Tests**
   - A test file (new `runner.plan-warnings.test.ts` sibling, or added to `runner.verification.test.ts` if that keeps the test suite coherent) covers both warnings via direct function invocation (same style as existing `isWorktreeNoOp` tests). No full orchestration loop is required.
   - For each warning, tests cover: (a) happy path — threshold not exceeded / section present, no event emitted; (b) warning-fires path — threshold exceeded / section missing, event emitted with correct message shape; (c) env-var opt-out respected; (d) git-command / file-read error silently skipped (no event, no throw).
   - Item A tests additionally cover the "newly needing rebase" dedup: no re-fire when the count hasn't grown; re-fire when it has; reset on round change.
   - Tests mutate `process.env` via `beforeEach`/`afterEach` restore, matching existing patterns.
   - `makeGitRepo()` from `runner.test-helpers.ts` is extended (if needed) or used as-is to seed an `origin/main` with additional commits after fork to exercise Item A. The `fetch` invocation should be tolerant to the bare local-remote setup the test helper creates (no-op fetch is fine).

6. **Events**
   - Event payloads use `event_type: "orchestration_warning"`, `source: "orchestration"`, `scope: "slot"`, and include `slot`, `task`, and a human-readable `message` — matching the existing `validatePreviousPhaseArtifacts` emit shape.

## Context

### Resolved direction (from task Questions section)

- **Warning sink**: `emitEvent` (not raw `console.error`) — matches the existing `validatePreviousPhaseArtifacts` path and flows through the journal + notification pipeline.
- **Item A placement**: both `plan`-entry and `work`-entry, with dedup on "newly needing rebase" (re-warn only when the commit count grows, or no prior warning this round). Work-entry covers plan-skip modes and staleness that lands during plan.
- **`LUDICS_WARN_MISSING_TESTS_SECTION` default**: on. PR #344's templates mean a well-behaved plan never trips the warning; no baseline noise.
- **`git fetch origin <main>` before measuring**: yes. Pure ref refresh, safe by construction (no merge machinery, no conflict surface). 1–3s cost per trigger (≤2× per round) is acceptable at this task's frequency. Divergence from task-41752614 (which avoids fetching) is justified by that task's much higher call rate.

### Code pointers (verified against current `main`, commit `59e396b`)

Runner / orchestration transitions / artifact validation:

- `src/orchestration/runner.ts`
  - `validatePreviousPhaseArtifacts(state, ctx)` (near top of file) — existing model for "emit a warning about a prior-phase artifact condition." Called from `enterPhase()` right after `state.previousPhaseCtx` is consumed. **Item B's content-level check is a natural extension here** — gated on `ctx.phase === "plan-merge"` and `existsSync(artifactPath)`.
  - `enterPhase(state, transport)` — main phase-entry one-shot guarded by `state.phaseDispatched`. **Item A fires from here** (or from a helper called here) on entry to `plan` / `work`.
  - `isWorktreeNoOp(worktreePath, projectDir)` — idiom for running git commands (`git rev-list --count origin/${baseBranch}..HEAD`) via `Bun.spawnSync` with `cwd: worktreePath` and silent-skip on error. **Item A mirrors the inverse direction**: `merge-base ..origin/<main>`. Uses `defaultMainBranch(projectDir)` helper from `worktrees.ts` (already imported).
- `src/orchestration/plan-files.ts`
  - `mergedPlanFilename(round, planMergeRound)` and `mergedPlanFilePath(peerSyncDir, round, planMergeRound)` — canonical merged-plan path; Item B should use these rather than reconstruct.
- `src/orchestration/phases.ts`
  - `requiredArtifactPath()` already returns `mergedPlanFilePath(...)` for phase `plan-merge`. `validatePreviousPhaseArtifacts` already knows the file should exist when `ctx.phase === "plan-merge"`; Item B adds a content check on top.
  - `agentParticipatesInPhase(state, agent)` — skips Item B automatically in solo mode because solo has no `plan-merge` phase participant.
- `src/orchestration/state.ts`
  - `OrchestrationState.projectDir` (shared project checkout) and `AgentConfig.worktreePath` (per-agent worktree). Item A targets the coder's worktree.

Env-var idioms:

- `src/mag.ts` (`LUDICS_STARTUP_WATCHDOG_*` parsing) and `src/cluster.ts:10` (`parseInt(process.env.LUDICS_HEARTBEAT_TIMEOUT ?? "900", 10)`) — the style to follow: read once, parse, clamp / fallback on NaN.

Test helpers:

- `src/orchestration/runner.test-helpers.ts:28` — `makeGitRepo()` creates a minimal repo with `origin/main` and is already reused across `runner.verification.test.ts` (which hosts the `isWorktreeNoOp` and `validatePreviousPhaseArtifacts` tests). New tests for this task fit naturally in a sibling `runner.plan-warnings.test.ts` or appended to `runner.verification.test.ts` — either is acceptable.

### Edge cases worth keeping in mind (from Tentative Design)

- Once-per-round dedup — solved by placing warning calls inside the `state.phaseDispatched`-guarded one-shot path. Item A additionally tracks last-warned commit count per round.
- Crash-recovery — `previousPhaseCtx` is persisted and consumed on resume, so Item B still fires on post-crash entry to `plan-review`.
- Solo mode — Item A fires regardless; Item B self-skips because `ctx.phase !== "plan-merge"`.
- Shallow clones / missing `origin/main` — silent skip on any git failure.
- Header matching precision — use `/^## Regression Tests$/m` regex (not substring) to avoid matching prose mentions.

### Follow-up relationships

- **task-41752614** (proposal-freshness warning) now piggybacks on this task's `git fetch origin <main>` for its own freshness check, avoiding a redundant fetch. Out of scope here — 41752614 wires up the cross-reference in its own changes.
- **task-03df8772** (PR-body refresh on force-push) is orthogonal phase (`pr-create`) and unrelated.
- **task-9f21d3de** (runner test-file split) has already landed in substance — `runner.test.ts` is now several sibling files. Placement of new tests follows that convention.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Item B first** (smaller diff, closer to existing code):
   - Extend `validatePreviousPhaseArtifacts` in `runner.ts`, or add a sibling `warnMissingRegressionTestsSection(state, ctx)` called from the same site in `enterPhase`, gated on `ctx.phase === "plan-merge"` and `process.env.LUDICS_WARN_MISSING_TESTS_SECTION !== "0"` (and not `"false"`).
   - Use `mergedPlanFilePath(...)` from `plan-files.ts` to resolve the file.
   - Read with `readFileSync(path, "utf-8")`, match `/^## Regression Tests$/m`, emit `orchestration_warning` on miss.
   - Wrap read + match in try/catch; swallow any error.

2. **Item A** second:
   - Add a helper `warnStaleBase(state)` in `runner.ts`. Read the threshold from `LUDICS_WARN_BASE_STALENESS_THRESHOLD` (default `5`); bail early if `<=0`.
   - Resolve the coder agent and its `worktreePath`. Call `defaultMainBranch(state.projectDir)` for the base-branch name.
   - Run `git fetch origin <main>` in the worktree via `Bun.spawnSync`, ignoring exit status and stderr. Then run `git rev-list --count $(git merge-base HEAD origin/<main>)..origin/<main>` (either as one shell invocation with `sh -c`, or as two spawns: resolve merge-base, then count — two spawns is cleaner and avoids a shell dependency; matches `isWorktreeNoOp`'s style).
   - Compare to threshold; track last-warned count per round on the state (e.g., `state.staleBaseLastWarnedCount` and `state.staleBaseLastWarnedRound`). Re-warn only when the count grows within the same round.
   - Emit `orchestration_warning` with the worktree path, base branch, and commit count.
   - Call `warnStaleBase(state)` from `enterPhase` — gated on `state.phase === "plan"` or (`state.phase === "work"` and the plan phase was skipped / wasn't yet entered this round). The simplest gate is "fire on entry to plan or work, rely on the round-level dedup to avoid double warnings."

3. **State additions for dedup** (Item A):
   - Add two optional fields to `OrchestrationState` in `state.ts`: `staleBaseLastWarnedRound?: number` and `staleBaseLastWarnedCount?: number`. Treat both as persisted (they're simple scalars; follow whatever the existing serialization does for optional fields).
   - On each `warnStaleBase` entry, if `state.staleBaseLastWarnedRound !== state.round`, reset `staleBaseLastWarnedCount` to `0` / `undefined`.
   - Emit only when `count >= threshold && count > (staleBaseLastWarnedCount ?? 0)`.
   - On emit, set both fields.

4. **Tests** in `src/orchestration/runner.plan-warnings.test.ts` (new file) — cover the acceptance-criteria test matrix. Use `makeGitRepo()` + supplementary helpers to advance `origin/main` after fork. Mutate `process.env` with `beforeEach`/`afterEach` restore.

5. **No template / skill / CHANGELOG changes** are required; this is a pure runner-code addition. If documentation lives elsewhere (e.g., a CONFIG-vars reference), add a two-line note there — otherwise runner module docstrings are sufficient.

## Scope

**In scope:**
- Runner code additions in `src/orchestration/runner.ts` for both warnings.
- Optional `OrchestrationState` field additions for Item A's dedup memo.
- New test file (or additions to `runner.verification.test.ts`) exercising both warnings via direct invocation.
- Env-var parsing (`LUDICS_WARN_BASE_STALENESS_THRESHOLD`, `LUDICS_WARN_MISSING_TESTS_SECTION`).

**Out of scope:**
- Programmatic validation / hard gates. Warnings only; reviewer backstop stays authoritative.
- Changes to `pair-coder-plan.md`, `pair-reviewer-plan.md`, or `pair-reviewer-plan-review.md` templates (PR #344 already landed the regression-tests enforcement there).
- DRY-ing the regression-tests instruction between templates (retrospective item 1; deferred until a third template shares the block).
- `proposalFreshnessWarning` / task-41752614 changes — piggybacking is in 41752614's scope.
- Running `git fetch` in any code path other than Item A's measurement trigger.
- Surfacing warnings via `notifyAgents(...)` (slot-level notify) — `emitEvent` alone is the agreed sink.

**Dependencies:** none blocking. `task-9f21d3de` (runner test-file split) already landed in substance.
