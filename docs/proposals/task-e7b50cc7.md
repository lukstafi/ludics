# Delay Codex Review Request and Remove Thumbs-Up Shortcut

## Goal

Repositories auto-trigger Codex review on PR creation (GitHub setting), but this sometimes fails silently. The orchestrator currently posts an explicit `@codex review` comment immediately on entering `pr-comments`, which duplicates the auto-triggered review when it succeeds. Additionally, the thumbs-up approval reaction shortcut bypassed the quiet period, creating a second advancement mechanism that complicated the flow.

This change: (1) defers the explicit review request to act as a fallback rather than a duplicate, and (2) removes the thumbs-up shortcut so the quiet period is the sole advancement mechanism.

## Acceptance Criteria

- `maybePostCodexReviewRequests()` defers posting for `min(10 minutes, quiet_period / 2)` from phase entry instead of posting immediately
- During the deferral window, the runner checks whether a submitted review from `chatgpt-codex-connector[bot]` already exists via the GitHub API
- If a submitted review is found: skip the explicit `@codex review` request (auto-trigger succeeded)
- If no submitted review after the timeout: post `@codex review` as fallback (auto-trigger failed)
- Reactions alone (eyes, thumbs-up) do NOT suppress the explicit request -- only a submitted review does
- No second-pass review -- one review per `pr-comments` entry is sufficient
- Remove the thumbs-up approval reaction function and all call sites -- thumbs-up no longer triggers immediate transition
- Remove the `prCodexApproved` state field from `OrchestrationState` and all logic that reads/writes it (in `checkAndRedispatchPrComments`, `evaluateTransition`, and transition resets)
- The quiet period (`prCommentsTimeout`) becomes the sole mechanism for advancing out of `pr-comments` (besides phase timeout and external merge detection)

## Context

### Current flow

1. **`maybePostCodexReviewRequests()`** (`src/orchestration/runner.ts`, line ~1019): Called synchronously during `performTransition()` when transitioning into `pr-comments` from initial entry paths (`pr-create`, `update-docs`, `review`). Posts `@codex review` immediately on every unique PR URL.

2. **`checkAndRedispatchPrComments()`** (`src/orchestration/runner.ts`, line ~536): Polled each tick during `pr-comments`. After all agents settle, it:
   - Checks for external PR merge (lines ~551-617)
   - (Removed) Checked thumbs-up approval reaction and set `state.prCodexApproved = true` (lines ~628-643)
   - Counts new comments and manages quiet period tracking (lines ~646+)

3. **(Removed)** The thumbs-up approval reaction helper queried `repos/{repo}/issues/{pr}/reactions` for a `+1` reaction from a user matching `/codex/i`.

4. **`prCodexApproved` state field** (`src/orchestration/state.ts`, line 139): Boolean flag. When set, `evaluateTransition()` in `phases.ts` (lines ~419, ~444) bypasses the quiet period and immediately transitions to `forward-pr` (staging) or `final-merge` (non-staging).

5. **`prCodexApproved` reset** (`src/orchestration/runner.ts`, line ~1004): Reset to `false` when re-entering `pr-comments` after `forward-pr`, preventing staging approval from auto-transitioning upstream monitoring.

6. **Tests** (`src/orchestration/phases.test.ts`): Three tests reference `prCodexApproved` -- these must be removed or rewritten.

### Key files

- `src/orchestration/runner.ts` -- `maybePostCodexReviewRequests()`, `checkAndRedispatchPrComments()`, `performTransition()`
- `src/orchestration/github.ts` -- `postCodexReviewComment()`
- `src/orchestration/state.ts` -- `OrchestrationState` interface (`prCodexApproved` field)
- `src/orchestration/phases.ts` -- `evaluateTransition()` (`prCodexApproved` checks in `pr-comments` case)
- `src/orchestration/phases.test.ts` -- tests for `prCodexApproved` transitions

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. **New GitHub helper**: Add `hasCodexSubmittedReview(prUrl): boolean` to `github.ts`. Query `repos/{owner}/{repo}/pulls/{pr}/reviews` and check for a review with `state === "submitted"` (or any non-pending state) from a user matching `/codex/i`.

2. **Defer review request**: Convert `maybePostCodexReviewRequests()` from a synchronous fire-on-transition function to a deferred check. Options:
   - Add a state field (e.g., `codexReviewDeferred?: number` -- epoch of phase entry) and check it in `checkAndRedispatchPrComments()` on each poll cycle.
   - On each poll: if deferred and `now - codexReviewDeferred < min(600, prCommentsTimeout / 2)`, call `hasCodexSubmittedReview()`. If review found, clear the deferred flag (skip). If timeout reached without review, post the comment and clear the flag.

3. **Remove thumbs-up approval reaction helper**: Delete the function from `github.ts`, remove the import and call site in `runner.ts`.

4. **Remove `prCodexApproved`**: Delete the field from `OrchestrationState` in `state.ts`. Remove all reads/writes in `runner.ts` (`checkAndRedispatchPrComments`, `performTransition` reset) and `phases.ts` (`evaluateTransition` pr-comments case). Update or remove affected tests in `phases.test.ts`.

## Scope

**In scope:**
- Deferral logic for `@codex review` posting
- New `hasCodexSubmittedReview()` GitHub API helper
- Removal of thumbs-up approval reaction function
- Removal of `prCodexApproved` state field and all related logic
- Test updates for removed/changed behavior

**Out of scope:**
- Changes to the quiet period duration or mechanism itself
- Changes to how `fetchNewPrCommentCount` works
- Changes to staging/upstream forwarding flow (beyond removing `prCodexApproved` checks)
- Second-pass Codex review requests

**Dependencies:** None.
