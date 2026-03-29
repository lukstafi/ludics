# Proposal: Auto-commit uncommitted changes at end of each agent turn

**Task:** task-7b4b491a
**Status:** in-progress
**Priority:** A

## Summary

Add an auto-commit mechanism to the orchestration runner that captures any uncommitted changes in agent worktrees after each turn completes and before phase transitions that require committed code (pr-create, forward-pr, final-merge, merge-execute). This prevents silent PR creation failures when agents forget to commit and creates an audit trail of per-turn progress.

## Motivation

When an agent finishes a turn without committing (forgets, gets interrupted, stop hook doesn't fire), subsequent phases like pr-create fail silently because there are no commits to push. This was observed in practice (slot 5 incident). The agent-duo predecessor system solved this with `lib_commit_round()` which ran obligatorily at turn completion.

## Key Code Touchpoints

### 1. New helper: `autoCommitWorktree()` in `src/orchestration/worktrees.ts`

**Why here:** worktrees.ts already contains `runGit()` (line 12) and `maybeGit()` (line 25) -- the low-level git execution helpers that accept any directory as `cwd`. The new function is a pure git operation (status check, add, commit) with no orchestration state dependencies.

```typescript
export function autoCommitWorktree(
  worktreePath: string,
  commitMessage: string,
): { committed: boolean; error?: string } {
  const status = maybeGit(worktreePath, ["status", "--porcelain"]);
  if (!status) return { committed: false }; // clean tree
  try {
    runGit(worktreePath, ["add", "-A"]);
    runGit(worktreePath, ["commit", "-m", commitMessage]);
    return { committed: true };
  } catch (err) {
    return { committed: false, error: String(err) };
  }
}
```

`runGit` and `maybeGit` are currently module-private (`function`, not `export function`). They do NOT need to be exported -- `autoCommitWorktree` lives in the same module and can call them directly.

### 2. Orchestrator-level `autoCommitAgent()` in `src/orchestration/runner.ts`

**Why here:** runner.ts owns the orchestration state, agent configs, and event emission. This function bridges the stateless git helper with the stateful orchestration layer.

```typescript
function autoCommitAgent(
  state: OrchestrationState,
  agent: AgentConfig,
  push: boolean = false,
): void {
  const runtime = state.agentStates[agent.name];
  if (!runtime) return;

  const statusMsg = runtime.statusMessage || "WIP";
  const commitMessage = `${agent.name} ${state.phase}: ${statusMsg}`;

  const result = autoCommitWorktree(agent.worktreePath, commitMessage);

  if (result.committed) {
    emitEvent({
      event_type: "auto_commit",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.feature,
      message: `auto-committed in ${agent.worktreePath}: ${commitMessage}`,
    });
  }
  if (result.error) {
    emitEvent({
      event_type: "orchestration_warning",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.feature,
      message: `auto-commit failed in ${agent.worktreePath}: ${result.error}`,
    });
  }

  if (result.committed && push) {
    try {
      runGit(agent.worktreePath, ["push"]);
    } catch { /* best-effort push */ }
  }
}
```

Note: `runGit` is in `worktrees.ts` (module-private). Either (a) export it from worktrees.ts, or (b) include the push logic inside `autoCommitWorktree` by adding an optional `push` parameter, or (c) add a small `pushWorktree()` export. Option (a) is simplest -- export `runGit` (it's already a clean utility function).

### 3. Call site: `pollUntilDone()` after `allAgentsDone()` (line 664)

When `allAgentsDone(state)` returns true, auto-commit each participating agent's worktree before returning. This is the turn-completion hook.

```typescript
if (allAgentsDone(state)) {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    autoCommitAgent(state, agent, /* push */ false);
  }
  return;
}
```

Also after `handleTimeout()` (line 667-669) -- interrupted agents may have partial work:

```typescript
if (nowEpoch() >= deadline) {
  await handleTimeout(state);
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    autoCommitAgent(state, agent, /* push */ false);
  }
  return;
}
```

### 4. Call site: `runOrchestration()` before phase transitions (line 802)

Before `applyPhaseSideEffects(state, next)`, auto-commit with push for phases that need committed code on the branch:

```typescript
const pushPhases = new Set(["pr-create", "forward-pr", "final-merge", "merge-execute"]);
if (pushPhases.has(next)) {
  for (const agent of state.agents) {
    if (!agentParticipatesInPhase(state, agent)) continue;
    autoCommitAgent(state, agent, /* push */ true);
  }
}

applyPhaseSideEffects(state, next);
```

This goes at approximately line 801, just before the existing `applyPhaseSideEffects(state, next)` call.

### 5. Pair mode deduplication

In pair mode, both agents share the same worktree (`rootWorktree`). The `autoCommitWorktree()` function is naturally idempotent: the first call commits, the second finds a clean tree and returns `{ committed: false }`. No explicit deduplication logic needed. The commit message will use whichever agent's status message is processed first.

## Files Modified

| File | Change |
|------|--------|
| `src/orchestration/worktrees.ts` | Add `autoCommitWorktree()` export; export `runGit` for push support |
| `src/orchestration/runner.ts` | Add `autoCommitAgent()`; call after turn completion and before push-phases |

## Edge Cases

1. **Clean worktree**: `git status --porcelain` returns empty -- no-op, no event emitted.
2. **Agent already committed**: Same as clean worktree -- idempotent.
3. **Pair mode shared worktree**: Second agent's auto-commit finds clean tree after first agent's commit. No duplicate commits.
4. **Timeout/interrupt**: Auto-commit still runs after `handleTimeout()`, capturing partial work.
5. **Push failures**: Best-effort; warning logged but phase transition not blocked.
6. **Merge conflicts in staging**: Not expected in agent worktrees (each has its own branch). If `git add -A && git commit` somehow fails, the error is captured in the return value and logged.

## Testing

- **Unit test** `autoCommitWorktree()` with a temp git repo: verify commit is created when dirty, no-op when clean, error returned on invalid repo.
- **Integration test** in runner: verify auto-commit fires between phases. Can mock `autoCommitWorktree` to assert call arguments.
- **Manual test**: run a slot where the agent deliberately does not commit; verify auto-commit captures changes and PR creation succeeds.

## Design Decisions

1. **Auto-commit at poll-loop exit, not inside `refreshAgentStatuses()`**: Keeps the status refresh pure (read-only). Side effects happen at clearly defined boundaries.
2. **`git add -A`**: Matches the agent-duo pattern. Agents work in isolated worktrees, so there is no risk of staging unrelated files.
3. **Commit message format `"<agent> <phase>: <status message>"`)**: Provides attribution and context. The status message comes from peer-sync (already available in `runtime.statusMessage`).
4. **Push only before push-phases**: Avoids unnecessary pushes on every turn (would be noisy). Push happens exactly when the code needs to be on the remote.
5. **No new state fields**: The feature is stateless -- each auto-commit is a one-shot idempotent operation. No new fields in `OrchestrationState` or `AgentTurnLifecycle`.
