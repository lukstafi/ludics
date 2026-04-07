# Final-Merge Shortcut After Coder Addresses PR Review

## Goal

After the coder addresses PR review comments (responds and/or pushes fixes), transition directly
to `final-merge` without waiting for the full 1200s quiet period. Currently the quiet period is
the sole advancement mechanism (besides phase timeout and external merge detection), so even after
the reviewer approves and the coder responds, the orchestrator idles for up to 20 minutes.

This change adds a lenient shortcut: once the coder has been dispatched in `pr-comments` phase
and has completed its response turn (status `pr-comments-done`), advance immediately to
`final-merge` if all agents are done. The 1200s quiet period remains as a fallback.

Additionally, clean up stale doc references to `hasPrApprovalReaction` that were left behind by
task-e7b50cc7 when that symbol was removed.

## Acceptance Criteria

- After the coder is re-dispatched in `pr-comments` (via `redispatchForPrComments`) and all
  agents reach done status (`pr-comments-done`), `evaluateTransition()` returns `"final-merge"`
  immediately — without waiting for `prCommentsQuietSince` to satisfy the 1200s quiet period.
- The shortcut only fires when the coder has been dispatched **at least once** in the
  `pr-comments` phase (i.e., there were actual PR comments to address — not just a no-comment
  entry).
- The shortcut is suppressed for staging PRs that have not yet been forwarded (those still need
  the quiet period to gate `forward-pr`), and for hierarchical-duo slots (existing cross-slot
  logic is unaffected).
- The existing quiet-period path (`prCommentsQuietSince >= prCommentsTimeout`) remains as a
  fallback and continues to work as before.
- The hard phase timeout path (`phaseTimeoutExpired`) remains unchanged.
- A new state field (`prCommentsCoderDispatched?: boolean`) is added to `OrchestrationState`
  and set to `true` inside `redispatchForPrComments()` when the coder agent is dispatched.
  It is reset to `false`/`undefined` on fresh `pr-comments` phase entry
  (`applyPhaseSideEffects` / phase entry block in `dispatchPhase`).
- Tests in `phases.test.ts` cover: (a) shortcut fires when
  `prCommentsCoderDispatched=true` and all agents done; (b) shortcut is suppressed when
  `prCommentsCoderDispatched` is unset (no dispatch yet); (c) shortcut is suppressed for
  staging non-forwarded PRs; (d) quiet-period path still works when shortcut condition is unmet.
- Stale references to `hasPrApprovalReaction` are removed from:
  - `docs/staging-repo-proposal.md` (line 130)
  - `docs/proposals/task-e7b50cc7.md` (multiple lines)
  - `docs/proposals/task-bc2c634f.md` (lines 15, 30)

## Context

### Relevant code

**`evaluateTransition()` — `pr-comments` case** (`src/orchestration/phases.ts`, lines 484–534):

The non-staging, non-duo path (lines 524–534) currently reads:

```ts
// Non-staging: quiet period is the sole advancement mechanism
const quietPeriod = state.config.prCommentsTimeout;
if (
  hasAnyPr(state)
  && state.prCommentsQuietSince
  && nowEpoch() - state.prCommentsQuietSince >= quietPeriod
) {
  return "final-merge";
}
if (phaseTimeoutExpired(state) && hasAnyPr(state)) return "final-merge";
return null;
```

The shortcut is added here, gated on a new `prCommentsCoderDispatched` flag and
`allAgentsDone(state)`.

**`redispatchForPrComments()`** (`src/orchestration/runner.ts`, lines 555–591):

Called by `checkAndRedispatchPrComments()` when `totalNewComments > 0` (line 812). It
re-dispatches all participating agents and resets their `turnLifecycle`. The coder agent is
identified by `agent.role === "coder"`. The new flag should be set here, after the coder's
`sendTurn` call succeeds.

**Phase entry reset** (`src/orchestration/runner.ts`, lines 463–469 / `applyPhaseSideEffects`):

On fresh `pr-comments` entry, `prCommentsLastCheckAt`, `prCommentsQuietSince`, and
`prMergeableStates` are reset. `prCommentsCoderDispatched` must also be cleared here.

**`OrchestrationState` interface** (`src/orchestration/state.ts`, line 106): The new field is
added here with a doc comment.

**Stale doc references** (`docs/staging-repo-proposal.md:130`,
`docs/proposals/task-e7b50cc7.md`, `docs/proposals/task-bc2c634f.md`): These still mention
`hasPrApprovalReaction` even though the function was removed by task-e7b50cc7. The references
should be updated to reflect the current code (remove or replace with accurate descriptions).

## Approach

1. **Add `prCommentsCoderDispatched?: boolean` to `OrchestrationState`** in `state.ts`.
   Add a JSDoc comment explaining it is set on the first coder re-dispatch in `pr-comments` and
   cleared on phase entry.

2. **Set the flag in `redispatchForPrComments()`** in `runner.ts`: after calling
   `transport.sendTurn()` for an agent with `role === "coder"`, set
   `state.prCommentsCoderDispatched = true`.

3. **Reset the flag on phase entry** in `runner.ts` (the `pr-comments` branch inside
   `dispatchPhase`, lines ~463–469): add `state.prCommentsCoderDispatched = false;` alongside
   the other resets. If `applyPhaseSideEffects()` also resets `pr-comments` state, add it there
   as well for consistency.

4. **Add the shortcut in `evaluateTransition()`** in `phases.ts`, in the non-staging non-duo
   path, before the quiet-period check:

   ```ts
   // Shortcut: coder has responded to PR comments — skip quiet period wait
   if (
     state.prCommentsCoderDispatched
     && hasAnyPr(state)
     && allAgentsDone(state)
   ) {
     return "final-merge";
   }
   ```

5. **Add tests** in `phases.test.ts`:
   - `"pr-comments transitions to final-merge immediately when coder has responded"`:
     set `prCommentsCoderDispatched: true`, all agents `pr-comments-done`, non-staging.
   - `"pr-comments does not shortcut when coder has not been dispatched"`:
     `prCommentsCoderDispatched` unset, agents done — must still require quiet period.
   - `"pr-comments shortcut suppressed for staging non-forwarded PRs"`:
     `stagingRepo` set, `prCommentsCoderDispatched: true`, agents done — must return `null`
     (quiet period not elapsed).
   - Regression: quiet-period path still fires when `prCommentsCoderDispatched` is unset and
     quiet period has elapsed.

6. **Clean up doc references**: In each of the three doc files, remove or replace lines that
   reference `hasPrApprovalReaction` with accurate present-tense descriptions of the current
   flow (or simply strike through / delete the stale bullet).

## Scope

**In scope:**
- New `prCommentsCoderDispatched` state field and associated read/write/reset logic
- Shortcut condition in `evaluateTransition()` for non-staging, non-duo `pr-comments`
- Tests for shortcut and regression coverage
- Removal of stale `hasPrApprovalReaction` doc references in three files

**Out of scope:**
- Any change to the quiet-period duration (1200s stays)
- Stricter shortcut conditions (e.g., requiring explicit reviewer approval) — can be added later
- Staging / hierarchical-duo forwarding paths

**Dependencies:** None.
