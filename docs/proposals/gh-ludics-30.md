# Proposal: Fix Slot Lifecycle — Skip Abandoned Tasks, Auto-clear Done Slots, Remove Throttle

**GitHub issue:** lukstafi/ludics#30
**Task file:** `tasks/gh-ludics-30.md`
**File to modify:** `src/mag.ts`

---

## Problem Summary

Three related slot lifecycle bugs in `src/mag.ts`:

1. **`maybeQueueProposals()` re-queues abandoned/done tasks.** When a slot is cleared as
   `abandoned` or `done`, the task file remains on disk. The next keepalive cycle finds the
   occupied slot entry in `slots.md` still has a `process` value... actually, the slot *is*
   cleared, but the function iterates tasks in *occupied* slots and only checks whether the task
   file has a `proposal:` line — it never checks the task's `status`. If the slot was
   subsequently re-occupied with a different task whose file also lacks a `proposal:`, that
   triggers a new request. But more directly: a task that was cleared by status but whose file
   lacks `proposal:` can still appear in the loop if the slot block briefly lingers, or the
   check finds the wrong task. The root cause is the absence of a status guard.

2. **Done tasks are never auto-cleared.** When a worker marks a task `done` in its file but the
   slot is not explicitly cleared, the slot stays occupied forever. `maybeFillEmptySlots()` only
   sees empty slots; it cannot fill a slot that is still shown as occupied even though its task
   is done.

3. **`proposalThrottled()` over-throttles.** A shared 30-minute timestamp file blocks both
   `maybeQueueProposals()` and `maybeFillEmptySlots()`. When one function writes the timestamp,
   the other is blocked for 30 minutes, preventing prompt slot filling. The "1 slot per
   keepalive cycle" limit inside `maybeFillEmptySlots()` already provides sufficient rate
   control.

---

## Scope of Changes

### Scope 1 — Status filtering in `maybeQueueProposals()`

**Location:** `src/mag.ts`, function `maybeQueueProposals()`, lines 1676–1691.

After reading the task file content (line 1687), add a status check before the proposal check:

```typescript
// Before (lines 1684–1690):
    // Read task file — queue draft if it has no proposal yet
    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");
    if (content.includes("\nproposal:")) continue;

    candidates.push(taskId);

// After:
    // Read task file — skip terminal statuses, queue draft if no proposal yet
    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");
    // Skip tasks that have reached a terminal status; clearing a slot updates the
    // task file status, so this prevents re-queuing for abandoned/done/completed tasks.
    const statusMatch = content.match(/^status:\s*(.+)$/m);
    const taskStatus = statusMatch ? statusMatch[1]!.trim() : "ready";
    if (["abandoned", "done", "completed"].includes(taskStatus)) continue;
    if (content.includes("\nproposal:")) continue;

    candidates.push(taskId);
```

Remove the throttle timestamp write at lines 1695–1697 (covered by Scope 3).

### Scope 2 — New `maybeClearDoneSlots()` function

**Location:** `src/mag.ts`, insert new function after `maybeFillEmptySlots()` (around line 1814),
and call it in the keepalive path (around line 1879) **before** `maybeFillEmptySlots()`.

```typescript
// --- Auto-clear slots whose task reached done/completed status ---

function maybeClearDoneSlots(): void {
  if (startSessionsAutonomy() === "manual") return;

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  for (const [slotNum, block] of blocks) {
    const process = getProcess(block).trim();
    if (!process || process === "(empty)") continue;

    const taskId = getTask(block).trim();
    if (!taskId || taskId === "null") continue;

    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;

    const content = readFileSync(taskFile, "utf-8");
    const statusMatch = content.match(/^status:\s*(.+)$/m);
    const taskStatus = statusMatch ? statusMatch[1]!.trim() : "";

    if (taskStatus === "done" || taskStatus === "completed") {
      // Task reached a terminal status — auto-clear the slot so it can be refilled
      console.error(`ludics: auto-clearing slot ${slotNum} (task ${taskId} is ${taskStatus})`);
      emitEvent({
        event_type: "slot_auto_clear",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        status: taskStatus,
        message: `auto-cleared slot ${slotNum}: task ${taskId} reached status=${taskStatus}`,
      });
      slotClear(slotNum, taskStatus);
    }
  }
}
```

**Keepalive call site** — replace lines 1878–1882:

```typescript
// Before:
    // Auto-queue proposals for elaborated leaf tasks already in slots
    maybeQueueProposals();

    // Auto-fill empty slots with ready elaborated tasks
    maybeFillEmptySlots();

// After:
    // Auto-queue proposals for elaborated leaf tasks already in slots
    maybeQueueProposals();

    // Auto-clear slots whose task reached done/completed status
    maybeClearDoneSlots();

    // Auto-fill empty slots with ready elaborated tasks
    maybeFillEmptySlots();
```

### Scope 3 — Remove `proposalThrottled()` and related code

The following items are entirely removed:

**Remove constant (line 1638):**
```typescript
// Remove:
const PROPOSAL_THROTTLE_SECONDS = 1800; // 30 minutes between proposal queuing
```

**Remove functions (lines 1640–1653):**
```typescript
// Remove:
function proposalThrottleFile(): string {
  return join(magStateDir(), "last-proposal-queue.epoch");
}

function proposalThrottled(): boolean {
  const file = proposalThrottleFile();
  if (!existsSync(file)) return false;
  try {
    const lastEpoch = parseInt(readFileSync(file, "utf-8").trim(), 10);
    return (Math.floor(Date.now() / 1000) - lastEpoch) < PROPOSAL_THROTTLE_SECONDS;
  } catch {
    return false;
  }
}
```

**Remove throttle guard from `maybeQueueProposals()` (line 1657):**
```typescript
// Remove:
  if (proposalThrottled()) return;
```

**Remove throttle guard from `maybeFillEmptySlots()` (line 1709):**
```typescript
// Remove:
  if (proposalThrottled()) return;
```

**Remove throttle timestamp write from `maybeQueueProposals()` (lines 1695–1697):**
```typescript
// Remove:
  // Write throttle timestamp
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(proposalThrottleFile(), String(Math.floor(Date.now() / 1000)));
```

**Remove throttle timestamp write from `maybeFillEmptySlots()` (lines 1806–1808):**
```typescript
// Remove:
  // Write throttle timestamp (shared with maybeQueueProposals)
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(proposalThrottleFile(), String(Math.floor(Date.now() / 1000)));
```

The "1 slot per keepalive cycle" limit at line 1796 (`// Fill at most 1 empty slot per keepalive cycle`) remains as the sole rate control for slot filling.

---

## Complete Diff Overview

```
src/mag.ts
  - Remove PROPOSAL_THROTTLE_SECONDS constant (~line 1638)
  - Remove proposalThrottleFile() function (~lines 1640–1642)
  - Remove proposalThrottled() function (~lines 1644–1653)
  - maybeQueueProposals():
      - Remove `if (proposalThrottled()) return;` (~line 1657)
      - Add status guard after reading task file (~line 1688)
      - Remove throttle timestamp write (~lines 1695–1697)
  - maybeFillEmptySlots():
      - Remove `if (proposalThrottled()) return;` (~line 1709)
      - Remove throttle timestamp write (~lines 1806–1808)
  + Add maybeClearDoneSlots() function (~after line 1814)
  - Keepalive path (~line 1879):
      + Add maybeClearDoneSlots() call before maybeFillEmptySlots()
```

---

## Testing / Verification

1. **Status filtering**: Assign a task to a slot, mark the task file `status: abandoned`, run
   `ludics mag keepalive`. Confirm no new `draft-proposal` entry appears in `mag/queue.jsonl`.

2. **Auto-clear done slots**: Assign a task to a slot, mark the task file `status: done`, run
   `ludics mag keepalive`. Confirm the slot is cleared in `slots.md` and a
   `slot_auto_clear` event appears in `journal/events.jsonl`.

3. **Auto-fill after auto-clear**: With a ready elaborated task available, run the keepalive
   again after step 2. Confirm the newly emptied slot is filled and `draft-proposal` is queued
   for the new task.

4. **No double-fill**: Confirm only 1 slot is filled per keepalive cycle even when multiple
   empty slots exist (existing "1 slot per cycle" guard).

5. **Throttle removed**: Confirm `mag/last-proposal-queue.epoch` is no longer written or read.
   Existing file can be left on disk; it is harmless once the functions are removed.

---

## Risk Assessment

- **Low risk**: All changes are additive guards or removals of overly-conservative throttles.
- The status regex `content.match(/^status:\s*(.+)$/m)` is already used identically in
  `maybeFillEmptySlots()` (line 1757) — no new parsing logic is introduced.
- `slotClear()` already handles journal, event emission, and `pruneBlockedBy` — no
  duplication needed in `maybeClearDoneSlots()`.
- The `magStateDir()` `mkdirSync` calls removed from the throttle writes are still present
  elsewhere; no directory creation is lost.
