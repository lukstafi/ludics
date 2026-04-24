# Escalation feature DRY cleanups

## Goal

Three small DRY cleanups in the escalation/orchestration surface introduced
by `task-4cd94043` (bail-out: escalate feature). All three were flagged in
the coder's `suggestRefactorSummary` "Possible follow-ups" and bundled here
because they are each ~3–8 LOC and all touch the same orchestration runner /
slot-state subsystem.

Tracks retrospective follow-ups from `task-4cd94043`. No GitHub issue.

## Acceptance Criteria

1. **`setSlotLivenessOnData` helper** exists in `src/slots/index.ts`, exported,
   with signature shape:
   ```ts
   export function setSlotLivenessOnData(data: SlotData, value: SlotLiveness): SlotData
   ```
   It mutates `data.liveness` in place (and returns `data` for chaining /
   composability). It does NOT touch `sessionStarted` or other companion
   fields — callers continue to set those alongside the helper call.

2. **All four production liveness write sites** use the helper:
   - `markSlotSetupFailed` in `src/slots/index.ts` — currently
     `data.liveness = "interrupted"` plus `data.sessionStarted = null`.
   - `slotStart` in `src/slots/index.ts` — currently `data.liveness = null`
     after adapter start, plus `sessionStarted = <ts>`.
   - `slotResume` in `src/slots/index.ts` — currently `data.liveness = null`
     after adapter startup, plus `sessionStarted = <ts>`.
   - `handleEscalation` in `src/orchestration/runner.ts` — currently
     `data.liveness = "escalated"` inside the existing `try { … } catch { … }`
     wrapper.

3. **`handleEscalation`'s try/catch wrapping is preserved** verbatim — the
   helper does not log or swallow; the caller keeps its existing
   `console.error("ludics: failed to set slot N liveness=escalated: …")`
   fallback.

4. **No write-side validator** is added. TypeScript already enforces
   `SlotLiveness` at compile time; runtime throwing has no useful recovery
   path. (`parseSlotLiveness` continues to gate external/markdown input on the
   read side.)

5. **`src/cluster-http.ts` and `src/slots/migration.ts` are NOT touched.**
   Both already use `parseSlotLiveness` for external-input narrowing and are
   out of scope for this DRY pass.

6. **`readLiveOrchestratorPid` in `src/slots/index.ts`** uses `processAlive`
   from `src/t3code/server.ts` instead of inlining `process.kill(pid, 0)`:
   - Add `processAlive` to the existing
     `import { readSlotState, writeSlotState } from "../t3code/server.ts"`
     line.
   - Body becomes:
     ```ts
     if (pid === undefined || !processAlive(pid)) return null;
     return pid;
     ```
   - The redundant `pid <= 0` guard is dropped (`processAlive` already does
     `Number.isInteger(pid) && pid > 0`). The `pid === undefined` guard stays
     (optional-chaining source can yield `undefined`).

7. **`checkEscalationHalt(state: OrchestrationState): boolean`** is added and
   **exported** from `src/orchestration/runner.ts`, mirroring the export
   pattern of `checkZeroCommitsAutoBailOut`. Shape:
   ```ts
   export function checkEscalationHalt(state: OrchestrationState): boolean {
     if (!isEscalated(state)) return false;
     persistState(state);
     return true;
   }
   ```

8. **`pollUntilDone`'s inline escalation short-circuit is replaced** by
   `if (checkEscalationHalt(state)) return;` at the same call-order position
   — i.e., immediately after `refreshAgentStatuses(state, transport)`, since
   escalation is detected by parsing freshly-refreshed agent status files.
   The `return` (rather than `break`) is preserved — `pollUntilDone` is an
   inner function and its caller `runOrchestration` has a separate
   escalation branch.

9. **No behaviour change for existing tests.** `runner.escalation.test.ts`
   and the `escalated-resume` cases in `slots/index.test.ts` pass unchanged.
   A unit test for `checkEscalationHalt` MAY be added (it's now exported),
   but is optional.

10. **Verification:** `bun run typecheck && bun run lint && bun run build && bun test`
    all pass.

## Context

Subsystem: orchestration runner + slot-state writers, around the escalation
feature landed in `task-4cd94043`.

### Key types and helpers (already in tree)

- `SlotLiveness = "alive" | "interrupted" | "escalated" | null` — exported
  from `src/slots/types.ts`.
- `SlotData` interface — exported from `src/slots/types.ts`.
- `parseSlotLiveness(raw: unknown): SlotLiveness` — read-side narrower in
  `src/slots/types.ts`. Used by `src/cluster-http.ts` and
  `src/slots/migration.ts`. The new write-side helper is a structural mirror
  but does NOT validate (see AC4).
- `processAlive(pid: number): boolean` — exported from `src/t3code/server.ts`.
  Already used by `computeSlotLiveness` (`src/dashboard.ts`) and several
  callers inside `src/t3code/server.ts` itself.
- `isEscalated(state: OrchestrationState): boolean` — exported from
  `src/orchestration/phases.ts`, already imported at the top of
  `src/orchestration/runner.ts`.
- `persistState(state)` — already used throughout `runner.ts`.
- `checkZeroCommitsAutoBailOut(state: OrchestrationState): boolean` — the
  exported precedent in `src/orchestration/runner.ts` for the
  named-halt-guard pattern. Caller uses `if (check…) break;` from
  `runOrchestration`.

### Liveness write sites today

All four sites follow the same shape:

```ts
const data = readSlot(slotNum) /* or readSlotJson(state.slot) */;
// …mutate companion fields (sessionStarted, etc.)…
data.liveness = <enum value>;
writeSlotJson(slotNum, data);
```

`data` is the established variable name across all four sites, which is why
the mutator-only `setSlotLivenessOnData(data, value)` form composes
naturally — callers keep their `read` and `write` calls, and keep their
companion-field mutations adjacent.

The helper's natural home is `src/slots/index.ts`, co-located with
`readSlot` / `writeSlotJson` / `markSlotSetupFailed`. `runner.ts` will gain
one new import (or extend an existing one if it already imports from
`../slots/index.ts`).

### `readLiveOrchestratorPid` today

Private function in `src/slots/index.ts`, used by `slotResume`'s idempotence
short-circuit (AC5 from the prior task). Current body inlines a PID-probe
that duplicates `processAlive`'s logic — including a redundant `pid <= 0`
guard.

### `pollUntilDone` escalation halt today

Inline short-circuit at the top of the `while (true)` loop in
`pollUntilDone`, immediately after `refreshAgentStatuses`:

```ts
if (isEscalated(state)) {
  persistState(state);
  return;
}
```

Naming this guard makes "where can orchestration halt for escalation?"
answerable by `grep checkEscalationHalt`, and matches the
`checkZeroCommitsAutoBailOut` precedent.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The task is mechanical and the brief specifies the exact end-state at each
site, so the work is essentially "find each anchor, swap in the helper /
guard call, run the test suite."

1. Add `setSlotLivenessOnData(data: SlotData, value: SlotLiveness): SlotData`
   to `src/slots/index.ts` (export it). Body: `data.liveness = value; return data;`.
2. Migrate the four call sites:
   - `markSlotSetupFailed`: replace `data.liveness = "interrupted"` with
     `setSlotLivenessOnData(data, "interrupted")`. Keep `sessionStarted = null`
     adjacent.
   - `slotStart`: replace `data.liveness = null` with
     `setSlotLivenessOnData(data, null)`. Keep `sessionStarted = <ts>`
     adjacent.
   - `slotResume`: same as `slotStart`.
   - `handleEscalation` in `runner.ts`: import `setSlotLivenessOnData` (and
     extend the imports as needed), replace `data.liveness = "escalated"`
     with the helper call. Keep the surrounding `try/catch` exactly as it is.
3. Add `processAlive` to the existing
   `import { readSlotState, writeSlotState } from "../t3code/server.ts"`
   line in `src/slots/index.ts`. Rewrite the `readLiveOrchestratorPid`
   probe to `if (pid === undefined || !processAlive(pid)) return null;`.
4. In `src/orchestration/runner.ts`, add the exported `checkEscalationHalt`
   function near `checkZeroCommitsAutoBailOut`. Replace the inline
   `if (isEscalated(state)) { persistState(state); return; }` at the top of
   `pollUntilDone`'s loop with `if (checkEscalationHalt(state)) return;`,
   preserving its position immediately after `refreshAgentStatuses`.
5. Run `bun run typecheck && bun run lint && bun run build && bun test`.
6. Optionally add a unit test for `checkEscalationHalt` in
   `runner.escalation.test.ts` (now that it's exported). Skip if the
   end-to-end coverage feels sufficient.

## Scope

**In scope:**
- `src/slots/index.ts` — new helper, four migrated sites, `processAlive`
  reuse in `readLiveOrchestratorPid`.
- `src/orchestration/runner.ts` — new exported `checkEscalationHalt`,
  inline-guard replacement in `pollUntilDone`, one-line import of
  `setSlotLivenessOnData`.
- (Optional) `src/orchestration/runner.escalation.test.ts` — a unit test
  for the newly-exported `checkEscalationHalt`.

**Out of scope:**
- `src/cluster-http.ts` (already uses `parseSlotLiveness`).
- `src/slots/migration.ts` (already uses `parseSlotLiveness`).
- Any write-side runtime validator / throwing on bad enum values
  (explicitly rejected by the user — AC4).
- Behaviour changes to escalation, slot resume, or zero-commit bail-out.
- Renaming or relocating existing exports (`processAlive`,
  `checkZeroCommitsAutoBailOut`, `isEscalated`, etc.).

**Dependencies:** none. This is purely a refactor on top of code that has
already merged via `task-4cd94043`.
