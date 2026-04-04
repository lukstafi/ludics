# Remove SSH remote dispatch, rely on state repo + keepalive polling

## Goal

Eliminate all SSH-based remote execution (`remoteExec`/`remoteExecAsync`) from the federation automation loop. Replace with intent files committed to the state repo and consumed by worker keepalive polling. This removes the SSH attack surface from the automation path, simplifies error handling (no more "remote stop failed" exceptions), and makes the system fully convergent — every state transition flows through the already-robust git state sync.

## Acceptance Criteria

1. No `remoteExec` or `remoteExecAsync` calls remain in any automation code path (slots, worker-signal, federation tick).
2. `remoteExec` and `remoteExecAsync` are removed from `src/remote.ts`. `remotePing`, `isRemoteMachine`, `resolveHostname`, and `remoteLudicsPath` are retained as diagnostic/utility functions.
3. Remote slot **start** works via state repo: controller stamps metadata + pushes state; worker's existing `maybeStartDispatchedSlots()` in keepalive detects and starts the slot locally (already implemented — just remove the redundant SSH call).
4. Remote slot **stop** works via intent file: controller writes `federation/slot-intents/slot-N.json` with `{ "action": "stop", "preserveState": bool, "epoch": <unix> }`, commits+pushes, and returns immediately. Worker keepalive consumes the intent and runs `slotStop()` locally.
5. Remote slot **resume** works via intent file: controller writes `{ "action": "resume", "epoch": <unix> }`, same pattern as stop.
6. Worker keepalive includes a new `processSlotIntents()` step that reads intent files for locally-owned slots, executes valid (non-stale) intents, and deletes the files.
7. Intent files older than 10 minutes (epoch TTL) are discarded as stale and deleted without execution.
8. **Worker signals** (`worker-signals/slot-N.json`) are committed to the state repo by worker keepalive's `stateCheckpoint()` and read locally by the controller after `statePull()` — no SSH reads or clears.
9. `controllerPollWorkers()` in `src/worker-signal.ts` reads signal files from the local filesystem (same paths, after state pull) instead of via SSH. Signal clearing is done locally + committed.
10. Dashboard shows transitional states: "Stopping" when a stop intent is pending, "Starting" when Session Started is stamped but no orchestration state exists yet.
11. `slotStop()` on an already-inactive slot is a no-op (graceful handling of race between done signal and stop intent).
12. CLI `ludics slot N stop` for remote slots returns immediately after writing the intent (non-blocking).
13. Existing tests pass; new tests cover intent file write/read/consume/TTL-expiry cycle.

## Context

### Current SSH call sites (to be removed)

| Call site | File | Line | Current behavior |
|-----------|------|------|-----------------|
| Slot start | `src/slots/index.ts` | ~665 | `remoteExecAsync` fire-and-forget |
| Slot stop | `src/slots/index.ts` | ~727 | `remoteExec` synchronous, blocks |
| Slot resume | `src/slots/index.ts` | ~772 | `remoteExecAsync` fire-and-forget |
| Worker signal read | `src/worker-signal.ts` | ~79 | `remoteExec` polls remote file |
| Worker signal clear | `src/worker-signal.ts` | ~99,138 | `remoteExec` deletes remote file |

### Infrastructure already in place

- `workerKeepalive()` (`src/mag.ts:2457`) runs every 60s: does `statePull()`, `publishTerminalState()`, `maybeResumeDeadOrchestrators()`, `maybeStartDispatchedSlots()`, `stateCheckpoint()`.
- `maybeStartDispatchedSlots()` (`src/mag.ts:2482`) already detects slots dispatched to this machine with Session Started set but no orchestration state, and starts them. This makes the SSH start call redundant.
- `stateCheckpoint()` commits and pushes the harness repo. State sync is robust (rebase recovery, squash, JSONL sort per commit `e97e3a8`).
- `statePull()` runs at start of `federationTick()` and `workerKeepalive()`.

### Edge cases

- **Stale intents**: Worker offline for hours, processes old intent on comeback. Mitigated by 10-min epoch TTL.
- **Race on stop**: Done signal arrives before stop intent is processed. `slotStop()` on inactive slot must be a no-op.
- **Concurrent controllers**: During failover, both may write intents. Last-writer-wins per slot file is safe — only one intent matters at a time.
- **Push failures**: Intents/signals delayed until next successful push. Acceptable for ~1 min latency target.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Phase 1: Intent file infrastructure

1. Create `src/slot-intents.ts` with:
   - `SlotIntent` interface: `{ action: "start" | "stop" | "resume", epoch: number, preserveState?: boolean }`
   - `writeSlotIntent(slotNum, intent)`: writes to `federation/slot-intents/slot-N.json` in harness dir, creates directory if needed.
   - `readSlotIntent(slotNum)`: reads and parses intent file, returns null if missing.
   - `clearSlotIntent(slotNum)`: deletes intent file.
   - `INTENT_TTL_SECONDS = 600` (10 minutes).

2. Add `processSlotIntents()` to `src/mag.ts`:
   - Called from `workerKeepalive()` after `statePull()` but before `stateCheckpoint()`.
   - Iterates locally-owned slots, reads intent files, validates epoch freshness.
   - Dispatches: `"stop"` -> `slotStop(N, false, intent.preserveState)`, `"resume"` -> `slotResume(N)`, `"start"` -> `slotStart(N)`.
   - Clears intent file after processing (success or failure).
   - Emits events for processed/expired intents.

### Phase 2: Replace SSH dispatch in slots

3. **`src/slots/index.ts` — `slotStart()`** (line ~648-668): Remove the `remoteExecAsync` call at line 665. Keep the Session Started stamp and `stateCheckpoint` push — these are what `maybeStartDispatchedSlots()` detects. Update journal/event messages to say "remote start via state repo" instead of "remote dispatch."

4. **`src/slots/index.ts` — `slotStop()`** (line ~718-737): Replace the `remoteExec` block with: write a stop intent via `writeSlotIntent()`, call `stateCheckpoint("stop intent", { push: true })`, return immediately. Remove the error throw on remote failure (intents are best-effort, retry on next keepalive). Keep `--force` path unchanged.

5. **`src/slots/index.ts` — `slotResume()`** (line ~770-776): Replace `remoteExecAsync` with `writeSlotIntent()` + `stateCheckpoint` push.

6. Remove `remoteExec`/`remoteExecAsync` imports from `src/slots/index.ts`.

### Phase 3: Worker signals via state repo

7. **`src/worker-signal.ts` — `controllerPollWorkers()`**: Remove all `remoteExec` calls. Read signal files from the local filesystem (the paths are already local — `worker-signals/slot-N.json` in harness dir). After `statePull()` in `federationTick()`, these files reflect remote worker state. Clear signals locally with `unlinkSync` (already the `workerClearSignal` implementation) — the deletion is committed by the next `stateCheckpoint`.

8. Remove `remoteExec` import from `src/worker-signal.ts`.

### Phase 4: Clean up remote.ts

9. **`src/remote.ts`**: Remove `remoteExec` and `remoteExecAsync` exports. Keep `remotePing`, `isRemoteMachine`, `resolveHostname`, `remoteLudicsPath`, and their helpers (`sshArgs`, `SSH_CONNECT_TIMEOUT`). Keep `remotePing` using SSH — it's a diagnostic tool, not automation.

### Phase 5: Dashboard transitional states

10. **Dashboard**: Add transitional state display. When an intent file exists for a slot (detectable via the generated `slots.json` data), show "Stopping"/"Starting"/"Resuming" badge. This requires:
    - `src/dashboard.ts` to include intent file presence in slot data generation.
    - `templates/dashboard/dashboard.js` to render transitional badges.
    - `templates/dashboard/style.css` to style transitional state badges (e.g., pulsing/dimmed).

### Phase 6: Graceful edge cases

11. Make `slotStop()` a no-op when the slot has no active session (no Session Started, no orchestration state) — return early instead of throwing. This handles the race where a done signal clears the slot before a stop intent is processed.

## Scope

- **In scope**: All SSH dispatch removal, intent file system, worker signal migration, dashboard transitional states, graceful stop on inactive slots.
- **Out of scope**: `remotePing` replacement (stays SSH-based), `ludics federation ping` CLI changes, heartbeat-based liveness (already handled by task-6b3772fc).

## Files to modify

| File | Changes |
|------|---------|
| `src/slot-intents.ts` | **New** — intent file read/write/clear/TTL |
| `src/slots/index.ts` | Remove SSH dispatch, write intents instead |
| `src/worker-signal.ts` | Remove SSH reads/clears, read locally |
| `src/remote.ts` | Remove `remoteExec`, `remoteExecAsync` |
| `src/mag.ts` | Add `processSlotIntents()` to keepalive |
| `src/dashboard.ts` | Include intent presence in slot data |
| `templates/dashboard/dashboard.js` | Render transitional state badges |
| `templates/dashboard/style.css` | Style transitional badges |
