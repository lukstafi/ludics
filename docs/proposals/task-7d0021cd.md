# Proposal: Slot stop should preserve worktrees and orchestration state when mode is manual

## Goal

When a slot is toggled from an automated adapter (tmux/t3code) to manual mode, the toggle should kill running processes but preserve worktrees, peer-sync directories, orchestration state (`slot-N.json`), and adapter-specific state. This enables resuming the session later when toggling back to the automated adapter.

## Acceptance Criteria

1. **`Adapter.stop()` accepts an optional `preserveState` flag.** When true, adapters kill processes but skip destructive cleanup (worktree removal, peer-sync deletion, orchestration state removal, adapter state removal).
2. **tmux adapter `stop()` with `preserveState: true`** kills orchestration runner PID, tmux sessions, and ttyd processes but does NOT call `removePeerSyncSession()`, `cleanupWorktrees()`, `removeOrchestrationState()`, or `removeTmuxSlotState()`.
3. **t3code adapter `stop()` with `preserveState: true`** kills orchestration runner PID and sends `thread.session.stop` but does NOT send `thread.delete`, and does NOT call `removePeerSyncSession()`, `cleanupWorktrees()`, `removeOrchestrationState()`, or `removeSlotState()`.
4. **`slotStop()` accepts and forwards `preserveState`** through `runAdapterAction()` to the adapter.
5. **`slotSetMode()` uses `preserveState` when toggling away from an automated adapter.** Instead of refusing the toggle when a session is active, it calls `slotStop(slotNum, false, true)` to kill processes while preserving state, then updates the mode. The "Session Started" field is cleared so the slot appears available for mode toggling.
6. **Manual adapter `readState()` detects preserved orchestration state.** When a `slot-N.json` exists but no manual status file is active, `readState()` returns "Paused Orchestration" status so the dashboard shows the slot as paused rather than idle.
7. **`slotResume()` works after toggle-back.** Since orchestration state, worktrees, and peer-sync are preserved, resuming after toggling back to tmux/t3code requires no changes to the resume path.
8. **Other adapters (manual, agent-claude, agent-codex, etc.) are unaffected** — the `preserveState` option is optional and defaults to false.

## Context

- **Task file:** `tasks/task-7d0021cd.md` in the harness
- **Related:** task-0655c257 (adapter toggle button in dashboard)
- **Key source files:**
  - `src/adapters/types.ts` — `Adapter` interface (line 20-26): `stop(ctx: AdapterContext): MaybePromise<string>`
  - `src/adapters/index.ts` — `runAdapterAction()` dispatch (line 31-43)
  - `src/adapters/tmux-adapter.ts` — `stop()` at line 519-545: kills processes then calls destructive cleanup
  - `src/adapters/t3code.ts` — `stop()` at line 1037-1084: kills PID, sends session.stop + thread.delete, then destructive cleanup
  - `src/adapters/manual.ts` — `stop()` at line 71-92: benign (archives notes only)
  - `src/slots/index.ts` — `slotStop()` at line 633-672, `slotSetMode()` at line 474-522, `slotResume()` at line 677+

## Approach

### 1. Extend the `Adapter` interface

Add an optional `options` parameter to `stop()` in `src/adapters/types.ts`:

```ts
stop(ctx: AdapterContext, options?: { preserveState?: boolean }): MaybePromise<string>;
```

### 2. Thread options through dispatch

Update `runAdapterAction()` in `src/adapters/index.ts` to accept and forward options:

```ts
export async function runAdapterAction(
  action: string, ctx: AdapterContext,
  options?: { preserveState?: boolean }
): Promise<string> {
  ...
  case "stop": return await adapter.stop(ctx, options);
}
```

### 3. Update `slotStop()` signature

In `src/slots/index.ts`, add `preserveState` parameter:

```ts
export async function slotStop(
  slotNum: number, force: boolean = false, preserveState: boolean = false
): Promise<void> {
  ...
  await runAdapterAction("stop", ctx, { preserveState });
}
```

### 4. Guard the destructive cleanup in tmux adapter

In `src/adapters/tmux-adapter.ts` `stop()`, wrap the cleanup block:

```ts
async function stop(ctx: AdapterContext, options?: { preserveState?: boolean }): Promise<string> {
  // ... kill processes (always) ...
  
  if (!options?.preserveState) {
    removePeerSyncSession(...);
    cleanupWorktrees(...);
    removeOrchestrationState(...);
    removeTmuxSlotState(...);
  }
}
```

### 5. Guard the destructive cleanup in t3code adapter

Same pattern in `src/adapters/t3code.ts` `stop()`. Additionally, when `preserveState` is true, send `thread.session.stop` but skip `thread.delete`.

### 6. Relax `slotSetMode()` session guard

Replace the "refuse if active session" error with a conditional preserve-stop:

```ts
if (hasActiveSession) {
  const currentMode = getMode(block).trim();
  const isAutomated = currentMode === "tmux" || currentMode === "t3code";
  if (isAutomated) {
    // Kill processes but preserve state for later resume
    await slotStop(slotNum, false, true);
    // Re-read blocks since slotStop modified the file
    // ... update mode ...
  } else {
    throw new Error(`slot ${slotNum} has an active session...`);
  }
}
```

Note: `slotSetMode()` is currently synchronous. It will need to become `async` to call `slotStop()`.

### 7. Manual adapter: detect paused orchestration

In `src/adapters/manual.ts` `readState()`, check for a preserved `slot-N.json`:

```ts
import { readOrchestrationState } from "../orchestration/state.ts";

export function readState(ctx: AdapterContext): string | null {
  // Check for preserved orchestration state (paused automated session)
  const orchState = readOrchestrationState(ctx.slot, ctx.harnessDir);
  if (orchState) {
    const md = new MarkdownBuilder();
    md.keyValue("Mode", "manual (paused orchestration)");
    md.keyValue("Paused Task", orchState.taskId);
    md.keyValue("Paused Phase", orchState.phase);
    md.keyValue("Original Backend", orchState.backend ?? "unknown");
    return md.toString();
  }
  // ... existing manual state logic ...
}
```

### 8. CLI plumbing

Add `--preserve-state` flag to the `slot N stop` CLI command so it can be invoked programmatically (e.g., from the dashboard toggle button in task-0655c257).
