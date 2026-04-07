# Proposal: Add markAgentDone test helper to reduce verification-gate test boilerplate

**Task:** task-e6d08f88
**Project:** ludics

## Goal

Add a `markAgentDone(state, agentName, opts?)` helper function in `runner.test.ts` (near the existing `makeState`/`makeLifecycle` helpers) that satisfies all three layers required for `isAgentDone()` to return true: status, turn lifecycle, and phase artifact. Use it to refactor the `isAgentDone` suite (~L992) and artifact-validation suite (~L1044) to eliminate the 5-8 lines of per-agent boilerplate currently repeated across ~30 test cases.

## Acceptance Criteria

1. `markAgentDone(state, agentName)` sets the agent's `status`, `turnLifecycle`, and creates the required artifact file (if any) for the current `state.phase` so that `isAgentDone(state, agent)` returns `true` for that agent.
2. The helper accepts an `opts` object with at least: `status` (override status string), `artifactContent` (override artifact file body), `skipArtifact` (omit artifact for negative test setup), `skipLifecycle` (leave `turnLifecycle` null for legacy-path tests).
3. Default lifecycle is a settled lifecycle equivalent to the inline `makeLifecycle({ state: "settled", observedTurnId: "turn-auto", turnCompletedAt: new Date().toISOString(), completionSource: "snapshot" })` pattern.
4. Default status per phase: `plan` → `"plan-done"`, `plan-merge` → `"plan-merge-done"`, `plan-review` → `"plan-review-done"`, `review` → `"review-done"`, `pr-create` → `"pr-create-done"`, all other phases → `"done"`.
5. Default artifact content per phase: `plan`/`plan-merge`/`plan-review` artifacts → `"# Plan\n"` or `"APPROVE\n"` as appropriate; `review` → `"APPROVE\n"`; `pr-create` → `"https://github.com/org/repo/pull/1\n"`.
6. The `isAgentDone` lifecycle suite (~L992–1073) is refactored to use `markAgentDone` wherever the helper covers the setup, removing inline lifecycle+status boilerplate. Tests that deliberately test non-settled states (dispatched, running, error, interrupted) keep their explicit setup.
7. The artifact-validation suite (~L1079–1228) is refactored: positive tests (artifact present → done) use `markAgentDone`; negative tests (missing artifact → not done) use `markAgentDone(state, name, { skipArtifact: true })`.
8. All existing tests continue to pass with no semantic changes.

## Context

### Observed boilerplate pattern

The current pattern for a single "done" agent in `runner.test.ts` is:

```typescript
state.agentStates.coder.turnLifecycle = makeLifecycle({
  state: "settled",
  observedTurnId: "turn-plan",
  turnCompletedAt: new Date().toISOString(),
  completionSource: "snapshot",
});
state.agentStates.coder.status = "plan-done";
writeFileSync(join(tmpDir, "plans", "round-1-coder.md"), "# Plan\n");
```

This pattern is repeated for every positive test case, with minor variations in phase name, agent name, artifact path, and content. With ~30 test cases, this totals roughly 150–200 lines of structural repetition.

### Phase-to-artifact mapping (from `requiredArtifactPath` in `phases.ts`)

- `plan`: `plans/round-{round}-{agent}.md`
- `plan-merge`: `plans/round-{round}-merged-{planMergeRound}.md` (coder only)
- `plan-review`: `reviews/plan-merge-{planMergeRound}-{agent}.md`
- `review`: `reviews/round-{round}-{agent}.md`
- `pr-create`: `{agent}.pr` (must contain a valid GitHub PR URL)
- All other phases: no artifact required

### Source files in scope

- `src/orchestration/runner.test.ts` — target for helper addition and refactoring
- `src/orchestration/phases.test.ts` — `evaluateTransition` tests; simpler (no lifecycle), status-only; optional light refactoring with a `markDone(state, agentName)` variant that only sets status
- `src/orchestration/phases.ts` — `isAgentDone()`, `DONE_STATUSES`, `requiredArtifactPath()`, `hasRequiredArtifact()` (read-only reference)
- `src/orchestration/state.ts` — `AgentTurnLifecycle`, `initAgentRuntimeState()` (read-only reference)

## Approach

### Helper placement and signature

Add to `runner.test.ts` in the helpers section immediately after the existing `makeLifecycle` and `makeState` helpers (~L44). Keep it file-local (not exported) since `phases.test.ts` has a different `makeState` and simpler needs.

```typescript
function markAgentDone(
  state: OrchestrationState,
  agentName: string,
  opts: {
    status?: string;
    artifactContent?: string;
    skipArtifact?: boolean;
    skipLifecycle?: boolean;
  } = {},
): void {
  // 1. Determine default done status for this phase
  const defaultStatus: Record<string, string> = {
    plan: "plan-done",
    "plan-merge": "plan-merge-done",
    "plan-review": "plan-review-done",
    review: "review-done",
    "pr-create": "pr-create-done",
  };
  state.agentStates[agentName].status = opts.status ?? defaultStatus[state.phase] ?? "done";

  // 2. Set settled lifecycle (unless skipLifecycle)
  if (!opts.skipLifecycle) {
    state.agentStates[agentName].turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-auto",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
  }

  // 3. Write required artifact file (unless skipArtifact)
  if (!opts.skipArtifact) {
    const dir = state.peerSyncDir;
    const round = state.round;
    const pmr = state.planMergeRound ?? 0;
    let artifactPath: string | null = null;
    let defaultContent = "# Artifact\n";

    switch (state.phase) {
      case "plan":
        artifactPath = join(dir, "plans", `round-${round}-${agentName}.md`);
        defaultContent = "# Plan\n";
        break;
      case "plan-merge":
        artifactPath = join(dir, "plans", `round-${round}-merged-${pmr}.md`);
        defaultContent = "# Merged Plan\n";
        break;
      case "plan-review":
        artifactPath = join(dir, "reviews", `plan-merge-${pmr}-${agentName}.md`);
        defaultContent = "APPROVE\n";
        break;
      case "review":
        artifactPath = join(dir, "reviews", `round-${round}-${agentName}.md`);
        defaultContent = "APPROVE\n";
        break;
      case "pr-create":
        artifactPath = join(dir, `${agentName}.pr`);
        defaultContent = "https://github.com/org/repo/pull/1\n";
        break;
    }

    if (artifactPath) {
      writeFileSync(artifactPath, opts.artifactContent ?? defaultContent);
    }
  }
}
```

### Refactoring approach

The refactor is mechanical: for each positive test (artifact present → done) replace inline boilerplate with `markAgentDone(state, "coder")` or `markAgentDone(state, "reviewer")`. For negative tests (missing artifact → not done), use `markAgentDone(state, "coder", { skipArtifact: true })`. For lifecycle-state tests (dispatched, running), keep explicit `makeLifecycle` calls.

For `phases.test.ts`, the existing status-only boilerplate (`state.agentStates.coder.status = "done"`) is already brief (1 line per agent) and does not include lifecycle or artifacts. It does not warrant a helper; leave it unchanged.
