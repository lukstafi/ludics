# Proposal: Extract findSlotForTask from mag.ts and add tasksAbandon regression tests

**Task**: task-86318063
**Date**: 2026-04-09

## Goal

Eliminate the runtime `require()` circular-dependency hack in `tasksAbandon` by moving `findSlotForTask` to `src/slots/index.ts`, and add regression test coverage for `tasksAbandon()`.

## Acceptance Criteria

1. **`findSlotForTask` lives in `src/slots/index.ts`** — exported from there, removed from `src/mag.ts`. All existing callers updated to import from the new location.
2. **No runtime `require()` in `tasksAbandon`** — both `findSlotForTask` and `slotClear` are imported via static `import` statements in `src/tasks/index.ts`.
3. **No circular import at startup** — `bun run build` succeeds; `ludics help` runs without hanging or stack overflow.
4. **Regression tests in `src/tasks/abandon.test.ts`** covering:
   - Abandon an unslotted task (status changes to `abandoned`, `completed` timestamp set, deferral flags removed, event emitted).
   - Abandon a slotted task (`slotClear` called, deferral flags removed, event emitted).
   - Abandon a task already in terminal status (`done`/`abandoned`/`merged`) — throws error.
   - Abandon a missing task — throws error.
   - Frontmatter cleanup: `deferred_launch` and `approved` fields removed after abandon.
5. **All existing tests pass** — `bun test` green.

## Context

- `findSlotForTask` (mag.ts:651-658) depends only on `readAllSlotJson` and `slotsCount`, both already imported in `slots/index.ts`. It has zero mag.ts-specific dependencies.
- Callers in `mag.ts` (lines 678, 719, 3256, 3263, 3300) will switch to importing from `./slots/index.ts` — mag.ts already imports from that module.
- `dashboard-server.ts` does NOT import `findSlotForTask` (elaboration note was incorrect).
- `tasksAbandon` in `src/tasks/index.ts` (line 578-633) currently uses `require("../mag.ts")` and `require("../slots/index.ts")` at runtime to break the circular dependency chain `tasks -> mag -> tasks`.
- After moving `findSlotForTask` to slots, `tasks/index.ts` can use static imports for both `findSlotForTask` (from `../slots/index.ts`) and `slotClear` (from `../slots/index.ts`) since `slots/index.ts` does not import from `tasks/index.ts` (only from `tasks/markdown.ts`).
- Existing test files use `bun:test` with `describe`/`test`/`expect`. Tests that need filesystem use temp directories.

## Approach

### Part 1: Move findSlotForTask

1. Copy `findSlotForTask` to `src/slots/index.ts`, export it. It uses `readAllSlotJson` and `slotsCount` which are already available in that module.
2. Remove the function and its export from `src/mag.ts`.
3. In `src/mag.ts`, add `findSlotForTask` to the existing import from `"./slots/index.ts"`.
4. In `src/tasks/index.ts`, replace the two runtime `require()` calls with static imports: `import { findSlotForTask, slotClear } from "../slots/index.ts"`.
5. Verify no circular import: `slots/index.ts` imports from `tasks/markdown.ts` (not `tasks/index.ts`), so the new `tasks/index.ts -> slots/index.ts` static import is safe.

### Part 2: Regression tests

Create `src/tasks/abandon.test.ts` using `bun:test`. Mock `findSlotForTask`, `slotClear`, and `emitEvent` via `bun:test` mock utilities. Use real temp-directory task files for frontmatter assertions:

- **Test 1 (unslotted abandon)**: Mock `findSlotForTask` returning `null`. Create a temp task file with status `ready`. Call `tasksAbandon`. Assert status is `abandoned`, `completed` is set, event emitted.
- **Test 2 (slotted abandon)**: Mock `findSlotForTask` returning `2`. Call `tasksAbandon`. Assert `slotClear(2, "abandoned")` called, deferral flags removed.
- **Test 3 (terminal status)**: Create task with status `done`. Assert `tasksAbandon` throws with "terminal status".
- **Test 4 (missing task)**: Mock `findSlotForTask` returning `null`. Call with nonexistent ID. Assert throws "task not found".
- **Test 5 (deferral cleanup)**: Create task with `deferred_launch: true` and `approved: true`. Abandon. Assert both fields removed from file.
