# Proposal: Introduce `bail-out: escalate` — agent-initiated resumable orchestration pause

**Task:** task-4cd94043
**Date:** 2026-04-23
**Related:** gh-ludics-310 (the 9-round loop incident), gh-ludics-346 (the parser bug that triggered it)

## Goal

Give agents an explicit, first-class way to raise their hand when they believe they are stuck in a contradictory or looping situation. When an agent writes `escalate` to its `.status` file, the runner halts orchestration at the current phase (no phase advance, no discarded work), marks the slot with a new `escalated` liveness, emits an `escalation_requested` event, and fires a priority-5 `ludics notify outgoing` so Mag/the user are alerted. The user inspects, applies whatever fix is needed, and resumes via the existing `ludics slot N resume` command — which is extended to clear `escalated` in the same way it already handles `interrupted`.

This is the runtime/orchestration-phase analogue of `has_questions: true` pausing the proposal phase: a collaborative agent-initiated ask, not a reactive circuit-breaker.

## Acceptance Criteria

1. **Status token on the wire** — agents write `escalate|<epoch>|<reason>` to their `.status` file. `readAgentStatus()` in `peer-sync.ts` continues to parse the pipe-delimited format unchanged (`escalate` flows through as the `status` field).

2. **New helper predicate** — `isEscalated(state)` in `src/orchestration/phases.ts` returns `true` iff any agent's runtime status equals `"escalate"`. Unlike `isBailedOut`, this is a disjunction, not a handshake: any single agent can trigger it. `"escalate"` is **not** added to `DONE_STATUSES` — escalation is not "done."

3. **Runner halt** — `runOrchestration()` in `src/orchestration/runner.ts` checks `isEscalated(state)` early (after `refreshAgentStatuses` observes the new status, either inside `pollUntilDone` or immediately after it returns, but before `evaluateTransition`). On true:
   - `persistState(state)` first (crash safety).
   - `emitEvent({event_type: "escalation_requested", slot, task, phase, agent, reason})` for each escalating agent (if both agents escalate simultaneously, both surface in the event log / notification context).
   - `notifyOutgoing(message, priority: 5, title)` with message shape `"Slot N agent X escalated on task <task-id> at phase <phase>: <reason>"`. If the reason field is empty, substitute `"(no reason provided)"` and log a warning — do not block the escape hatch.
   - Set the slot's `liveness` to `"escalated"` (via `writeSlotJson` or equivalent).
   - `persistState(state)` again, then `return` from `runOrchestration()`. Do **not** `break` — the post-body code of the `while` loop would advance phase.

4. **Liveness enum widened** — `liveness: "alive" | "interrupted" | "escalated" | null` across:
   - `src/slots/types.ts` — canonical type.
   - `src/dashboard.ts` — the narrowed display type (lines ~68, ~82, ~295) and `computeSlotLiveness` (line ~99).
   - All consumer switch/display sites surfaced by grepping the `"interrupted"` literal: `src/mag.ts` (skip sets), `src/slots/index.ts` (`slotResume` branches, `markSlotSetupFailed`), `src/dashboard.ts` (display).
   The dashboard distinguishes `escalated` visually from `interrupted` (the notification is priority-5; the UI should make the slot salient).

5. **Resume path** — `slotResume()` in `src/slots/index.ts` gains a branch symmetric to the existing `liveness === "interrupted"` fallbacks: when `liveness === "escalated"`, clear the liveness back to `null`, then continue into the normal resume code (re-enter the orchestrator tick; the persisted orchestration state already holds the correct phase/round). Idempotent: a second `slot N resume` on an already-resumed slot sees `liveness === null` and behaves as a no-op normal resume.

6. **Mag auto-resume skips escalated slots** — the two skip sets in `src/mag.ts` (currently near lines 2156 and 2225, testing `slotLiveness === "interrupted"`) are extended to also skip `liveness === "escalated"`. Mag must not clear an escalation; only explicit `ludics slot N resume` does.

7. **Skill-template mentions** — one short paragraph in each of:
   - `skills/orchestration/pair-coder-work.md`
   - `skills/orchestration/pair-reviewer-review.md`
   - `skills/orchestration/solo-work.md`

   The paragraph names the `escalate` status token, shows the one-line `printf` form, and cross-references `docs/orchestration-patterns.md#escalation-contract` (or the chosen anchor slug) for the when-to-use rule. No inline procedural checklist — follow the reference-layer-not-inline principle.

   Plan-phase templates (`pair-coder-plan.md`, `pair-reviewer-plan-review.md`, `pair-coder-plan-merge.md`) are **not** modified: plan-merge's existing 3-iteration force-forward to work is the safety net there.

8. **Pattern doc entry** — new `### Escalation contract` section in `docs/orchestration-patterns.md`, sibling to the existing `### Bail-out contract` under `## Coding` (or a new `## Agent signals` subsection if preferred). Covers: principle (agent-initiated resumable halt), when to emit (N rounds of no-progress on unchanged input, contradictory instructions, trapped-agent situations), status format, runner behavior (halt in place, event, priority-5 notification, `liveness=escalated`), resolution path (user inspects → manual fix → `ludics slot N resume`). Explicitly distinguishes from `bail-out` (which is "done") and from `interrupted` (framework failure vs. agent-initiated ask).

9. **Tests**:
   - `src/orchestration/phases.test.ts` — new `describe("isEscalated", ...)` covering: no agent escalated → false; coder escalated → true; reviewer escalated → true; both escalated → true; only a different done status present → false. Plus `evaluateTransition` regression cases confirming escalation does not accidentally route through `isBailedOut` / `DONE_STATUSES`.
   - `src/orchestration/runner.*.test.ts` (pick the closest cluster; `runner.lifecycle.test.ts` or a new file) — full halt path: set up a state where coder writes `escalate|<epoch>|reason`, run one iteration of `runOrchestration`, assert (a) `escalation_requested` event was emitted, (b) `notifyOutgoing` was called at priority 5 with the expected message shape, (c) `slotData.liveness === "escalated"`, (d) `state.phase` did **not** advance, (e) `runOrchestration` returned cleanly. A parallel case with empty reason asserts the `(no reason provided)` text and warning log. A case with both agents escalating in the same tick asserts both statuses surface and the halt still fires exactly once.
   - `src/slots/index.test.ts` — new `slotResume` test: slot with `liveness === "escalated"` and valid persisted orchestration state → resume clears liveness to `null` and re-enters the runner; a second `slotResume` call is a no-op.
   - Update any existing dashboard / liveness tests that enumerate the enum values (e.g. `dashboard.test.ts`) to include `"escalated"`.

10. **Build + tests green** — `bun run build` succeeds; `bun test` passes (including the new suites).

## Context

### Existing status-file protocol

`readAgentStatus(dir, agent)` in `src/orchestration/peer-sync.ts` parses a pipe-delimited `status|epoch|message` line from `<agent>.status`. Any token flows through as-is; no whitelist at the parser layer.

Done-status whitelisting lives in `DONE_STATUSES` in `src/orchestration/phases.ts`, together with the helpers `isPairBailedOut`, `isSoloBailedOut`, and `isBailedOut` (exported at the bottom of that file). `validateDoneStatus` bypasses artifact validation when the agent's status is a bail-out token and `isBailedOut(state)` holds.

### Runner halt-point precedent

`checkZeroCommitsAutoBailOut(state)` in `src/orchestration/runner.ts` is the closest existing status-driven halt: it inspects `isBailedOut(state)` + no-op worktree, transitions phase to `"done"`, `persistState`s, and returns `true` so the caller can `break` the outer loop. An escalation handler lives in the same neighborhood (between the work-phase no-op detection and the verification gates) but **does not** advance phase — it just sets liveness, emits side effects, and returns from `runOrchestration` outright.

`runOrchestration`'s outer loop is `while (state.phase !== "done")`. On escalation, the desired exit is "neither phase advance nor loop continuation"; `return` is the clean shape.

### Liveness touch-points

Canonical type: `liveness: string | null` in `src/slots/types.ts`.

Narrowed display type `liveness: "alive" | "interrupted" | null` in `src/dashboard.ts`. `computeSlotLiveness` returns `"alive"` or `"interrupted"` based on orch-pid aliveness and heartbeat freshness. Adding `"escalated"` means `computeSlotLiveness` also returns an explicit `"escalated"` short-circuit when `slotData.liveness === "escalated"` (the explicit-liveness branch at line ~87 is already the template: `if (explicit === "interrupted") return "interrupted";`).

Consumer sites surfaced by grepping `"interrupted"` literal: `src/mag.ts:2156, 2225` (both skip sets); `src/slots/index.ts:476` (`markSlotSetupFailed` writes `"interrupted"`), `939, 954` (the resume branches that fall back to fresh start). The new `"escalated"` branch in `slotResume` mirrors the structure but clears liveness and continues (no fresh start — the orchestration state is intact).

### Notification + event plumbing

`emitEvent` in `src/events.ts` takes a free-form record; add `event_type: "escalation_requested"` with `{slot, task, phase, agent, reason}`. `notifyOutgoing(message, priority, title)` in `src/notify.ts` writes to `journal/notifications.jsonl`; priority 5 is highest.

### Skill templates

`skills/orchestration/pair-coder-work.md`, `skills/orchestration/pair-reviewer-review.md`, and `skills/orchestration/solo-work.md` each already have a bail-out signal block. The escalation paragraph goes immediately adjacent — one sentence naming the action, the one-line `printf` form, and a cross-reference to the new `docs/orchestration-patterns.md` anchor.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The proposal has exact code pointers and the five elaboration questions are resolved, so the implementation shape is largely mechanical. Suggested landing order:

1. **Parser layer (trivial)** — confirm `readAgentStatus` in `peer-sync.ts` passes `escalate` through unchanged (it should, since parsing is token-agnostic). No code change expected; spot-check by adding a parser test case if not already covered.

2. **Predicate** — add `isEscalated(state)` to `phases.ts` next to `isBailedOut`, plus tests in `phases.test.ts`.

3. **Liveness enum widening** — touch all sites in one small commit so types stay consistent:
   - `src/slots/types.ts` (type definition).
   - `src/dashboard.ts` (narrowed type + `computeSlotLiveness` short-circuit + dashboard display).
   - `src/mag.ts` (both skip sets).
   - `src/slots/index.ts` (new `slotResume` branch + `markSlotSetupFailed` untouched — escalation is not a setup failure).
   - Update `dashboard.test.ts` enum enumerations if needed.

4. **Runner halt** — add the check-and-halt block in `runOrchestration` after the work-phase no-op detection and before `checkZeroCommitsAutoBailOut`, or equivalently after `refreshAgentStatuses` inside `pollUntilDone`. Factor the halt body into a small helper (`handleEscalation(state, transport?)`) if clarity wins. Add full-path tests in the runner cluster.

5. **`slotResume` branch** — the escalated-resume path is a minimal addition: early in `slotResume`, if `liveness === "escalated"`, clear it to `null` (persist), then fall through to the existing resume logic. No fresh-start fallback needed — persisted orchestration state is intact.

6. **Skill templates + doc entry** — smallest change, do last once the code contract is stable (so the paragraph can name the actual anchor slug and the printf form matches what the tests verify).

### Edge cases to preserve

- **Both agents escalate in the same tick**: emit one `escalation_requested` event per escalating agent; halt fires exactly once; notification text references both (include all escalating agents' names and reasons).
- **Agent overwrites `escalate` with another status before the runner re-reads**: halt on first observation — don't round-trip through another refresh. If the agent changes its mind, the user will see the notification, resume the slot, and the new status drives the next tick.
- **Persist-before-return ordering**: persist orchestration state → write slot liveness → persist slot JSON → return. Worst case on crash: a duplicate notification on manual resume (acceptable).
- **Empty reason**: warn + substitute `(no reason provided)`, do not reject (Q5).
- **Duo-peer slot**: when a slot in a hierarchical-duo pair escalates, do **not** auto-halt the peer slot. The notification carries enough context (peer-slot number, phase) that Mag or the user can decide; avoiding auto-peer-halt keeps the v1 change simple (consistent with user's general preference against reactive auto-halts).
- **Federation / remote slots**: out of scope for v1. Notifications and events propagate via the existing git-sync; the user runs `ludics slot N resume` on the owning node (the current `slotResume` already dispatches remotely via `isRemoteMachine()`, so this works naturally).

## Scope

**In scope:**
- Parser passthrough + `isEscalated` predicate.
- Runner halt path (event + priority-5 notification + liveness set + clean return).
- `liveness` enum widening across all consumer sites.
- `slotResume` escalated-resume branch.
- Mag auto-resume skip-set extensions.
- Skill-template mentions (pair-coder-work, pair-reviewer-review, solo-work only).
- `docs/orchestration-patterns.md` Escalation contract entry.
- Tests across `phases.test.ts`, `runner.*.test.ts`, `slots/index.test.ts`, and relevant dashboard tests.

**Out of scope:**
- Auto-detection of loop conditions (expressly rejected per user directive 2026-04-23 — no round-count limits, no automatic escalation triggers).
- Changes to the existing `bail-out` / `bail-out-confirmed` mechanism.
- Plan-phase templates (plan-merge's 3-iteration force-forward already covers the plan-phase case).
- New CLI subcommands — `slot N resume` is the only resolution path.
- Federation / cluster-level resume semantics (remote nodes are supported only via the existing git-sync + `isRemoteMachine()` dispatch in `slotResume`).
- Automatic peer-slot halt in duo mode.

**Dependencies:**
- No hard dependencies. Sibling gh-ludics-346 (parser fix) can land independently and will prevent the specific gh-ludics-310 incident class; this task is the general-purpose escape hatch for other loop/contradiction classes.
