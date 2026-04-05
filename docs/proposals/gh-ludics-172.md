# Dashboard: render pendingAction badge and add machine field to WorkerSignal

## Goal

Two targeted improvements from the gh-ludics-160 retrospective:

1. **Render the `pendingAction` badge on the dashboard** so users can see when a remote slot has a pending start/stop/resume operation in flight.
2. **Add a `machine` field to `WorkerSignal`** so the controller can validate signal provenance by machine identity, replacing the brittle 30-minute epoch TTL workaround.

## Acceptance Criteria

### Item 1: pendingAction badge

- When `slot.pendingAction` is truthy (`"starting"`, `"stopping"`, or `"resuming"`), a badge is rendered in the slot tile's meta line showing title-cased text with ellipsis (e.g., "Starting...", "Stopping...", "Resuming...").
- The badge has a distinct CSS class (`.pending-action-badge`) styled with an amber/yellow color scheme to indicate a transient in-progress state, visually distinct from the blue `.machine-badge`.
- The badge appears only for remote slots (this is inherent since `pendingAction` is derived from intent files which only exist for remote operations).

### Item 2: WorkerSignal machine field

- The `WorkerSignal` interface includes a `machine: string` field.
- `workerReportStatus()` populates `machine` using `federationCurrentMachineName()`.
- `controllerPollWorkers()` validates `signal.machine` against the slot's assigned `machineName`. Mismatched signals are logged and cleared (same pattern as the existing taskId mismatch handling).
- The 30-minute epoch TTL guard (lines 97-104 of `src/worker-signal.ts`) is removed, since taskId + machine validation is sufficient.
- The CLI `worker-signal write` handler accepts an optional `--machine` flag. If omitted, auto-detects via `federationCurrentMachineName()`.
- Signals missing the `machine` field are rejected (strict mode is acceptable since all nodes update together).

## Context

### Dashboard (Item 1)

- **`src/dashboard.ts`**: `pendingAction` is already computed (line 309-314) from intent files and included in the slot JSON payload (line 340). Values: `"starting"` | `"stopping"` | `"resuming"` | `null`. Type defined at line 57.
- **`templates/dashboard/dashboard.js`**: `renderSlots()` (line 105) builds a `meta[]` array for each slot tile. The machine badge is rendered at lines 166-170. The `pendingAction` badge should be inserted into this `meta` array after the machine badge block (around line 170).
- **`templates/dashboard/style.css`**: `.machine-badge` is defined at line 439 (blue theme: `rgba(96, 165, 250, ...)`). The new `.pending-action-badge` should follow the same structure but use amber/yellow colors (e.g., `rgba(245, 158, 11, ...)`).

### WorkerSignal (Item 2)

- **`src/worker-signal.ts`**:
  - `WorkerSignal` interface at line 11-16 — add `machine: string`.
  - `workerReportStatus()` at line 27 — add `machine` from `federationCurrentMachineName()`.
  - `controllerPollWorkers()` at line 64 — add machine validation after taskId check (line 91-95), remove 30-minute TTL (lines 97-104).
  - CLI `write` handler at line 162 — add `--machine` flag parsing, default to `federationCurrentMachineName()`.
- **`src/federation.ts`**: `federationCurrentMachineName()` exported at line 153, returns `string | null` (null when federation is not configured — a non-issue since worker signals are only relevant for remote/federated slots).
- **Import pattern**: `federationCurrentMachineName` is already imported in several modules (e.g., `src/remote.ts` line 3, `src/mag.ts` line 10). The same import style should be used in `worker-signal.ts`.
