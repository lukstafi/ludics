# Wire workerReportStatus into orchestration runner completion path

## Goal

When orchestration completes on a worker machine, the controller has no fast
signal that the task is done. The controller eventually discovers it through
`maybeClearDoneSlots()` on state-repo sync, but this is slow and depends on
timing. The `workerReportStatus` function already exists for exactly this
purpose but is only invoked via the CLI (`ludics worker-signal write`).
Calling it automatically from the runner's completion path eliminates the
need for external scripts and gives the controller an immediate signal to poll.

## Acceptance Criteria

1. When `runOrchestration` reaches phase "done" on a machine whose federation
   role is `"worker"`, a worker signal file is written with status `"done"`
   and the correct `taskId` and slot number.
2. On `"standalone"` or `"controller"` machines, no signal file is written
   (these machines manage their own slot state directly).
3. The signal write happens after the task file is marked done and the
   completion event is emitted, but before retrospective collection, so
   the controller can begin clearing the slot while retrospective runs.
4. A failure in `workerReportStatus` does not crash the runner — it is
   caught and logged, matching the non-critical nature of the signal
   (the state-repo sync is the fallback).

## Context

### Current completion path (`src/orchestration/runner.ts`, lines 1182-1212)

After the main orchestration loop exits (`state.phase === "done"`):
1. Task file frontmatter updated: `status: done`, `completed: <iso-now>`
2. `task_completed` event emitted
3. Notification sent to agents
4. Retrospective collected

No worker signal is written anywhere in this path.

### Worker signal API (`src/worker-signal.ts`)

- `workerReportStatus(slotNum, { taskId, status, message })` — writes a JSON
  signal file to `harness/worker-signals/slot-N.json`. Creates the directory
  if needed. Idempotent and synchronous.
- `controllerPollWorkers()` — called from `federationTick()`, reads signal
  files from remote workers via SSH. Validates taskId matches current slot
  assignment (stale signals are ignored and cleared).

### Federation role (`src/federation.ts`)

- `federationRole()` returns `"controller" | "worker" | "standalone"`.
- Neither `federationRole` nor `workerReportStatus` is currently imported
  in `runner.ts`.

### Key state available at the insertion point

- `state.slot` — slot number
- `state.taskId` — task identifier
- Both are guaranteed non-null inside the `if (state.taskId)` guard at
  line 1184.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Import `workerReportStatus` from `../worker-signal.ts` and
   `federationRole` from `../federation.ts` in `runner.ts`.
2. After the notification (line 1202) and before retrospective collection
   (line 1206), insert:
   ```ts
   if (federationRole() === "worker") {
     try {
       workerReportStatus(state.slot, {
         taskId: state.taskId,
         status: "done",
         message: `orchestration completed for ${state.taskId}`,
       });
     } catch (err) {
       console.error(`ludics: worker signal write failed: ${err instanceof Error ? err.message : String(err)}`);
     }
   }
   ```

## Scope

**In scope:**
- Adding the `workerReportStatus` call to the success completion path.

**Out of scope:**
- Error/failure signal writing (no explicit error exit path exists yet in the
  runner; can be addressed in a follow-up if error handling is added).
- Changes to `controllerPollWorkers` or the signal file format.
- Tests (the change is a straightforward integration point; existing federation
  tests cover the polling side).

**Dependencies:** None. The related task-7704dc41 (Federation runtime) is
already completed.
