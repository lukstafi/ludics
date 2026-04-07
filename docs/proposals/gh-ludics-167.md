# Audit Bun.spawnSync callers for resilience and extract safeSyncOutput helper

## Goal

Extract a shared `safeSyncOutput` helper that wraps `Bun.spawnSync` with try/catch and structured output, then migrate all ~137 raw call sites across the codebase to use it consistently.

## Acceptance Criteria

1. A new `src/spawn.ts` module exports `safeSyncOutput(cmd, opts?)` that never throws — on ENOENT or other spawn errors it returns `{ ok: false, exitCode: -1, stdout: "", stderr: "<error message>" }`.
2. All five existing module-local wrappers (`runGit`, `maybeGit`, `gitOutput`, `run` in `state.ts`, `run` in `tmux.ts`) are refactored to use `safeSyncOutput` internally, preserving their current return-type contracts.
3. All raw `Bun.spawnSync` call sites in production code (`src/**/*.ts`, excluding test files) are migrated to `safeSyncOutput` or one of the consolidated git/tmux helpers.
4. The specific bug from retrospectives is fixed: `addWorktree` in `src/orchestration/worktrees.ts` line 98 wraps the raw `Bun.spawnSync(["git", "show-ref", ...])` call through `runGit`/`maybeGit` or `safeSyncOutput`.
5. A test file `src/spawn.test.ts` verifies that `safeSyncOutput` returns `{ ok: false }` without throwing when given a nonexistent command or invalid path (the exact scenario from retrospectives: call cleanup on a deleted directory).
6. No existing tests regress; the production build (`bun run build`) succeeds.
7. `Bun.spawnSync` is no longer called directly outside of `src/spawn.ts` (enforced by a comment/convention; optionally by a lint rule if feasible).

## Context

### Problem

Five retrospectives (task-40f283bd, task-c8b663b4, task-7d0021cd, gh-ludics-121, task-bc2c634f) flagged that `Bun.spawnSync` throws `ENOENT` when the executable is not found on PATH or when `cwd` does not exist. This causes cascading failures in orchestration and slot management. The specific known-buggy site is `addWorktree` in `src/orchestration/worktrees.ts:98`.

### Existing duplicated wrappers

| Location | Function | Return type | try/catch on spawn |
|---|---|---|---|
| `src/orchestration/worktrees.ts:13` | `runGit(dir, args)` | `string` (throws on nonzero exit) | No — can ENOENT |
| `src/orchestration/worktrees.ts:26` | `maybeGit(dir, args)` | `string` (empty on failure) | Yes |
| `src/orchestration/skills.ts:34` | `gitOutput(cwd, args)` | `string\|null` | Yes |
| `src/state.ts:7` | `run(cmd, cwd)` | `{ success, stdout }` | No — can ENOENT |
| `src/adapters/tmux.ts:3` | `run(args)` | `{ exitCode, stdout, stderr }` | No — can ENOENT |

None are exported as a shared utility; all are module-local duplicates.

### Call site survey (production code, 137 total)

| File | Raw calls | Risk |
|---|---|---|
| `src/triggers.ts` | ~40 | Low — launchctl/systemctl, fire-and-forget |
| `src/mag.ts` | ~25 | High — process management (pgrep/kill/which/sleep), runs in core loop |
| `src/state.ts` | ~9 | Medium — git on state repo, uses local `run()` without try/catch |
| `src/dashboard-server.ts` | 6 | Low — all inside try/catch blocks |
| `src/orchestration/github.ts` | 6 | Low — all inside try/catch blocks |
| `src/orchestration/worktrees.ts` | 3 raw + helpers | Medium — `runGit`/`maybeGit` + one unguarded raw call in `addWorktree` |
| `src/adapters/tmux-adapter.ts` | ~9 | Medium — tmux send-keys, no try/catch |
| `src/adapters/tmux.ts` | 2 | Low — local `run()` covers the tmux calls |
| `src/adapters/base.ts` | 1 | Low |
| `src/adapters/agent-session.ts` | 2 | Medium — cleanup commands with potentially invalid paths |
| `src/init.ts` | 4 | Low — mostly which/pgrep |
| `src/t3code/server.ts` | 4 | Low — 3 already in try/catch |
| `src/tasks/sync.ts` | 3 | Medium — gh CLI calls |
| `src/orchestration/skills.ts` | 2 | Low — both in try/catch |
| `src/orchestration/transport-tmux.ts` | 3 | Low — tmux send-keys, failure harmless |
| `src/sessions/sweep.ts` | 1 | Medium — cleanup command on potentially-gone path |
| `src/federation.ts` | 2 | Low — hostname/tmux has-session |
| `src/network.ts` | 3 | Low — which/tailscale, one in try/catch |
| `src/notify.ts` | 3 | Low — curl, one in try/catch |
| `src/slots/index.ts` | 2 | Medium — tmux/lsof |
| `src/index.ts` | 4 | Medium — mixed uses |
| `src/dashboard.ts` | 3 | Low — mostly pgrep/tmux |

### Proposed `safeSyncOutput` interface

```typescript
// src/spawn.ts

export interface SyncResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a command synchronously, never throws.
 *  On ENOENT or any spawn error, returns ok:false with exitCode:-1.
 */
export function safeSyncOutput(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): SyncResult {
  try {
    const result = Bun.spawnSync(cmd, {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: opts?.env ?? (process.env as Record<string, string>),
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}
```

## Approach

### Step 1: Create `src/spawn.ts`

Write the module with `safeSyncOutput` and `SyncResult` as above. No dependencies on other ludics modules.

### Step 2: Fix the known bug

In `src/orchestration/worktrees.ts:98`, replace the raw `Bun.spawnSync(["git", "show-ref", ...])` call with `safeSyncOutput` (or delegate through the local `runGit`/`maybeGit` helpers once they are updated in Step 3). This is the highest-priority fix.

### Step 3: Refactor existing module-local wrappers

Update all five wrappers to use `safeSyncOutput` internally, preserving their public API contracts:
- `runGit`: call `safeSyncOutput`, check `ok`, throw `Error(result.stderr)` on failure (unchanged behavior; now protected against ENOENT).
- `maybeGit`: call `safeSyncOutput`, return `result.stdout` or `""` — try/catch block replaced by built-in protection.
- `gitOutput` in `skills.ts`: similar to `maybeGit`, now backed by `safeSyncOutput`.
- `run` in `state.ts`: return `{ success: result.ok, stdout: result.stdout }`.
- `run` in `adapters/tmux.ts`: return `{ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }`.

Export `runGit` from `src/spawn.ts` or keep it local to `worktrees.ts` — either is acceptable; the key requirement is no raw `Bun.spawnSync` outside `spawn.ts`.

### Step 4: Migrate remaining call sites

Replace all remaining raw `Bun.spawnSync` calls with `safeSyncOutput`. Most fire-and-forget calls (triggers.ts, tmux-adapter.ts, mag.ts signal commands) simply call `safeSyncOutput` and ignore the result. Calls that already inspect `exitCode` or `stdout` use the fields from `SyncResult` directly.

For calls using non-pipe stdio (e.g., `mag.ts:2976` `tmux attach` with `stdio: ["inherit", "inherit", "inherit"]`), `safeSyncOutput` is not appropriate — wrap directly in try/catch with a comment explaining the exception.

### Step 5: Tests

Write `src/spawn.test.ts` with:
- `safeSyncOutput(["nonexistent-cmd-xyz"])` → `ok: false`, no throw.
- `safeSyncOutput(["git", "status"], { cwd: "/tmp/nonexistent-dir-xyz" })` → `ok: false`, no throw (simulates the worktree cleanup scenario).
- `safeSyncOutput(["echo", "hello"])` → `ok: true`, `stdout: "hello"`.

### Step 6: Build and test

Run `bun run build` and `bun test` to verify no regressions.

## Scope

- **In scope**: All production `Bun.spawnSync` call sites in `src/`, the five wrapper refactors, the spawn test, and build verification.
- **Out of scope**: Test files (`*.test.ts`), scripts outside `src/`, changing the external behavior of any existing function.
- **Exception**: The `tmux attach` inherit-stdio call in `mag.ts` stays raw with an inline try/catch — it is architecturally different (not piped output).
