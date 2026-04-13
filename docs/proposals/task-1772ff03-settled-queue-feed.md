# Proposal: Replace Mag nudge+queue-pop mechanism with settled-aware queue feed

**Task:** task-1772ff03
**Date:** 2026-04-13

## Goal

Replace the current nudge → stop-hook → queue-pop cycle with a settled-aware queue feed that delivers queue items directly when Mag is idle, eliminating "Continue previous work" noise.

## Acceptance Criteria

1. Mag stop hook no longer pops the queue — it writes a settled sentinel instead.
2. A queue feed loop (in keepalive or separate) detects settled + non-empty queue, pops one item, and delivers it as a skill command to Mag's tmux session.
3. "Continue previous work" nudges are removed — replaced by stall detection that only nudges when Mag's terminal output hasn't advanced for a configurable duration without reaching settled state.
4. Queue items are still processed in order; no items are lost or duplicated.
5. `bun run build` succeeds, all tests pass.

## Context

### Current flow

1. Keepalive nudge (mag.ts:2672-2685): sends "Continue previous work" when queue has a skill-requiring item and `nudgeThrottled()` allows it.
2. Mag runs an idle turn → stop hook fires.
3. Stop hook (ludics-on-stop.sh:115): calls `ludics mag queue-pop` which pops queue head, returns slash command as stop-hook block.
4. Mag executes the skill command.

Problem: dozens of idle nudges per day; no awareness of whether Mag is mid-task or idle.

### Target flow (like tmux adapter)

1. Stop hook writes settled sentinel (no queue pop).
2. Queue feed loop detects settled + queue non-empty → pops item, sends to Mag's tmux session.
3. Stall detection (pane hash diffing) nudges only if Mag's terminal stalls without reaching settled state.

### Tmux adapter precedent

`refreshAgentTransportState()` (transport-tmux.ts:72-140) implements a `dispatched → running → settled` state machine using stop-hook records, done status + pane staleness, and process liveness. `tmuxPaneOutputHash()` (tmux-adapter.ts:312-318) captures last 50 lines of pane + MD5 for change detection.

## Approach

### 1. Mag settled sentinel (replace queue-pop in stop hook)

**ludics-on-stop.sh:115**: Change from `exec "$ludics_bin" mag queue-pop "$cwd" "$hook_event_name"` to `exec "$ludics_bin" mag on-stop "$cwd" "$hook_event_name"`.

**New `mag on-stop` handler** (mag.ts): Write `mag/last-stop-hook.epoch` (already exists) + `mag/settled` sentinel. Do NOT pop the queue. Keep existing guards (paused check, controller check).

### 2. Queue feed loop (integrate into keepalive)

Replace the nudge block (mag.ts:2672-2685) with a settled-aware queue feed:

```typescript
// In keepalive cycle:
if (existsSync(settledPath) && queuePending()) {
  unlinkSync(settledPath); // Mark as "running"
  const command = await queuePopSkill();
  if (command) {
    triggerSkill(MAG_SESSION_NAME, command);
  }
}
```

When Mag is not settled and queue has items: monitor pane hash for advancement. Only nudge if pane hasn't changed for `STALL_THRESHOLD` seconds (reuse `tmuxPaneOutputHash()` pattern).

### 3. Stall detection for Mag session

Add Mag-specific pane monitoring in keepalive, similar to `refreshAgentTransportState()`:

```typescript
const currentHash = tmuxPaneOutputHash(MAG_SESSION_NAME);
if (currentHash !== lastMagPaneHash) {
  lastMagPaneHashAt = Date.now();
  lastMagPaneHash = currentHash;
}
const stallDuration = Date.now() - lastMagPaneHashAt;
if (stallDuration > STALL_THRESHOLD_MS && !existsSync(settledPath)) {
  // Mag is stalled mid-task — nudge
  triggerSkill(MAG_SESSION_NAME, "Continue previous work if any.");
}
```

### 4. Remove nudge infrastructure

- Remove `nudgeThrottled()` (mag.ts:172-183) and the nudge block in keepalive.
- Remove `mag/last-nudge.epoch` file management.
- Keep `triggerSkill()` — still used for stall nudges and queue feed delivery.

### 5. Backward compatibility

- `queuePopSkill()` (mag.ts:1081-1101) stays as-is — now called from queue feed instead of stop hook.
- `dequeueQueueHead()` / `queuePop()` stay as-is.
- `mag/current-request-id` still written by `queuePopSkill()`.

### Files to modify

- `templates/hooks/ludics-on-stop.sh` — change Mag path from `queue-pop` to `on-stop`
- `src/mag.ts` — new `mag on-stop` handler, replace nudge block with settled-aware queue feed, add pane hash stall detection, remove `nudgeThrottled()`
- `src/adapters/tmux-adapter.ts` — export `tmuxPaneOutputHash()` if not already exported

### Files NOT modified

- `src/queue.ts` — queue primitives unchanged
- `src/orchestration/transport-tmux.ts` — agent transport unchanged (Mag is not an orchestrated agent)
