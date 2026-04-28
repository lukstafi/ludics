# Migrate remaining PID-aliveness probes to processAlive helper

## Goal

Single-source-of-truth for PID liveness checks. Six production
`try { process.kill(pid, 0) } catch` aliveness probes still bypass the existing
`processAlive` helper exported from `src/t3code/server.ts`. Routing them through
the helper continues the cleanup begun in `task-d55e5398` (where
`readLiveOrchestratorPid` was migrated) and eliminates the inline-pattern variant
across the codebase.

## Acceptance Criteria

- All six documented `process.kill(pid, 0)` aliveness probes in production code
  (`src/slots/index.ts`, `src/orchestration/runner.ts`, `src/dashboard.ts`) are
  replaced with calls to `processAlive` from `src/t3code/server.ts`.
- Actual signal sends (`SIGTERM`, `SIGKILL`) remain `process.kill` — only the
  signal-0 aliveness probes are migrated.
- The two paired-SIGKILL guard sites (the post-SIGTERM "still alive? then
  SIGKILL" patterns in `slotResume`) preserve their swallow-if-already-dead
  semantics: the SIGKILL must remain in a try/catch so a process dying between
  the aliveness check and the kill does not throw.
- `grep -rn 'process.kill(.*\b0\b' src/` shows no signal-0 invocations in
  production code outside `processAlive`'s body and the explicitly-out-of-scope
  files listed below.
- Full gates pass: `bun run typecheck && bun run lint && bun run build && bun test`.

## Context

Helper to use:

- `processAlive(pid: number): boolean` — exported from `src/t3code/server.ts`.
  Validates the pid is a positive integer, then `process.kill(pid, 0)` in a
  try/catch returning a boolean. Identical semantics to the inline pattern.

Six sites to migrate (verified present 2026-04-28; PR #413 did not drift line
numbers, but coders should re-grep before editing):

1. `src/slots/index.ts` — pre-terminate aliveness check in the tmux branch of
   `slotResume`, near the `terminating stale orchestration runner` log:
   `try { process.kill(pid, 0); alive = true; } catch { /* dead */ }`.
2. `src/slots/index.ts` — paired post-SIGTERM SIGKILL guard in the same tmux
   branch: `try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* dead */ }`.
   This is **not** a pure aliveness probe — the `kill(pid, 0)` guards the
   SIGKILL so the kill only fires if alive, with both wrapped in one try/catch
   that silently swallows the race (process dies between probe and SIGKILL).
3. `src/slots/index.ts` — same pre-terminate aliveness pattern as (1) in the
   t3code branch of `slotResume`.
4. `src/slots/index.ts` — same paired-SIGKILL-guard pattern as (2) in the
   t3code branch.
5. `src/orchestration/runner.ts` — aliveness probe in the runner:
   `try { process.kill(pid, 0); alive = true; } catch { /* dead */ }`.
6. `src/dashboard.ts` — `targetPids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } })`.

Imports already present:

- `src/dashboard.ts` already imports `processAlive` from `./t3code/server.ts`.
- `src/slots/index.ts` already imports `processAlive` from `../t3code/server.ts`.
- `src/orchestration/runner.ts` imports `readSlotState` from
  `../t3code/server.ts` but **not** `processAlive` — extend that import.

Out-of-scope sites (do not touch):

- `processAlive` body in `src/t3code/server.ts`.
- All `process.kill(pid, "SIGTERM" | "SIGKILL")` signal sends.
- Test files (`slots/index.test.ts`, `slots/slot-clear-integration.test.ts`,
  `queue.test.ts`).
- Other aliveness probes outside the six (`src/queue.ts`, `src/mag.ts`,
  `src/adapters/t3code.ts`, `src/adapters/tmux-adapter.ts`) — these were
  explicitly out of scope per the originating retrospective and remain future
  cleanup.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

For the four pure aliveness probes (sites 1, 3, 5, 6):

```ts
// before
try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
// after
const alive = processAlive(pid);
```

(Adjust assignment vs. declaration to match the surrounding control flow.) For
the dashboard filter (site 6):

```ts
const alive = targetPids.filter(processAlive);
```

For the two paired-SIGKILL guards (sites 2 and 4), the migration must preserve
the original "swallow if process dies between check and kill" semantics. Wrap
the SIGKILL in its own try/catch:

```ts
if (processAlive(pid)) {
  try { process.kill(pid, "SIGKILL"); } catch { /* race: died between check and kill */ }
}
```

Add `processAlive` to the existing `../t3code/server.ts` import line in
`src/orchestration/runner.ts`. The other two files already import it.

## Scope

**In scope:** the six aliveness probes listed above, ~10 LOC total across three
production files.

**Out of scope:** signal sends, architectural changes to slot resume /
orchestration teardown, aliveness probes in files not listed.

**Dependencies:** none (relates to completed `task-d55e5398`).
