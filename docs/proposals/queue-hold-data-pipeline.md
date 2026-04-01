# Expose queue hold state through data pipeline instead of side-channel API endpoint

## Goal

All dashboard state except queue hold flows through the JSON data pipeline (`dashboard/data/*.json`) with TTL-based regeneration. Queue hold state is the sole outlier, read via a dedicated `/api/queue-hold-state` GET endpoint. This inconsistency means queue hold state doesn't benefit from the same caching, batching, and refresh semantics as everything else. Moving it into `mag.json` unifies the data flow and removes a one-off API endpoint.

## Acceptance Criteria

- `generateMag()` in `src/dashboard.ts` includes a `queueHeld: boolean` field in the returned object, derived from `existsSync(join(harness, "mag", "queue-hold"))`.
- The `/api/queue-hold-state` GET endpoint is removed from `src/dashboard-server.ts`.
- The `/api/queue-hold` POST endpoint remains unchanged (it writes the sentinel file and sets `lastGenerated = 0`).
- `fetchQueueHoldState()` in `templates/dashboard/dashboard.js` reads `queueHeld` from `mag.json` instead of calling `/api/queue-hold-state`. It may be folded into `fetchMagStatus()` or kept separate reading from the same data.
- The Hold/Resume button and badge continue to work identically from the user's perspective.
- Queue hold state updates are reflected within the normal data refresh cycle.

## Context

**`src/dashboard.ts`** -- `generateMag()` (line 638) returns `{ status, lastActivity, pendingRequests, terminal }`. It is called at line 911 and written to `mag.json`.

**`src/dashboard-server.ts`** -- Lines 366-370: `/api/queue-hold-state` GET endpoint reads the sentinel file and returns `{ held: boolean }`. Lines 374-398: `/api/queue-hold` write endpoint toggles the sentinel and sets `lastGenerated = 0` to force data regeneration.

**`templates/dashboard/dashboard.js`**:
- `fetchMagStatus()` (line 285): fetches `mag.json`, calls `renderMagStatus(mag)`.
- `fetchQueueHoldState()` (line 627): fetches `/api/queue-hold-state`, sets global `queueHeld`, calls `updateQueueHoldUI()`.
- `toggleQueueHold()` (line 659): calls `/api/queue-hold?state=...`, optimistically updates `queueHeld`.
- Both are called from `fetchAllData()` (line 46).
- `queueHeld` is a module-level boolean (line 23).

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. In `generateMag()`, add `queueHeld: existsSync(join(harness, "mag", "queue-hold"))` to the returned object.
2. Remove the `/api/queue-hold-state` handler block (lines 366-371) from `dashboard-server.ts`.
3. In `dashboard.js`, fold `fetchQueueHoldState()` into `fetchMagStatus()`: after fetching `mag.json`, set `queueHeld = mag.queueHeld ?? false` and call `updateQueueHoldUI()`. Remove the standalone `fetchQueueHoldState()` function and its call in `fetchAllData()`.

## Scope

**In scope:** `src/dashboard.ts`, `src/dashboard-server.ts`, `templates/dashboard/dashboard.js`.

**Out of scope:** The `/api/queue-hold` write endpoint (stays as-is). CLI commands for hold/resume (separate task). Dashboard HTML template (no markup changes needed).

**Dependencies:** None blocking. Related to task-5f93824a (queue hold/resume feature, already implemented).
