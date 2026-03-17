# Proposal: Fix orchestrated sessions not launching AI agent CLIs

**Task:** gh-ludics-53
**Effort:** small-medium

## Root Cause

The t3code server uses **lazy session creation** — CLI agents are only spawned when the first `thread.turn.start` message arrives, not on `thread.create`. The ludics orchestration runner (background process spawned by `startOrchestrationProcess()`) is responsible for sending this message during the setup→work phase transition.

The runner is **crashing silently** before it can send the first turn message. The crash is invisible because `startOrchestrationProcess()` suppresses all output (`stdout: "ignore", stderr: "ignore"`).

## Fix

### 1. Redirect stderr to a log file

In `startOrchestrationProcess()` (`src/adapters/t3code.ts`), redirect stderr to a log file so crashes are diagnosable:

```typescript
const logPath = join(slotStateDir, `orchestration-${feature}.log`);
const logFd = openSync(logPath, "a");
const proc = Bun.spawn([...], {
  stdout: "ignore",
  stderr: logFd,
});
```

### 2. Add a liveness check after spawning

After spawning, wait briefly and check if the process is still alive:

```typescript
await Bun.sleep(500);
if (proc.exitCode !== null) {
  const log = readFileSync(logPath, "utf-8").slice(-2000);
  throw new Error(`Orchestration process exited immediately (code ${proc.exitCode}):\n${log}`);
}
```

### 3. Report PID liveness in `readState()`

In the t3code adapter's `readState()`, check if the orchestration PID is still alive and include it in the status output so `ludics slots refresh` shows whether the runner is running or crashed.

## Architecture Note

The flow is: ludics adapter → create threads → spawn runner → runner enters work phase → runner sends `thread.turn.start` via WebSocket → t3code server's `ProviderCommandReactor` calls `ensureSessionForThread()` → CLI agent spawned.

The break is between steps 3 and 4 — the runner crashes before sending the turn message.

## Next Step

After applying the fix, the log file will show why the runner crashes. The actual fix for the crash itself is a follow-up once we can see the error.
