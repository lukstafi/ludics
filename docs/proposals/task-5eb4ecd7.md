# Proposal: Verify PR exists after pr-create and merge succeeded after final-merge before advancing

**Task**: task-5eb4ecd7
**Effort**: Medium
**Status**: Ready to implement

---

## Goal

The orchestrator currently trusts agent-reported done statuses without verifying actual outcomes
via the GitHub API. Two gaps have been observed in production:

1. **pr-create -> pr-comments**: The coder reports `pr-create-done` but the PR was never actually
   created (push failed, `gh pr create` failed, etc.). The `hasRequiredArtifact` check validates
   the `.pr` file contains a URL, but it cannot verify the URL points to a real, open PR on GitHub.
   The orchestrator advances to pr-comments, which spins watching a nonexistent PR.

2. **final-merge -> suggest-refactor**: The coder reports `final-merge-done` but the PR has merge
   conflicts and was never actually merged. The orchestrator advances to suggest-refactor and then
   done, marking the task complete with an unmerged PR.

Both gaps were handled correctly in the agent-duo predecessor via `gh pr view --json state` checks.

---

## Acceptance Criteria

1. After `pr-create` completes and before advancing to `pr-comments`, the orchestrator verifies
   the PR URL from `coder.pr` refers to an actual open PR via the GitHub API (`gh pr view`).
   - If verification fails, the phase loops back to `pr-create` with error context for the coder.
   - After N failed attempts (e.g., 3), flag for manual intervention instead of looping forever.
   - Only advance to `pr-comments` when a valid, existing PR is confirmed.

2. After `final-merge` completes and before advancing to `suggest-refactor`, the orchestrator
   verifies the PR is actually merged via `isPrMerged()` (already exists in `github.ts`).
   - If merge verification fails, loop back to `final-merge` with conflict/error context.
   - After N failed attempts (e.g., 3), flag for manual intervention.
   - Only advance to `suggest-refactor` when PR state = merged.

3. Verification outcomes are logged as events (`pr_verified`, `pr_missing`, `merge_verified`,
   `merge_failed`).

---

## Context

### Current flow (phases.ts)

**pr-create transition** (line 424-426):
```typescript
case "pr-create":
  if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "pr-comments";
  return null;
```
Advances purely on agent-done status. The `hasRequiredArtifact` gate in `isAgentDone` checks
that `coder.pr` exists and contains a PR-shaped URL, but does not verify the URL is real.

**final-merge transition** (line 507-509):
```typescript
case "final-merge":
  if (allAgentsDone(state) || phaseTimeoutExpired(state)) return "suggest-refactor";
  return null;
```
Advances purely on agent-done status with no merge verification.

### Existing utilities (github.ts)

- `isPrUrl(value)` — regex check for GitHub PR URL shape (already used by `hasRequiredArtifact`)
- `isPrMerged(prUrl)` — calls `gh api repos/.../pulls/N --jq .merged`, returns boolean
- No existing "does this PR exist / is it open" function

### Main loop (runner.ts, line 830+)

The orchestration loop calls `evaluateTransition(state)` after `pollUntilDone()`. The returned
phase goes through `maybeOverrideTransition()` then `applyPhaseSideEffects()` before the
transition executes. Verification gates can be added either in `evaluateTransition` (phases.ts)
or as side-effect checks in the runner loop.

### State (state.ts)

No existing retry counter fields for pr-create or final-merge. The `planMergeRound` / `mergeRound`
fields serve similar purposes for plan and merge iteration tracking.

---

## Approach (tentative)

### 1. Add a `isPrOpen(prUrl)` utility to `github.ts`

New function that calls `gh api repos/.../pulls/N --jq .state` and returns true if state is "open".
This confirms the PR actually exists and is accessible.

### 2. Add verification gates in `evaluateTransition` (phases.ts)

**pr-create gate**: When `allAgentsDone(state)`, read the PR URL from the `.pr` artifact file and
call `isPrOpen()`. If the PR doesn't exist, return `null` (stay in pr-create) and emit a
`pr_missing` event. The runner's timeout mechanism already handles indefinite loops. A retry
counter on state (`prCreateRetries`) caps attempts at 3 before flagging manual intervention
(emit event + return null permanently, letting the phase timeout handle it).

**final-merge gate**: When `allAgentsDone(state)`, call `isPrMerged()` on the PR URL. If not
merged, return `null` (stay in final-merge) and emit a `merge_failed` event. A retry counter
(`finalMergeRetries`) caps attempts similarly.

### 3. Add retry state fields to `OrchestrationState`

Add `prCreateVerifyRetries?: number` and `finalMergeVerifyRetries?: number` to the state type.
Reset these when entering the respective phases.

### 4. Re-dispatch on verification failure

When verification fails and retries remain, reset the agent's done status (clear `turnLifecycle`
state back to allow re-dispatch) so `enterPhase` will re-dispatch with error context. The
dispatch message should include the failure reason (e.g., "PR creation failed — please commit
your changes and create a PR" or "Merge failed due to conflicts — please resolve and merge").

### 5. Manual intervention flagging

After max retries, emit a `manual_intervention_required` event and let the phase timeout
naturally. The event will surface in notifications for the human operator.

---

## Scope

### In scope
- Verification gate for pr-create -> pr-comments (confirm PR exists via GitHub API)
- Verification gate for final-merge -> suggest-refactor (confirm PR merged via GitHub API)
- New `isPrOpen()` utility in `github.ts`
- Retry counters and re-dispatch logic for both gates
- Event logging for verification outcomes
- Manual intervention flagging after max retries

### Out of scope
- Fixing the root causes of PR creation failure (addressed by auto-commit task-7b4b491a)
- Conflict resolution automation (coder is expected to resolve conflicts when re-dispatched)
- Verification gates for other phase transitions (e.g., forward-pr)
- Changes to the pr-comments quiet-period / Codex approval logic
- Upstream merge verification (already handled by `hasUpstreamMergedMarker`)
