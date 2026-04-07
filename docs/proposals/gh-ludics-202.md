# Worker-safe annotations for slots module

## Goal

Harden `src/slots/index.ts` against future worker-context bugs by annotating all exported
functions with `// WORKER-SAFE` or `// CONTROLLER-ONLY` comments, standardizing the
post-early-return comment blocks in `slotStart`, `slotStop`, and `slotResume`, and adding
JSDoc to those three functions documenting the remote-dispatch error contract.

All actual runtime bugs tracked in issue #202 are already fixed. This task adds durable
code-level documentation so that future contributors editing slot operations can immediately
understand which code paths are valid in worker vs. controller contexts.

## Acceptance Criteria

1. `slotStart`, `slotStop`, and `slotResume` each have a JSDoc comment (above the `export
   async function` declaration) stating:
   - Remote-machine-offline throws an `Error`; callers must handle
   - Async intent path (worker target, non-force) returns normally; success is observed later
     via slot intent events / journal
   - Callers wanting synchronous confirmation must poll intent state

2. Each of the three remote-dispatch early-return blocks in `slotStart` (line 698),
   `slotStop` (line 806 non-force branch), and `slotResume` (line 855) is followed by a
   standard comment block:
   ```typescript
   // --- LOCAL EXECUTION ONLY (worker side or local slot) ---
   // Code below this point runs only when this machine owns the slot.
   // Remote-slot paths returned above after queuing an intent.
   ```
   (In `slotStop` this comment goes after the `if (isRemoteMachine)` block closes, just
   before `runAdapterAction`, since the force path falls through.)

3. Functions that perform file I/O with no remote-dispatch guard are annotated
   `// CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed` at the top of their
   body. Affected functions:
   - `slotAssign` (line 187)
   - `slotClear` (line 314)
   - `markSlotSetupFailed` (line 390)
   - `taskCompleteDirectly` (line 437)
   - `slotPreempt` (line 490)
   - `slotRestore` (line 547)

4. Functions that are explicitly worker-context-aware (use `isWorkerContext()` or
   `workerSlotsOverride` to branch) are annotated `// WORKER-SAFE` at the top of their
   body. Affected functions:
   - `loadBlocks` (line 46)
   - `writeSlotFileOrHttp` (line 66)
   - `slotsRefresh` (line 1153)

5. No logic changes — annotations only (plus JSDoc). All existing tests continue to pass.

## Context

Issue: https://github.com/lukstafi/ludics/issues/202

The root problem: `src/slots/index.ts` has two classes of functions:

- **Worker-safe**: explicitly handle being called on a remote worker node (use
  `isWorkerContext()` or `workerSlotsOverride` to route writes to the controller).
- **Controller-only**: expected to run only on the controller; would silently corrupt state
  if called on a worker (no remote-dispatch guard, write directly to local harness files).
- **Remote-dispatching** (`slotStart`, `slotStop`, `slotResume`): handle remote slots by
  recording an intent and returning early; all file I/O after the guard is local-only.

Currently none of these distinctions are annotated. A contributor adding new logic to, e.g.,
`slotClear` could introduce a write-to-worker-harness bug with no visible warning at the
call site.

Key code locations in `src/slots/index.ts`:
- `slotStart` remote guard: line 698–713 (records intent, returns)
- `slotStop` remote guard: line 806–819 (non-force records intent and returns; force falls
  through to post-guard cleanup)
- `slotResume` remote guard: line 855–870 (records intent, returns)
- `slotClear`: line 314 — controller-only, direct `writeSlotFile`
- `markSlotSetupFailed`: line 390 — controller-only, direct `writeSlotFile`
- `slotsRefresh`: line 1153 — worker-safe, uses `isWorkerContext()` branches

The `slotStop` force path is intentional: `--force` clears controller-side session state
even for a remote slot (that's the point of force). The annotation should document this as
intentional rather than leaving it unexplained.

## Approach

All changes are in `src/slots/index.ts`. No other files need modification.

1. **JSDoc for `slotStart`, `slotStop`, `slotResume`**: add a `/** ... */` block immediately
   above each `export async function` declaration. The JSDoc should describe:
   - Purpose (one line)
   - `@throws` if the target machine is offline (remote path only)
   - `@returns` normally when intent is queued asynchronously (non-force remote path);
     callers must poll to observe completion

2. **Post-early-return standard block**: insert the three-line comment after the `return`
   in each remote-dispatch guard. For `slotStop`, the comment belongs just before
   `runAdapterAction` (after the `if/else` closes) to cover both the force path and the
   local path.

3. **CONTROLLER-ONLY annotations**: add a one-line comment at the start of the function
   body for `slotAssign`, `slotClear`, `markSlotSetupFailed`, `taskCompleteDirectly`,
   `slotPreempt`, and `slotRestore`.

4. **WORKER-SAFE annotations**: add a one-line comment at the start of the function body
   for `loadBlocks`, `writeSlotFileOrHttp`, and `slotsRefresh`.

## Scope

**In scope:**
- Annotation-only edits to `src/slots/index.ts`

**Out of scope:**
- Changes to any other file
- Logic or behavior changes
- Adding new worker-safe implementations to controller-only functions
- A separate `docs/worker-context-audit.md` checklist (can be filed as a follow-up if desired)
