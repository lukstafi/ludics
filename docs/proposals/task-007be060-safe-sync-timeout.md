# Proposal: Add optional timeout parameter to safeSyncOutput

**Task:** task-007be060
**Date:** 2026-04-09

## Goal

Extend `safeSyncOutput` in `src/spawn.ts` to accept an optional `timeout` parameter so that all production `Bun.spawnSync` callers can go through the single helper, eliminating the two documented bypasses in `dashboard.ts` and `health.ts`.

## Acceptance Criteria

1. `safeSyncOutput` opts type includes `timeout?: number`.
2. `SyncResult` includes `timedOut: boolean` (always present, default `false`).
3. When timeout fires (`exitCode === null`), result is `{ ok: false, exitCode: -1, timedOut: true, stdout: <captured>, stderr: "process timed out" }`.
4. `dashboard.ts` doctor check (~line 1013-1032) replaced with `safeSyncOutput(ludicsSelfCommand(["doctor"]), { timeout: 10_000 })`.
5. `health.ts` test runner (~line 107-112) replaced with `safeSyncOutput(["sh", "-c", testCmd], { cwd: projectPath, timeout: 300_000 })`.
6. Existing callers without timeout continue to work unchanged (no breaking change).
7. A test in `src/spawn.test.ts` spawns `sleep 10` with a short timeout (~200ms) and asserts `ok: false, timedOut: true`.

## Context

The convention comment at `src/spawn.ts:1` states all production `Bun.spawnSync` calls must go through `safeSyncOutput`. Two callers bypass it solely because it lacks timeout:

- **`src/dashboard.ts:1013-1032`** — Dashboard doctor check, 10s timeout. Currently duplicates pipe setup and error handling.
- **`src/health.ts:107-124`** — Test health runner, 300s timeout. Checks `exitCode === null` to detect timeout, prepends "timeout after 300s" to failure output.

The only other direct `Bun.spawnSync` caller (`mag.ts` terminal attach with inherited stdio) is the documented exception.

### Current signatures

```typescript
// src/spawn.ts
export interface SyncResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function safeSyncOutput(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; trim?: boolean },
): SyncResult
```

## Approach

### 1. `src/spawn.ts` — extend helper (~8 lines changed)

- Add `timeout?: number` to opts type.
- Add `timedOut: boolean` to `SyncResult`.
- Pass `timeout` through to `Bun.spawnSync`.
- After spawn, detect `result.exitCode === null` (Bun's signal that the process was killed by timeout): return `{ ok: false, exitCode: -1, timedOut: true, stdout: <captured>, stderr: "process timed out" }`.
- Normal path sets `timedOut: false`.

### 2. `src/dashboard.ts` — migrate doctor check (~10 lines removed, ~5 added)

Replace the direct `Bun.spawnSync` block (lines 1013-1032) with:
```typescript
const result = safeSyncOutput(ludicsSelfCommand(["doctor"]), { timeout: 10_000 });
```
Map `result.ok` / `result.stdout` / `result.stderr` to the existing `output` variable using the same logic (include stdout in failure details).

### 3. `src/health.ts` — migrate test runner (~6 lines changed)

Replace the direct `Bun.spawnSync` block (lines 107-112) with:
```typescript
const proc = safeSyncOutput(["sh", "-c", testCmd], { cwd: projectPath, timeout: 300_000, trim: false });
```
Use `proc.timedOut` instead of `proc.exitCode === null` for the timeout detection branch.

### 4. `src/spawn.test.ts` — new test file (~15 lines)

Single test: spawn `["sleep", "10"]` with `timeout: 200`, assert `ok === false`, `timedOut === true`, `exitCode === -1`.
