# Proposal: gh-ludics-509 — Runner self-guard liveness check for stale sibling-PID lock

## Goal

Make the orchestration runner's startup self-guard reclaim a stale sibling-PID lock when the recorded pid is dead, so a single mid-setup runner crash cannot wedge a slot in an indefinite restart loop.

## Acceptance Criteria

1. **Stale-lock reclaim (positive)** — In `src/orchestration/runner.ts`, the PID-mismatch branch around line 2424 calls `processAlive(recordedPid)` (imported from `src/t3code/server.ts`). When the recorded pid is dead, the runner does **not** return; it rewrites the sibling state file with its own `process.pid` (via `writeTmuxSlotState` for `state.backend === "tmux"`, `writeSlotState` otherwise) and continues into `enterPhase`. *Falsifier:* a new test in `src/orchestration/runner.lifecycle.test.ts` named `"reclaims stale tmux sibling lock when recorded PID is dead"` that seeds `tmux-slot-<N>.json` with a guaranteed-dead pid (e.g. one written then `process.kill(pid)`'d, or a synthetic dead pid via mocking `processAlive`), runs `runOrchestration` against a stub transport that completes one phase, and asserts the resulting sibling state file has `orchestration.pid === process.pid`.
2. **Live-sibling exit (negative control)** — When the recorded pid IS alive and not equal to `process.pid`, runner exits with the existing `"sibling PID mismatch ... — exiting"` log and does **not** rewrite the sibling state. *Falsifier:* the existing tests at `runner.lifecycle.test.ts:1346-1412` (`"exits early when tmux sibling state has a mismatched PID"`, `"PID mismatch exits immediately even during the startup grace window"`, `"exits early when t3code sibling state has a mismatched PID"`) continue to pass unmodified. (`process.pid + 1` is treated as live for test purposes; if any of these flake on systems where `process.pid + 1` happens to be dead, mock `processAlive` to return `true` rather than weakening the assertion.)
3. **Backend-routed reclaim** — The reclaim path covers both backends. *Falsifier:* a second new test `"reclaims stale t3code sibling lock when recorded PID is dead"` parallel to AC1 but writing to `t3code/slot-<N>.json` and asserting `readSlotState` returns `orchestration.pid === process.pid` after one phase.
4. **Journal event emitted** — On reclaim, the runner calls `emitEvent({ event_type: "orchestration_lock_reclaimed", slot: state.slot, deadPid: <recordedPid>, newPid: process.pid, backend: state.backend })`. *Falsifier:* AC1's and AC3's tests assert `journal/events.jsonl` (under the test harness dir) contains a line with `"event_type":"orchestration_lock_reclaimed"` whose `slot`, `deadPid`, `newPid`, and `backend` fields match the seeded values.
5. **Health-check cluster rule** — `skills/ludics-health-check.md` gains a sub-rule (under the existing `<!-- section:check-orchestration -->` block, alongside the hung-agent layer at lines 83-113) that scans the post-baseline tail of `journal/events.jsonl` (using the same `PREV_EVENTS_LINES` / `TAIL_FROM` baseline anchor as `agent_hung_detected`) for `orchestration_auto_resume_failed` events, groups by `slot`, and emits a **warning** with stable issue key `auto-resume-stuck:<slot>` when ≥3 such events appear for the same slot within the last 30 minutes. *Falsifier:* `grep -F '"event_type":"orchestration_auto_resume_failed"' skills/ludics-health-check.md` returns ≥1 hit, AND `grep -F 'auto-resume-stuck:' skills/ludics-health-check.md` returns ≥1 hit, AND the surrounding text names the threshold (`3` and `30` minutes) literally.

## Context

Slot 1 wedged in `phase: setup` for ~2.5h on 2026-05-09: `journal/events.jsonl` showed a runner-restart loop where every keepalive tick spawned a new orchestration runner, each immediately exiting with `sibling PID mismatch (expected <new>, got 9366) — exiting`. PID 9366 was long-dead; the lock field `orchestration.pid` in `orchestration/tmux-slot-1.json` had been stuck on it since the original mid-setup runner crash. The runner self-guard at `src/orchestration/runner.ts:2424` treats any PID mismatch as a real conflict (per the comment at 2398-2399), but a parent that wrote a pid and then died leaves a stale lock that no other code path heals on the auto-resume timescale. Fixing it at the runner is belt-and-braces: it self-heals against the observed bug *and* any future code path that forgets to clear the field.

## Approach

- **Edit site**: `src/orchestration/runner.ts` lines ~2424-2429. Replace the unconditional `return` after the mismatch log with an `if (!processAlive(recordedPid)) { ... reclaim ... } else { ...existing log + return ... }` branch. `processAlive` is already imported (`runner.ts:33`); no new imports needed for that. `writeTmuxSlotState` and `writeSlotState` are already in scope (lines 32 and the persistState call at line 2392 confirm the imports).
- **Reclaim write**: rewrite `sibling.orchestration.pid` to `process.pid` via the backend-matching writer (`writeTmuxSlotState` if `state.backend === "tmux"`, else `writeSlotState`). Preserve all other fields with `{ ...sibling, orchestration: { ...sibling.orchestration, pid: process.pid } }`.
- **Event**: emit `event_type: "orchestration_lock_reclaimed"` with fields `slot`, `deadPid`, `newPid`, `backend`. (This is a new event_type — verify no other producer uses it; if it does, this proposal's name wins and the other site is the bug.)
- **Log line**: keep human-readable; format `ludics: runner slot <slot>: reclaiming stale lock from dead pid <deadPid> (now <newPid>)` (matches the surrounding log style at 2419-2420 and 2425-2427).
- **Tests**: add two new `test(...)` blocks in `src/orchestration/runner.lifecycle.test.ts` adjacent to the existing PID-mismatch trio (after line 1412). Reuse the `makeState`, `stubTransport`, and `peerSyncDir`/`harness` fixtures already in scope. Mock `processAlive` (via `mock.module` or a local spy) to return `false` for the seeded dead pid; the alternative — `process.kill`'ing a real child — is racier and unnecessary.
- **Health-check rule**: insert the new sub-rule in the orchestration block near lines 83-113 (after the hung-agent layer). Reuse the existing `PREV_EVENTS_LINES`/`TAIL_FROM` snippet pattern. Threshold: ≥3 events for the same slot within the last 30 minutes (compute via `jq` filtering on `event_type` and slot, then count, or by parsing event timestamps — the implementer can pick whichever fits the existing skill snippets).

### Forbidden / out of scope

- **Do not modify `src/slots/index.ts:1316-1335`** (`slotResume` lock hygiene). The runner-side fix subsumes it; the elaboration explicitly rejected the redundant belt.
- **Do not introduce a monotonic nonce** alongside the pid. PID-recycling hardening is deferred; today's fail-closed behavior on recycled-pid is acceptable.
- **Do not retroactively scan and clean stale lock files** at startup elsewhere — the runner-side fix self-heals on the next start.
- **Do not collide with existing health-check stable-issue keys** (`session-orphaned:<cwd>`, `slot-stall:<slot>:<agent>`, `slot-hung:<slot>:<agent>`, `test-health:<project>`, `deadline:<task>`, `slot-stale:<slot>`, `queue-stuck:<request>`, `completion:<task>`). The new key MUST be `auto-resume-stuck:<slot>`.

## Out of scope

- `slotResume` clearing `orchestration.pid` before spawn (redundant given runner-side fix; revisit only if a different race surfaces).
- Monotonic nonce / wall-clock fingerprint to harden against PID recycling.
- Retroactive cleanup of stale lock files outside the runner self-heal path.
- Generalizing the cluster-detection rule to other `*_failed` event families (separate proposal if/when needed).
