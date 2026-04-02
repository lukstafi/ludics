# Proposal: Fix stale status detection on resume via mtime-based completion signal

**Task:** gh-ludics-122
**Project:** ludics

## Goal

After a crash/reboot, `slotResume()` nulls out `turnLifecycle` for all agents. The `isAgentDone()` null-lifecycle branch (line 210) trusts peer-sync status alone without checking artifacts, so a pre-crash `review-done` status is treated as a fresh completion. When `pairReviewVerdict()` returns `null` (review file missing/not flushed), `evaluateTransition()` falls through the `request_changes` check and advances to `update-docs` — silently skipping a REQUEST_CHANGES verdict. The same pattern affects `plan-review`.

This proposal adds an mtime-based freshness gate to `isAgentDone()` so that stale status files from before a crash are never mistaken for fresh completions.

## Acceptance Criteria

1. After a resume, an agent whose `.status` file was written before the crash is NOT considered done — the orchestrator waits for the agent to produce fresh output.
2. An agent that writes its `.status` file after dispatch IS considered done (normal path unchanged).
3. A reviewer verdict of REQUEST_CHANGES in the review file correctly causes `review` to transition to `work` (not `update-docs`), even after a resume.
4. A reviewer verdict of REQUEST_CHANGES in a plan-review file correctly causes `plan-review` to transition to `plan-merge` (not `work`), even after a resume.
5. Phase timeout still overrides: if the phase timeout expires, the orchestrator advances regardless of stale status.
6. No change to `.status` file format — files remain human-readable (`review-done|<epoch>|<message>`).
7. The fix applies uniformly to all agent roles (coder and reviewer).

## Context

### Bug mechanism (two parts)

**Part 1 — `isAgentDone()` bypass on resume** (`src/orchestration/phases.ts:201-210`):
`slotResume()` (`src/slots/index.ts:884-888`) sets `turnLifecycle = null`. The null-lifecycle branch returns `DONE_STATUSES.has(runtime.status)` — it trusts peer-sync status without calling `hasRequiredArtifact()`. A stale `review-done` status from before the crash passes.

**Part 2 — `evaluateTransition()` treats null verdict as APPROVE** (`src/orchestration/phases.ts:386-393`):
When `allAgentsDone()` is true but the review file is missing, `pairReviewVerdict()` returns `null`. The null falls through the `request_changes` check and proceeds to `update-docs`. The identical pattern exists in `plan-review` (lines 369-380).

### Existing staleness mechanism

The codebase already has `statusFileFingerprint()` (`src/orchestration/peer-sync.ts:172-182`) which combines file content with mtime. It is recorded at dispatch time and compared in the `settled` lifecycle branch. However, the null-lifecycle branch (resume path) bypasses this entirely.

### User-validated design direction

- Keep `.status` files with their current content format for readability/debugging
- Use mtime semantics (already partially present via `statusFileFingerprint`) as the primary freshness gate
- Add content validation as a secondary check
- Fix applies to both coder and reviewer uniformly

## Approach

### 1. Record dispatch mtime by touching `.status` files at dispatch

In `runner.ts`, when dispatching a turn (both initial dispatch ~line 470 and re-dispatch ~line 514), touch the agent's `.status` file to reset its mtime to now. This establishes a baseline timestamp for this dispatch cycle.

For the resume path: `slotResume()` already sets `phaseDispatched = false`, which triggers re-dispatch in the runner loop. The re-dispatch touch resets mtime, making any pre-crash content stale.

### 2. Add mtime freshness gate to `isAgentDone()` null-lifecycle branch

In `src/orchestration/phases.ts`, modify the null-lifecycle branch (line 210) to check `.status` file mtime against `state.phaseStartedAt`:

- Read `.status` file mtime
- If `mtime < phaseStartedAt` (file was written before this phase started), return `false` — stale
- If mtime is fresh AND status is a done status, additionally call `hasRequiredArtifact()` before returning `true`

This means the null-lifecycle path gets the same artifact validation as the `settled` path.

### 3. No changes to `evaluateTransition()` or `pairReviewVerdict()`

The transition logic and verdict parsing are correct — they just receive wrong input when `isAgentDone()` returns a false positive. Fixing the gate in `isAgentDone()` resolves both the `review` and `plan-review` cases without touching transition code.

### 4. Test plan

1. **Stale status file**: Create `.status` file with mtime before `phaseStartedAt`. Assert `isAgentDone()` returns `false` when `turnLifecycle` is null.
2. **Fresh status file**: Write `.status` file after `phaseStartedAt`. Assert `isAgentDone()` returns `true` (with valid done status and artifact present).
3. **Resume scenario**: Simulate resume (null lifecycle, `phaseDispatched = false`), verify re-dispatch touches `.status` file, old mtime is overwritten, agent must write again to appear done.
4. **Artifact gate on null lifecycle**: Fresh `.status` with done status but missing review artifact file — assert `isAgentDone()` returns `false`.
5. **Regression**: Review file with `REQUEST_CHANGES` + fresh status + artifact present — assert `review` transitions to `work`.
6. **Timeout override**: Stale `.status` file + `phaseTimeoutExpired` returns true — assert `evaluateTransition()` still advances (timeout is checked independently of `allAgentsDone`).
