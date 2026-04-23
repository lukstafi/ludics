# Consolidate bail-out handling: extract `triggerCoderBailOut` helper and unify `evaluateTransition` bail-out checks

## Goal

Eliminate duplication in the coder bail-out code paths and make the pair-mode
`evaluateTransition` bail-out short-circuit a single hoisted check instead of a
pattern replicated across four case branches. Behaviour-preserving refactor —
no change in observable semantics, event payloads, or `.status` file contents.

Follow-up from the `gh-ludics-274` retrospective (see
`retrospectives/gh-ludics-274.json` `suggestRefactorSummary`). Reduces the
maintenance surface when adding future bail-out detection points or phases.

## Acceptance Criteria

1. `runner.ts` exports a `triggerCoderBailOut` helper encapsulating:
   - idempotency guard (`runtime.status !== "bail-out"`),
   - runtime status/epoch/message mutation,
   - `.status` file write in the existing `bail-out|<epoch>|<message>\n` format,
   - `bail_out` event emission,
   - `persistState(state)` (unconditionally inside the helper).
2. The two existing coder bail-out trigger sites in `runner.ts` — the early
   work-phase no-op detection after `autoCommitAllAgents`, and the body of
   `checkZeroCommitsAutoBailOut` — are replaced with calls to the helper,
   producing byte-identical `.status` file contents and `bail_out` event
   payloads compared to pre-refactor for each site's `(action, message)`
   pair.
3. `phases.ts` `evaluateTransition` has a single early bail-out check at the
   top of the function (before the `switch`, after the solo-mode delegation),
   gated on BOTH:
   - `state.phase` being in the allowlist `{"work", "review", "update-docs", "pr-create"}`, AND
   - the readiness guard `allAgentsDone(state) || phaseTimeoutExpired(state)`.
   The four case branches for these phases have their redundant
   `if (isBailedOut(state)) return "done";` line removed.
4. Phases outside the allowlist — in particular `pr-comments`, `final-merge`,
   `suggest-refactor`, and all pre-`work` phases (`setup`, `gather`, `clarify`,
   `pushback`, `plan`, `plan-merge`, `plan-review`) — retain their current
   transition logic and are NOT short-circuited by the new early check.
5. Solo-mode transition logic (`evaluateTransitionSolo`) is unchanged.
6. `checkZeroCommitsAutoBailOut`'s separate `isBailedOut(state) → state.phase = "done" → persistState → return true` fast-path block (which runs in the main loop BEFORE `evaluateTransition`) is preserved; this refactor does not change it.
7. Unit tests cover the helper and the hoisted check (8 tests, enumerated in
   Approach below). All existing `phases.test.ts` and `runner.test.ts` suites
   continue to pass.

## Context

All code lives in `/Users/lukstafi/ludics/src/orchestration/`.

### Current trigger sites in `runner.ts`

- `checkZeroCommitsAutoBailOut(state)` — exported. Guarded by
  `state.phase === "pr-create"`, then `isBailedOut(state)` fast-path shortcut
  (which mutates `state.phase = "done"` and returns `true` without running the
  main bail-out block), then `isWorktreeNoOp(coder.worktreePath, state.projectDir)`.
  The main bail-out block (~8 lines) is the one to be replaced by the helper.
  The function then unconditionally sets `state.phase = "done"` and calls
  `persistState(state)` at the end — this part stays.
- "Early no-op detection" block inside `runOrchestration`, immediately after
  `autoCommitAllAgents(state, participating, /* push */ false)`. Guarded by
  `state.phase === "work"` and `isWorktreeNoOp(coder.worktreePath, state.projectDir)`.
  The 8-line block setting `runtime.status`, writing the `.status` file,
  emitting the event, and calling `persistState` is the second replacement
  target.

Both sites use the identical `runtime.statusMessage`:
`"no-op: zero commits ahead of base, no uncommitted diffs"`.

Event `action` / `message` differ per site:

- early work-phase: `action: "work-phase no-op detection"`, `status: "bail-out"`,
  `message: "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol"`.
- `checkZeroCommitsAutoBailOut`: `action: "pr-create auto-bail-out"`, `status: "skipped"`,
  `message: "0 commits ahead of base branch — no PR possible, skipping to done"`.

Both emit `event_type: "bail_out"` with `source: "orchestration"`, `scope: "slot"`,
and include `slot: state.slot`, `task: state.taskId`.

### Current bail-out checks in `phases.ts`

- `isPairBailedOut(state)` — coder `"bail-out"` AND reviewer `"bail-out-confirmed"`.
- `isSoloBailedOut(state)` — solo coder `"bail-out"` alone.
- `isBailedOut(state)` — union. Callers in `evaluateTransition` and
  `checkZeroCommitsAutoBailOut` all use the union form.
- `evaluateTransitionSolo` already has `if (isBailedOut(state) && state.phase !== "done") return "done";`
  at the top, unconditional (no readiness guard needed — solo handshake is
  trivially one-sided).
- `evaluateTransition` (pair/duo) — the four case branches to consolidate:
  - `case "work"`: readiness guard → `if (isBailedOut(state)) return "done";` → normal transition.
  - `case "review"`: same shape.
  - `case "update-docs"`: same shape.
  - `case "pr-create"`: same shape.
- `evaluateTransition` delegates to solo before the switch:
  `if (state.mode === "solo") return evaluateTransitionSolo(state);`. The new
  early check sits AFTER this delegation, so solo dispatch is unaffected.

### Out-of-allowlist phases (must not short-circuit)

- Pre-work phases (`setup`, `gather`, `clarify`, `pushback`, `plan`,
  `plan-merge`, `plan-review`): bail-out handshake cannot occur before work.
- `pr-comments`: runs hierarchical duo merge coordination (cross-slot
  merge-vote triggering); short-circuiting would break duo merge.
- `merge-vote` / `merge-debate` / `merge-execute` / `merge-review` / `merge-amend`:
  the merge machinery must complete regardless of stale bail-out signals.
- `final-merge`: must complete PR merge regardless — bail-out is only
  meaningful before a PR exists.
- `suggest-refactor`: retrospective data collection, no transition short-circuit.
- `done`: already terminal.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Helper extraction (Item 1)

Add to `runner.ts`, exported, near the existing `checkZeroCommitsAutoBailOut`:

```ts
export function triggerCoderBailOut(
  state: OrchestrationState,
  coder: AgentRecord,
  action: string,
  message: string,
  statusMessage: string = "no-op: zero commits ahead of base, no uncommitted diffs",
  eventStatus: string = "bail-out",
): void {
  const runtime = state.agentStates[coder.name];
  if (!runtime || runtime.status === "bail-out") {
    persistState(state);
    return;
  }
  runtime.status = "bail-out";
  runtime.statusEpoch = nowEpoch();
  runtime.statusMessage = statusMessage;
  writeFileSync(
    join(state.peerSyncDir, `${coder.name}.status`),
    `bail-out|${runtime.statusEpoch}|${runtime.statusMessage}\n`,
  );
  emitEvent({
    event_type: "bail_out",
    source: "orchestration", scope: "slot",
    slot: state.slot, task: state.taskId,
    action, status: eventStatus, message,
  });
  persistState(state);
}
```

Call sites:

- Early work-phase detection: `triggerCoderBailOut(state, coder, "work-phase no-op detection", "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol")`.
- `checkZeroCommitsAutoBailOut` main bail-out block: `triggerCoderBailOut(state, coder, "pr-create auto-bail-out", "0 commits ahead of base branch — no PR possible, skipping to done", undefined, "skipped")`. The function then proceeds to `state.phase = "done"; persistState(state); return true;` as today.

Note: `eventStatus` is parameterised to preserve the current asymmetry
(`"bail-out"` for early detection vs. `"skipped"` for `pr-create` auto-bail-out).
If the reviewer prefers, the caller can emit its own event and the helper can
focus strictly on runtime/status-file/persist mechanics — this is a minor
design choice left to the coder agent.

Whether to call `persistState` in the idempotent no-op branch is mildly
debatable; the helper calls it unconditionally per Q3 resolution. This may
add one redundant persist in the rare re-entry case but is "simpler and
safer" as noted in the task.

### Hoist in `evaluateTransition` (Item 2)

In `phases.ts`, immediately after the solo delegation:

```ts
export function evaluateTransition(state: OrchestrationState): Phase | null {
  if (state.mode === "solo") return evaluateTransitionSolo(state);

  // Hoisted pair-mode bail-out short-circuit.
  // Allowlist preserves current behaviour: the four cases below used to have
  // the equivalent check inline. Phases outside this set either run their
  // own coordination logic (pr-comments, merge-*, final-merge) or can't
  // reach a bail-out handshake (pre-work phases), so they stay out.
  const PAIR_BAIL_OUT_PHASES: ReadonlySet<Phase> = new Set([
    "work", "review", "update-docs", "pr-create",
  ]);
  if (
    PAIR_BAIL_OUT_PHASES.has(state.phase)
    && (allAgentsDone(state) || phaseTimeoutExpired(state))
    && isBailedOut(state)
  ) {
    return "done";
  }

  switch (state.phase) {
    // ... (unchanged, except the four cases below drop their redundant
    // `if (isBailedOut(state)) return "done";` line)
```

The four case branches become:

```ts
case "work":
  if (allAgentsDone(state) || phaseTimeoutExpired(state)) {
    return "review";  // bail-out already handled by hoisted check
  }
  return null;

case "review":
  if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
  {
    const reviewVerdict = pairReviewVerdict(state);
    if (reviewVerdict === "request_changes") return "work";
  }
  return "update-docs";

case "update-docs":
  if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
  if (hasAnyPr(state)) return "pr-comments";
  return "pr-create";

case "pr-create":
  if (!(allAgentsDone(state) || phaseTimeoutExpired(state))) return null;
  if (!hasAnyPr(state)) return null;
  return "pr-comments";
```

`checkZeroCommitsAutoBailOut`'s separate `isBailedOut → state.phase = "done" → persistState → return true`
fast-path block is NOT touched by Item 2 — it runs before `evaluateTransition`
in the main loop and mutates `state.phase` directly.

### Unit tests

Add to `runner.test.ts`:

1. `triggerCoderBailOut` first call: sets `runtime.status = "bail-out"`,
   writes `.status` with `bail-out|<epoch>|<message>\n`, emits one
   `bail_out` event, calls `persistState`.
2. `triggerCoderBailOut` second call when `runtime.status === "bail-out"`:
   no new event emitted, no second `.status` write. (PersistState may still
   be called per Q3.)
3. `triggerCoderBailOut` with different `(action, message)` pairs produces
   the expected event contents.
4. Migration snapshot: early work-phase trigger and `checkZeroCommitsAutoBailOut`
   trigger produce byte-identical `.status` files and `bail_out` event
   payloads compared to pre-refactor fixtures. (One test per site.)

Add to `phases.test.ts`:

5. Allowlisted phases (`work`, `review`, `update-docs`, `pr-create`) with
   bail-out confirmed AND `allAgentsDone` return `"done"`. (Current
   behaviour preserved.)
6. Allowlisted phases with bail-out confirmed but agents NOT done return
   `null`. (Readiness guard preserved.)
7. Non-allowlisted phases (`setup`, `plan`, `pr-comments`, `final-merge`,
   `suggest-refactor`) with bail-out confirmed and agents done do NOT
   short-circuit — they return per their normal transition logic.
8. Solo mode regression: `evaluateTransitionSolo` still short-circuits
   unconditionally on bail-out (agents-done not required).

## Scope

### In scope

- `src/orchestration/runner.ts` — add `triggerCoderBailOut`, retire the two
  inline bail-out blocks.
- `src/orchestration/phases.ts` — add hoisted early check in
  `evaluateTransition`, remove the four redundant inline checks.
- `src/orchestration/runner.test.ts` — tests 1–4.
- `src/orchestration/phases.test.ts` — tests 5–8.

### Out of scope

- Reviewer-confirmed status write path (Q4): that's written by the reviewer
  agent's skill template, not the runner. No runner-side extraction needed.
- `checkZeroCommitsAutoBailOut`'s separate fast-path block (the one that
  mutates `state.phase = "done"` directly). Preserved as-is.
- `evaluateTransitionSolo`: unchanged; it already has the desired early
  check (without a readiness guard, which is correct for solo).
- Any change to `.status` file format, `bail_out` event schema, or bail-out
  state machine semantics.
- Adding new bail-out detection sites or new phases to the allowlist.

### Dependencies

None. Behaviour-preserving; no coordination with other in-flight work
required.
