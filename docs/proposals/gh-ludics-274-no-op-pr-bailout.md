# No-op PR bail-out: robust zero-commits detection and reviewer-approved done transition

## Goal

When a coder agent produces zero commits (e.g., the fix is already on main), the orchestration runner gets permanently stuck at the `pr-create` phase. The existing `checkZeroCommitsAutoBailOut()` function uses `git rev-list --count origin/HEAD..HEAD` which can fail in worktrees where `origin/HEAD` is not correctly resolved (stale symbolic ref, fork-based repos, renamed default branches). When detection fails, `validateAndFixPrFile()` tries `gh pr create` on a no-op message, that also fails, and the verification gate exhausts its retry budget, entering permanent hold.

This proposal fixes the detection to be robust across all worktree configurations and adds reviewer-approved bail-out so the transition to `done` follows the existing pair bail-out protocol.

## Acceptance Criteria

1. When coder produces zero commits and no uncommitted diffs, runner detects this and skips `pr-create`.
2. Bail-out transitions task to `done` after reviewer agent approves (using the existing `isPairBailedOut` protocol: coder writes `bail-out` status, reviewer writes `bail-out-confirmed`).
3. No permanent hold/stuck state when there's genuinely nothing to PR.
4. Duo mode: handle partial bail-out (one slot no-op, other has changes) — the slot with changes proceeds normally to PR; the no-op slot transitions to `done` independently.

## Context

### Current code path (broken)

1. **`checkZeroCommitsAutoBailOut()`** (`runner.ts:1446-1466`): runs after `pollUntilDone()` returns, before the verification gates. Uses `git rev-list --count origin/HEAD..HEAD` in the coder worktree. Returns `false` on non-zero exit code or non-zero count. Directly sets `state.phase = "done"` — no reviewer approval.

2. **`validateAgentPrFiles()`** (`runner.ts:1015-1058`): runs inside `pollUntilDone()` during the `pr-create` phase. When the `.pr` file contains a no-op message (not a URL), calls `validateAndFixPrFile()` which attempts `gh pr create` — fails because zero commits. Agent is marked done with no `prUrl`.

3. **`verifyPhaseOutcome()`** (`runner.ts:154-178`): after `pollUntilDone()`, checks `getFirstPrUrl()` which requires a valid GitHub PR URL. When none exists, calls `handleVerifyFailure()` which redispatches up to 3 times then enters permanent hold.

4. **Execution order in main loop** (`runner.ts:1477-1509`): `checkZeroCommitsAutoBailOut()` at line 1494 runs BEFORE `verifyPhaseOutcome()` at lines 1497-1498. If bail-out succeeds, the loop breaks and verification never runs. The bug is that bail-out itself fails to detect the zero-commits condition.

5. **`isPairBailedOut()`** (`phases.ts:338-346`): existing protocol where coder sets status `bail-out` and reviewer confirms with `bail-out-confirmed`. Already recognized by `evaluateTransition()` for work/review/update-docs phases as a path to `done`.

### Key state fields

- `OrchestrationState.projectDir` — the main project directory (has correct remote refs)
- `AgentConfig.worktreePath` — the coder's worktree (may lack correct `origin/HEAD`)
- `AgentConfig.branch` — the coder's feature branch name

## Approach

### 1. Robust zero-commits detection

Replace `git rev-list --count origin/HEAD..HEAD` with a two-step check that avoids `origin/HEAD` entirely:

```typescript
function isWorktreeNoOp(coder: AgentConfig, projectDir: string): boolean {
  // Step 1: Check for uncommitted diffs (staged + unstaged, excluding orchestration paths)
  const statusResult = Bun.spawnSync(
    ["git", "status", "--porcelain", "--", ".", ...ORCHESTRATION_EXCLUDES],
    { cwd: coder.worktreePath },
  );
  if (statusResult.exitCode !== 0) return false;
  const hasDirtyFiles = String(statusResult.stdout).trim().length > 0;
  if (hasDirtyFiles) return false;

  // Step 2: Check commits ahead of base branch
  // Resolve the actual base branch from the project dir (not the worktree)
  // using the same logic as worktree creation: symbolic-ref origin/HEAD, fallback to "main"
  const baseBranch = resolveBaseBranch(projectDir);
  const revList = Bun.spawnSync(
    ["git", "rev-list", "--count", `origin/${baseBranch}..HEAD`],
    { cwd: coder.worktreePath },
  );
  if (revList.exitCode !== 0) return false;
  return parseInt(String(revList.stdout).trim(), 10) === 0;
}
```

Where `resolveBaseBranch` reuses the same logic as `defaultMainBranch()` in `worktrees.ts` (symbolic-ref of `origin/HEAD`, fallback to local branch, fallback to `"main"`), but runs against `projectDir` which has correct remote refs.

### 2. Trigger bail-out protocol instead of direct `done`

Instead of directly setting `state.phase = "done"`, `checkZeroCommitsAutoBailOut()` should:

1. Set the coder's `agentStates[coder.name].status = "bail-out"` and write the `.status` file.
2. **Dispatch the reviewer** for a confirmation turn (the reviewer reads the coder's bail-out status and writes `bail-out-confirmed` if appropriate).
3. Return a signal that causes the main loop to re-enter `pollUntilDone()` for the reviewer's confirmation turn.

However, this introduces complexity (a sub-dispatch within pr-create). A simpler approach that still satisfies AC2 ("reviewer agent approves"):

**Modified approach**: Detect the no-op condition at the **end of the `work` phase** (before reaching `pr-create`), where the bail-out protocol already works naturally:

- After `pollUntilDone()` returns for the `work` phase, before `evaluateTransition()`, check if the coder worktree is a no-op.
- If no-op detected, set coder status to `bail-out` and re-dispatch the reviewer for confirmation.
- The existing `isPairBailedOut()` check in `evaluateTransition()` for the `work` case handles the `done` transition.

**But** the issue also manifests when the coder reaches `pr-create` (the agent may write a no-op message in `.pr`). So we need **both**:

**A. Early detection (work phase exit)**: After agents finish the `work` phase and before transitioning to `review`, check if coder's worktree is a no-op. If yes, set coder status to `bail-out`. The normal review phase will then have the reviewer confirm.

**B. Late detection (pr-create phase, existing location)**: Keep `checkZeroCommitsAutoBailOut()` as a safety net, but:
   - Use the robust `isWorktreeNoOp()` detection instead of `origin/HEAD`.
   - Instead of jumping directly to `done`, set coder status to `bail-out` and trigger a brief reviewer confirmation dispatch within the pr-create phase. If the reviewer is not available or times out, fall through to `done` anyway (the safety-net must not itself become a stuck state).

### 3. Implementation plan

**File: `src/orchestration/runner.ts`**

1. Add `resolveBaseBranch(projectDir: string): string` — extract from `worktrees.ts:defaultMainBranch()` or import it (currently not exported). Prefer importing and exporting the existing function.

2. Add `isWorktreeNoOp(coder: AgentConfig, projectDir: string): boolean` — the robust check described above.

3. Modify `checkZeroCommitsAutoBailOut()`:
   - Replace `git rev-list --count origin/HEAD..HEAD` with `isWorktreeNoOp()`.
   - Instead of `state.phase = "done"`, set `coder.status = "bail-out"`, write the status file, and return a new signal indicating "needs reviewer confirmation".
   - If `isPairBailedOut(state)` is already true (reviewer previously confirmed), proceed to `done`.
   - If not, the main loop re-dispatches for the reviewer to confirm, then `evaluateTransition()` picks up `isPairBailedOut` on the next iteration.

4. Add early no-op check after the `work` phase completes (before `evaluateTransition`):
   - If phase is `work` and `isWorktreeNoOp()`, set coder status to `bail-out`.
   - The normal review dispatch will have the reviewer see the bail-out and confirm.

5. Add the `pr-create` case to `evaluateTransition()` in `phases.ts`: recognize `isPairBailedOut(state)` as a path to `done` from `pr-create`, just like it already exists for `work`/`review`/`update-docs`.

**File: `src/orchestration/phases.ts`**

6. In `evaluateTransition()`, case `"pr-create"`: add `if (isPairBailedOut(state)) return "done";` before the `hasAnyPr` check.

**File: `src/orchestration/worktrees.ts`**

7. Export `defaultMainBranch()` (currently unexported) so `runner.ts` can use it.

**File: `src/orchestration/runner.test.ts`**

8. Update the existing `checkZeroCommitsAutoBailOut` tests to verify the new detection logic and reviewer-confirmation behavior.

9. Add test: worktree where `origin/HEAD` is missing but `origin/main` exists — should still detect zero commits correctly.

10. Add test: worktree with uncommitted diffs but zero commits ahead — should NOT bail out.

11. Add test: `evaluateTransition` for `pr-create` with `isPairBailedOut` returns `"done"`.

### 4. Duo mode (hierarchical-duo with `duoPeerSlot`)

Each slot in a duo runs its own orchestration independently. If one slot's coder is a no-op:

- That slot follows the bail-out protocol (coder `bail-out` + reviewer `bail-out-confirmed` -> `done`).
- The peer slot proceeds normally with its PR.
- `bothSlotsReadyForMerge()` requires both slots to have PRs. If one slot is already `done` (bailed out), the coordinator slot should detect `peer.peerDone === true` and proceed to its own merge independently.

This already works correctly with the existing `readDuoPeerState` / `peerDone` mechanism in `evaluateTransition()` for `pr-comments`. No additional duo-specific changes needed beyond ensuring the no-op slot reaches `done`.
