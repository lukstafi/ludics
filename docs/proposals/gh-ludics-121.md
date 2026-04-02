# Proposal: Dashboard computed liveness status for active slots

**Task**: gh-ludics-121
**Project**: ludics

## Goal

When an orchestrator process dies unexpectedly (crash, reboot, sleep) for a slot that the dashboard shows as "Active", the dashboard should detect this and display an "Interrupted" status instead of the misleading "Active" label. This gives the user immediate visibility into which slots need attention, and provides a one-click Resume button to restart the orchestrator.

## Acceptance Criteria

1. Dashboard slots that have an active task+phase but a dead orchestrator PID display status **"Interrupted"** instead of "Active".
2. The "Interrupted" status has visually distinct styling (different color from "Active" green) so it stands out at a glance.
3. When a slot shows "Interrupted", the Start button is replaced by a **Resume** button that triggers `slotResume` for that slot.
4. Slots without an orchestration PID (e.g., manually assigned, no orchestration state, or phase "done") are **not** affected — they continue to show their current status.
5. Liveness is computed ephemerally on each dashboard data refresh — no new persisted state is introduced.
6. The liveness check works for both tmux and t3code adapter modes (reading the appropriate slot state file for the orchestrator PID).

## Context

The dashboard currently classifies non-empty slots with a task and phase as "Active" regardless of whether the orchestrator process is actually running. After a machine sleep, reboot, or process crash, slots appear "Active" when nothing is running — the user must manually check or wait for the keepalive cycle (`maybeResumeDeadOrchestrators`) to notice. This task surfaces that information directly in the dashboard UI.

**User decisions (from elaboration Q&A):**
- Status label: **"Interrupted"** — accurately describes a process that was running and stopped unexpectedly, without implying a bug or data corruption.
- Don't distinguish orchestrator-dead from agent-sessions-dead — agent sessions can be resumed by the orchestrator, so only the orchestrator PID matters for dashboard status.
- Convert the Start button into a Resume button when a slot shows "Interrupted", triggering `slotResume`.

## Approach

### Backend (`src/dashboard.ts`)

1. **Add `liveness` field to `SlotJson`**: Type `"alive" | "interrupted" | null`. Null for empty slots, slots without orchestration state, or slots in phase "done".

2. **Compute liveness in `generateSlots()`**: For each non-empty slot that has a phase (i.e., would render as "Active"):
   - Determine the adapter mode from the slot block (`getMode()`).
   - For **t3code** mode: call `readSlotState(slotNum)` and check `slotState.orchestration?.pid` with `process.kill(pid, 0)`.
   - For **tmux** mode: call `readTmuxSlotState(slotNum, harnessDir())` and check `tmuxSlotState.orchestration?.pid` with `process.kill(pid, 0)`.
   - If no PID is recorded or no slot state exists, set liveness to `null` (don't mark as interrupted — there may never have been an orchestrator).
   - If PID exists and is dead, set liveness to `"interrupted"`.
   - If PID exists and is alive, set liveness to `"alive"`.

3. **Reuse existing `processAlive()`**: Currently local to `src/t3code/server.ts`. Either export it or inline the `process.kill(pid, 0)` pattern (as `maybeResumeDeadOrchestrators` already does). Exporting is cleaner.

4. **Import `readTmuxSlotState`**: Currently not exported from `src/adapters/tmux-adapter.ts` — export it, or inline the read logic.

### Frontend (`templates/dashboard/dashboard.js`)

5. **Add "Interrupted" branch** in the slot rendering logic (currently the `else` clause at line 115 that renders "Active"): Before rendering "Active", check `slot.liveness === "interrupted"`. If so:
   - Set CSS class to `slot-status interrupted`.
   - Render label "Interrupted" with a **resume** button (instead of start) that calls a `resumeSlot(slotNum)` function.
   - Keep the existing Done/Abandon/Postpone action buttons.

6. **Add `resumeSlot()` function**: Similar to `startSlot()` but calls `/api/slot-resume` endpoint.

### Backend API (`src/dashboard-server.ts`)

7. **Add `/api/slot-resume` endpoint**: Mirrors the existing `/api/slot-start` pattern — validates slot number, calls `slotResume(slotNum)`, returns success/error.

### Styling (`templates/dashboard/style.css`)

8. **Add `.slot-status.interrupted` styles**: Use an orange/red color (e.g., `var(--error)` or a dedicated interrupted color) for both the status indicator dot and the status text, visually distinct from "Active" green and "Assigned" yellow.

### Performance

- `process.kill(pid, 0)` is a single syscall — negligible cost.
- Reading slot state JSON files is already fast (small files, local FS).
- No subprocess spawning needed (unlike agent session checks).
- Total overhead: under 1ms for all 6 slots.
