# Delay cleanup of completed slot artifacts by 25-48h for post-mortem window

## Goal

Split slot cleanup into two phases so that worktrees, branches, tmux sessions, and peer-sync dirs remain available for 25+ hours after task completion, enabling post-mortem debugging. Currently all artifacts are destroyed immediately when a slot stops, leaving no window for inspection.

Additionally, delete feature branches (local and remote) that today accumulate indefinitely, and make the session sweeper less aggressive so it does not delete t3code threads created manually outside Ludics.

Ref: https://github.com/lukstafi/ludics/issues/153

## Acceptance Criteria

1. When a slot stops with `preserveState = false`, the adapter records a cleanup manifest entry in `mag/cleanup-pending.json` instead of immediately removing worktrees, killing tmux sessions, deleting peer-sync dirs, or deleting branches. Orchestration state files and runner PIDs are still cleaned up immediately (needed for slot reuse).

2. A new `processDeferredCleanups()` function is called from `briefingPrecomputeContext()`. It processes manifest entries older than `mag.cleanup_delay_hours` (default 25, max 72) by: removing git worktrees, deleting local feature branches (`git branch -D`), deleting remote feature branches (`git push origin --delete`, best-effort), killing tmux sessions, and removing peer-sync symlinks.

3. Processed entries are removed from the manifest. Entries that fail are logged but retained for retry at next briefing.

4. When `slotResume()` is called for a task+slot that has a pending cleanup entry, that entry is cancelled (removed from the manifest) so the resumed session keeps its artifacts.

5. The manifest file `mag/cleanup-pending.json` is an array of `CleanupEntry` objects. Each entry contains: `timestamp` (ISO), `projectDir`, `taskId`, `slot`, `agents` (array of `{name}`), `mode` ("duo"|"pair"), `branches` (record of branch names), `worktreePaths` (array), `tmuxSessionNames` (array), `peerSyncLink` (string|null).

6. Config key `mag.cleanup_delay_hours` in `config.yaml` controls the delay threshold. Default 25 hours if unset. Values above 72 are capped to 72.

7. The t3code adapter `stop()` applies the same deferral pattern: thread deletion commands are deferred (recorded in the manifest with a `t3codeThreadIds` field), while session stop commands still execute immediately.

8. The session sweeper (`sessions/sweep.ts`) does not delete t3code threads whose names do not match the Ludics naming convention (i.e., threads that were created manually outside Ludics). Specifically, only threads registered via `registerKnownSessions()` are eligible for sweep cleanup (this is already the case via the `knownSessionStillPresent` guard, but the sweeper must also skip any t3code thread whose `name`/`threadId` is not present in the sweep state -- i.e., unknown threads are never harvested).

## Context

### Current cleanup flow

**`slotClear()` (`src/slots/index.ts:265`)** handles slot-state cleanup (slots.md, orchestration JSON, task frontmatter). This is Phase 1 and remains unchanged.

**Adapter `stop()` functions** (`src/adapters/tmux-adapter.ts:521`, `src/adapters/t3code.ts:1024`) handle artifact cleanup:
- tmux: `killTmuxSessionsForSlot()`, `removePeerSyncSession()`, `cleanupWorktrees()`, `removeOrchestrationState()`
- t3code: thread deletion via `thread.delete` command, then same worktree/peer-sync cleanup

Both adapters already skip artifact cleanup when `preserveState` is true (manual mode toggle, resume, preempt stash).

**`briefingPrecomputeContext()` (`src/mag.ts:1351`)** runs daily before briefing generation. Already calls `cleanupDoneTaskThreads()` -- the deferred cleanup call fits naturally alongside it.

**`cleanupWorktrees()` (`src/orchestration/worktrees.ts:203`)** removes git worktrees but does not delete branches. Branch names follow the pattern `ludics/<slug><slotSuffix>/root` and `ludics/<slug><slotSuffix>/<agent>`.

**Session sweeper (`src/sessions/sweep.ts`)** tracks known sessions via sweep-state.json. Its safety model already prevents harvesting unknown sessions (line 4-6 comment), but the t3code `thread.delete` path in the adapter bypasses this -- the proposal ensures deferred t3code cleanup also respects this boundary.

### Key data available at stop time

The adapter `stop()` functions have access to `orchState` which provides `projectDir`, `taskId`, `agents[]`, `mode`, `peerSyncDir`. Branch names are reconstructible from taskId + slot using the convention in `createWorktrees()`. Tmux session names are reconstructible from `tmuxSessionName(slot, agentName, taskId)`.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

### A. New module: `src/orchestration/deferred-cleanup.ts`

Types and functions for the deferred cleanup system:

```typescript
interface CleanupEntry {
  timestamp: string;          // ISO, when recorded
  projectDir: string;
  taskId: string;
  slot: number;
  agents: Array<{ name: string }>;
  mode: "duo" | "pair";
  branches: Record<string, string>;   // agent/root -> branch name
  worktreePaths: string[];
  tmuxSessionNames: string[];
  peerSyncLink: string | null;
  t3codeThreadIds?: string[];         // only for t3code adapter
}
```

Functions:
- `recordDeferredCleanup(entry: CleanupEntry)`: read manifest, append entry, atomic write (tmp + rename pattern, same as sweep-state.ts).
- `cancelDeferredCleanup(taskId: string, slot: number)`: remove matching entries from manifest.
- `processDeferredCleanups(thresholdHours?: number)`: load manifest, filter entries older than threshold, execute cleanup for each (worktree removal, branch deletion local+remote, tmux kill, peer-sync removal, t3code thread deletion). Rewrite manifest with unprocessed + failed entries. Log results.
- `deleteBranches(projectDir: string, branches: string[])`: delete local branches with `git branch -D`, then remote with `git push origin --delete` (best-effort, log failures but don't throw).

### B. Modify `src/adapters/tmux-adapter.ts` stop function (line 538-544)

Replace the direct cleanup calls in the `!preserveState` block:

```typescript
// Before (lines 541-543):
removePeerSyncSession(orchState.projectDir, orchState.taskId, ctx.slot);
cleanupWorktrees(orchState.projectDir, orchState.taskId, orchState.agents, ctx.slot, orchState.mode);
removeOrchestrationState(ctx.slot, ctx.harnessDir);

// After:
recordDeferredCleanup({
  timestamp: new Date().toISOString(),
  projectDir: orchState.projectDir,
  taskId: orchState.taskId,
  slot: ctx.slot,
  agents: orchState.agents,
  mode: orchState.mode,
  branches: orchState.branches ?? {},
  worktreePaths: collectWorktreePaths(orchState),
  tmuxSessionNames: orchState.agents.map(a => tmuxSessionName(ctx.slot, a.name, orchState.taskId)),
  peerSyncLink: peerSyncPath(orchState.projectDir, orchState.taskId, ctx.slot),
});
removeOrchestrationState(ctx.slot, ctx.harnessDir);  // still immediate
```

The `killTmuxSessionsForSlot()` call (line 539) remains immediate -- it stops agent processes but leaves tmux sessions. The deferred cleanup will call `tmux kill-session` later. Alternatively, if tmux sessions should stay visible for post-mortem, move `killTmuxSessionsForSlot()` into deferred cleanup too. The task elaboration implies tmux sessions should be deferred ("kill tmux sessions" is listed under Phase 2).

### C. Modify `src/adapters/t3code.ts` stop function (line 1050-1068)

Similarly defer worktree/peer-sync cleanup. For t3code thread deletion: keep `thread.session.stop` immediate (stops the agent), but defer `thread.delete` by recording thread IDs in the manifest entry's `t3codeThreadIds` field.

### D. Modify `src/mag.ts` `briefingPrecomputeContext()` (line 1351+)

Add after the `cleanupDoneTaskThreads()` call:

```typescript
await cleanupDoneTaskThreads();
await processDeferredCleanups();  // new
```

### E. Modify slot resume to cancel pending cleanup

In the slot resume path (wherever `slotResume()` reattaches a stashed slot), call `cancelDeferredCleanup(taskId, slot)` to prevent the deferred cleanup from destroying artifacts that the resumed session needs.

### F. Config: `mag.cleanup_delay_hours`

Read from config in `processDeferredCleanups()`. Pattern: same as existing config reads in `src/config.ts`. Default 25, cap at 72.

### G. Session sweeper safety for manual t3code threads

The sweeper already only targets sessions in its known-sessions registry. Verify that the `runSessionSweep` -> `detachedToCleanup` path cannot reach a t3code thread that was never registered via `registerKnownSessions()`. The current code in `sweep.ts` line 190 calls `knownSessionStillPresent()` which checks the snapshot -- if a manually-created thread exists in the snapshot but is not in `state.sessions`, it will be in neither `attachedKeys` nor `state.sessions`, so the loop at line 188 will never encounter it. This is already safe. Add a comment documenting this invariant.

### Edge cases to handle

- **Multiple cleanups for same slot**: entries keyed by (taskId, slot, timestamp) -- multiple entries can coexist.
- **Crash recovery**: manifest persists on disk, processed at next briefing.
- **Federation**: each machine records its own manifest. Controller only does slot-state cleanup.
- **Force stop**: deferred cleanup still recorded for local artifacts even when remote exec is skipped.
- **Stale worktrees already gone**: `removeIfRegistered()` in worktrees.ts is already idempotent. Branch deletion should similarly be idempotent (ignore "not found" errors).
