# Add ludics queue hold/resume CLI commands

## Goal

Queue hold/resume (suppressing automatic slot assignments) currently requires
using the dashboard UI or manually creating/removing the `mag/queue-hold`
sentinel file. Adding dedicated CLI commands makes this operation accessible
from the terminal without dashboard or file manipulation.

## Acceptance Criteria

- `ludics queue hold` creates the sentinel file and prints a confirmation message (e.g., "Queue held -- auto-assignment suppressed")
- `ludics queue resume` removes the sentinel file and prints a confirmation message (e.g., "Queue resumed -- auto-assignment enabled")
- `ludics queue status` prints whether the queue is currently held or active
- Running `hold` when already held, or `resume` when not held, is a no-op with an informational message (not an error)
- USAGE string is updated with the new `queue hold`, `queue resume`, and `queue status` subcommands

## Context

**Sentinel file mechanism:** `src/mag.ts` defines `queueHoldFilePath()` (line ~2065)
returning `<harness>/mag/queue-hold`, and `isQueueHeld()` (line ~2070) checking its
existence. These are module-private functions.

**Dashboard reference implementation:** `src/dashboard-server.ts` (lines 364-394)
implements hold/resume via `/api/queue-hold?state=true|false` and
`/api/queue-hold-state`. The dashboard handler also emits `queue_hold` journal
events via `emitEvent()`.

**CLI entry point:** `src/index.ts` uses a `MIGRATED_COMMANDS` record (line 25) mapping
command names to async handler functions. The USAGE string (line 90+) documents all
commands. There is no existing top-level `queue` command -- queue viewing is under
`mag queue` (line 149).

**Existing patterns for inline commands:** `state`, `journal`, and `stop` commands
in `src/index.ts` (lines 62-88) show how subcommand dispatch is done inline for
simple commands.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

Add a `queue` entry to `MIGRATED_COMMANDS` in `src/index.ts` with inline
subcommand dispatch (matching the `journal`/`state` pattern). The handler should:
- Import and reuse (or inline) the sentinel file path logic from `src/mag.ts`
- Emit `queue_hold` journal events consistent with the dashboard implementation
- Default to `status` when no subcommand is given

The `queueHoldFilePath()` and `isQueueHeld()` helpers in `src/mag.ts` are currently
module-private. Either export them or duplicate the trivial path logic in the new
handler.

## Scope

**In scope:** The three CLI subcommands (`hold`, `resume`, `status`), USAGE string
update, and journal event emission.

**Out of scope:**
- Exposing hold state through the data pipeline (task-f1c4b382)
- Logging journal events on hold state change from other sources (task-8d0cd6a3)
- Changes to the existing `mag queue` command (shows pending requests, separate concern)
