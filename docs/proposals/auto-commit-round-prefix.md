# Auto-commit message format: round-number prefix

## Goal

Change auto-commit messages from `<agent> <phase>: <message>` to `[round N] <message>` so that commit history reflects the orchestration round rather than internal agent/phase details. This makes the git log more useful when reviewing slot work output.

## Acceptance Criteria

- Auto-commit messages use the format `[round N] <message>` where N is `state.round`
- Message source priority: `runtime.statusMessage` (trimmed, collapsed to single line) -> `state.slotTitle` (task title) -> `"WIP"`
- No-op behavior on clean worktrees is preserved
- Push behavior is unchanged
- Existing tests are updated to assert the new format
- Event log messages reflect the new commit message format (no separate change needed -- they already embed `commitMessage`)

## Context

The `autoCommitAgent` function at `src/orchestration/runner.ts:874` currently builds commit messages as:
```typescript
const statusMsg = runtime.statusMessage?.replace(/\s+/g, " ").trim() || "WIP";
const commitMessage = `${agent.name} ${state.phase}: ${statusMsg}`;
```

This is the only place that constructs the commit message string. `autoCommitAllAgents` (line 931) delegates to `autoCommitAgent`. `autoCommitWorktree` in `src/orchestration/worktrees.ts:247` receives the message as a parameter and does not format it.

Key state fields:
- `state.round` (number, defaults to 1 at initialization)
- `state.slotTitle` (optional string, set from task title during slot setup)
- `runtime.statusMessage` (string from agent's done status)

Call sites that trigger auto-commits (no changes needed to these):
- Post-`pollUntilDone` at ~line 1110: `autoCommitAllAgents(state, participating, push=false)`
- Pre-PR-phases at ~line 1141: `autoCommitAllAgents(state, state.agents, push=true)`

Tests at `src/orchestration/runner.test.ts:1664-1821` cover message format, WIP fallback, multiline collapsing, clean worktree no-op, pair-mode dedup, and duo-mode independence.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. In `autoCommitAgent`, change the message construction to:
   ```typescript
   const statusMsg = runtime.statusMessage?.replace(/\s+/g, " ").trim()
     || state.slotTitle?.trim()
     || "WIP";
   const commitMessage = `[round ${state.round}] ${statusMsg}`;
   ```

2. Update all test assertions in the `autoCommitAgent` and `autoCommitAllAgents` describe blocks to expect the new format (e.g., `"[round 1] implemented tensor syntax"` instead of `"coder work: implemented tensor syntax"`).

## Scope

**In scope:**
- `autoCommitAgent` message format change (runner.ts)
- Test updates (runner.test.ts)

**Out of scope:**
- Adding new auto-commit trigger points (existing coverage is sufficient)
- Changes to `autoCommitWorktree` or `autoCommitAllAgents` logic
- Changes to push behavior or git operations
