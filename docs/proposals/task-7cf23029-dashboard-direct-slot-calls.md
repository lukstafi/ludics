# Proposal: Dashboard slot actions — direct function calls instead of Bun.spawnSync

**Task:** task-7cf23029
**Project:** ludics
**Date:** 2026-04-09

## Goal

Replace the six `Bun.spawnSync` CLI invocations in `dashboard-server.ts` slot action endpoints with direct imports of the corresponding functions from `slots/index.ts`. This eliminates unnecessary process boundary overhead and avoids state-sharing bugs (like the in-memory intent Map issue from Federation v2).

## Acceptance Criteria

1. The `safeSyncOutput` / `Bun.spawnSync` calls in the following six endpoints are replaced with direct function calls:
   - `/api/slot-clear` -- `slotClear(slotNum, status)`
   - `/api/slot-mode` -- `await slotSetMode(slotNum, mode)`
   - `/api/slot-start` -- `await slotStart(slotNum)`
   - `/api/slot-resume` -- `await slotResume(slotNum)`
   - `/api/slot-postpone` -- `slotClear(slotNum, "ready")`
   - `/api/deferred-abandon` -- `slotClear(slotNum, "abandoned")`

2. The `fetch` handler is made `async` to support awaiting async slot functions (`slotSetMode`, `slotStart`, `slotResume`).

3. Error handling: each call is wrapped in try/catch returning `e.message` (or `String(e)`) with HTTP 500, matching current error semantics.

4. The `safeSyncOutput` import is removed if no other usages remain in the file.

5. All existing dashboard slot actions continue to work identically (no behavior change).

6. The project builds cleanly (`bun run build`).

## Context

- **Source file:** `src/dashboard-server.ts` -- the Bun.serve-based dashboard server.
- **Target module:** `src/slots/index.ts` -- exports `slotClear` (sync), `slotSetMode` (async), `slotStart` (async), `slotStop` (async), `slotResume` (async).
- **Origin:** Retrospective from task-75af4974 identified the `Bun.spawnSync` pattern as the root cause of the in-memory intent Map bug, since child processes don't share state with the dashboard server process.
- **Scope:** Six endpoint blocks in a single file. No new features, no API changes.

## Approach

1. **Add import** at the top of `dashboard-server.ts`:
   ```ts
   import { slotStart, slotResume, slotClear, slotSetMode } from "./slots/index.ts";
   ```

2. **Make `fetch` async:** Change `fetch(req)` to `async fetch(req)` in the `Bun.serve()` call. Bun natively supports async fetch handlers.

3. **Replace each endpoint's spawnSync block:**
   - For sync `slotClear`: call directly, no `await`.
   - For async `slotSetMode`, `slotStart`, `slotResume`: use `await`.
   - Keep existing try/catch structure; replace `proc.ok` / `proc.stderr` checks with catch on thrown errors.

4. **Remove `safeSyncOutput` import** if unused after the changes.

5. **Verify:** `bun run build` passes, manual smoke test of dashboard slot buttons.
