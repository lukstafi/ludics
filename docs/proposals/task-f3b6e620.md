# Proposal: Fix orchestration runners dying silently after auto-start

**Task:** task-f3b6e620
**Date:** 2026-04-03

## Goal

Ensure orchestration runner subprocesses survive parent process exit when spawned via keepalive auto-start, so that phase transitions proceed without manual intervention.

## Acceptance Criteria

- Orchestration runners spawned by any code path (auto-start, resume, manual) survive parent process exit by running in their own session (via `setsid`).
- `maybeResumeDeadOrchestrators()` covers both tmux and t3code modes, so dead runners are auto-resumed regardless of adapter.
- Dashboard correctly shows runner status as "interrupted" (not stale "Active") when the runner PID is dead.
- Runner logs contain a startup banner line so "never ran" is distinguishable from "ran briefly then crashed."

## Context

**Root cause:** `startOrchestrationProcess()` in `src/orchestration/process.ts` spawns the runner via `Bun.spawn()` + `unref()` without creating a new process session. When the parent (keepalive CLI) exits, the runner receives SIGHUP and dies. Evidence: all 6 slots had dead runners with completely empty log files on 2026-04-02.

**Existing precedent:** The t3code server spawn in `src/t3code/server.ts:311-317` already wraps commands in `setsid` (Linux binary or macOS perl fallback) to isolate the server from parent signals. This pattern works and should be reused.

**Cascading damage:** Dead runners cause stale `phaseStartedAt` timestamps, which triggers 600s plan-review timeouts and interacts with the gh-ludics-122 bug (stale status treated as timeout/approve).

### Key files

| File | Relevance |
|------|-----------|
| `src/orchestration/process.ts` | `startOrchestrationProcess()` — the spawn call to fix |
| `src/orchestration/util.ts` | Shared utilities — destination for extracted `setsidWrap()` |
| `src/t3code/server.ts:311-317` | Existing `setsid` pattern to extract and reuse |
| `src/mag.ts:2274-2347` | `maybeResumeDeadOrchestrators()` — t3code-only, needs tmux support |
| `src/dashboard.ts:53-62` | Runner liveness check — already correct (checks PID, returns "alive"/"interrupted") |

## Approach

### 1. Extract shared `setsidWrap()` helper

Add a `setsidWrap(command: string[]): string[]` function to `src/orchestration/util.ts`:
- If `Bun.which("setsid")` returns a path, prepend it to the command array.
- Otherwise, use the perl POSIX setsid fallback: `["perl", "-e", "use POSIX qw(setsid); setsid(); exec @ARGV", "--", ...command]`.

### 2. Apply setsid in `startOrchestrationProcess()`

In `src/orchestration/process.ts`:
- Import `setsidWrap` from `./util.ts`.
- Wrap the command passed to `Bun.spawn()` with `setsidWrap()`.
- Add a startup banner write to the log file (timestamp + PID) before the sleep check, so empty logs unambiguously mean "never ran."

### 3. Refactor t3code server spawn to use shared helper

In `src/t3code/server.ts`:
- Replace the inline setsid logic (lines 311-317) with a call to `setsidWrap()` imported from `src/orchestration/util.ts`.

### 4. Extend `maybeResumeDeadOrchestrators()` to tmux mode

In `src/mag.ts`:
- Remove the `if (mode !== "t3code") continue;` guard at line 2291.
- The rest of the function already handles both modes correctly: it reads orchestration state, checks PID liveness, and calls `slotResume()`. The PID source differs by mode (lines 53-60 in dashboard.ts show both paths exist), but `readSlotState()` already reads orchestration PID for t3code and `readTmuxSlotState()` for tmux. Unify the PID lookup to check both state sources based on mode.

### 5. No changes needed to dashboard

The dashboard runner status logic (`src/dashboard.ts:53-62`) already checks PID liveness for both t3code and tmux modes and returns "alive" or "interrupted" correctly. No changes needed.

### Scope exclusions

- SIGHUP handler in the runner itself: not needed given setsid provides full isolation.
- Dashboard server spawn (`src/init.ts`): out of scope for this task, can be a follow-up.
- Rate-limit changes for `maybeResumeDeadOrchestrators()`: current 1-per-invocation limit is acceptable since keepalive runs every 60s, recovering all 6 slots in 6 minutes worst case.
