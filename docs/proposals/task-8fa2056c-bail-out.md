# Proposal: Allow agent-duo to bail out of obsolete tasks without a PR

**Task:** task-8fa2056c
**Date:** 2026-04-13

## Goal

Add a graceful bail-out path for agent-duo when a task is obsolete (e.g., fix already on main). Both agents signal bail-out, the orchestrator skips PR/merge phases and marks the task done. Also surface `manual_intervention_required` in the dashboard via `has_questions`.

## Acceptance Criteria

1. Coder can write a `bail-out|<epoch>|<reason>` status. Reviewer can confirm with `bail-out-confirmed|<epoch>|<reason>`.
2. When both agents have bail-out status, `evaluateTransition` skips to `done` (bypassing pr-create, pr-comments, merge phases).
3. The `pr-create` phase detects 0 commits ahead of base branch and auto-triggers bail-out instead of looping through 3 verify attempts.
4. When `manual_intervention_required` fires, `has_questions: true` is set on the task and the reason is appended to the Questions section.
5. `bun run build` succeeds, all tests pass.

## Context

### Current failure mode

Slot 1 (task-9cfff815): coder found nothing to do, reviewer APPROVEd, orchestrator advanced to `pr-create`. No commits ahead → `gh pr create` fails → `validateAndFixPrFile` fires 3 times → `handleVerifyFailure` emits `manual_intervention_required` and holds permanently. No automated recovery.

### Key code paths

- `evaluateTransition` (phases.ts:427): switches on phase, checks `allAgentsDone` + `pairReviewVerdict`. Review case returns `"work"` on REQUEST_CHANGES, else `"update-docs"`.
- `DONE_STATUSES` (phases.ts:124-146): set of 19 recognized done statuses.
- `handleVerifyFailure` (runner.ts:146-159): after 3 attempts, emits `manual_intervention_required`, notifies agents, returns `"hold"`.
- `verifyPhaseOutcome` (runner.ts:95-119): for pr-create, checks `PR exists on GitHub` — no 0-commits-ahead detection.
- Status format: `printf '<STATUS>|<epoch>|<message>' > STATUS_FILE`.
- Dashboard `unansweredQuestionsConfig` (dashboard.ts:545): filters tasks where `has_questions === true && !isCompleted`.

## Approach

### 1. Bail-out status recognition (phases.ts)

Add `"bail-out"` and `"bail-out-confirmed"` to `DONE_STATUSES` so `isAgentDone` considers agents with these statuses as done.

Add helper:
```typescript
export function isBailOut(state: OrchestrationState): boolean {
  return state.agents.every(agent => {
    const status = state.agentStates[agent.name]?.status ?? "";
    return status.startsWith("bail-out");
  });
}
```

### 2. Bail-out transition (phases.ts — evaluateTransition)

In the `"review"` case, before checking `pairReviewVerdict`:
```typescript
if (isBailOut(state)) return "done";
```

In the `"work"` case, similarly:
```typescript
if (isBailOut(state)) return "done";
```

This skips update-docs, pr-create, pr-comments, and all merge phases.

### 3. 0-commits-ahead auto-bail-out (runner.ts — pr-create phase)

In `pollUntilDone`, when `state.phase === "pr-create"` and agents report done: before calling `verifyPhaseOutcome`, check if the worktree branch has 0 commits ahead of the base branch:

```typescript
const commitsAhead = safeSyncOutput(["git", "-C", worktreePath, "rev-list", "--count", `${baseBranch}..HEAD`]);
if (commitsAhead.ok && parseInt(commitsAhead.stdout.trim(), 10) === 0) {
  // No changes to PR — auto-bail-out
  orchLog(state, "info", "0 commits ahead of base — auto-completing as obsolete");
  state.phase = "done";
  // ... mark task done/abandoned
  return;
}
```

### 4. Surface manual_intervention_required in dashboard (runner.ts)

In `handleVerifyFailure` (runner.ts:146-159), after emitting the event, also set `has_questions` on the task:

```typescript
import { addFrontmatterField } from "../tasks/markdown.ts";

// After the notification:
const taskFile = resolveTaskFile(state.taskId);
if (taskFile) {
  addFrontmatterField(taskFile, "has_questions", "true");
  // Append reason to Questions section
  appendToTaskSection(taskFile, "Questions", `- **Manual intervention required**: ${reason}`);
}
```

This makes it appear in the dashboard's "Unanswered Questions" tile (dashboard.ts:545).

### 5. Template changes (skills/orchestration/)

**pair-coder-work.md**: Add bail-out instruction after the acceptance criteria check:
```
If the task is already resolved (fix already on main, 0 meaningful changes needed):
printf 'bail-out|%s|<reason>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

**pair-reviewer-review.md** (or equivalent): Add instruction to confirm bail-out if coder bailed:
```
If the coder wrote a bail-out status and you agree the task is obsolete:
printf 'bail-out-confirmed|%s|<reason>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

### Files to modify

- `src/orchestration/phases.ts` — `DONE_STATUSES`, `evaluateTransition`, new `isBailOut()` helper
- `src/orchestration/runner.ts` — `handleVerifyFailure` (surface has_questions), `pollUntilDone` (0-commits-ahead detection)
- `skills/orchestration/pair-coder-work.md` — bail-out instructions
- `skills/orchestration/pair-reviewer-review.md` — bail-out confirmation instructions
- `src/tasks/markdown.ts` — may need `appendToTaskSection()` helper (or use existing)
