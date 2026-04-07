# Add `ludics task abandon` CLI command to unify abandon logic

## Goal

Add a `ludics tasks abandon <id>` CLI command backed by a shared `tasksAbandon()` function in `src/tasks/index.ts`. Refactor the three existing abandon sites (`abandonTaskFromNotification`, `/api/deferred-abandon`, `/api/task-dismiss`) to call this single function so that the behavior is consistent across all entry points.

## Acceptance Criteria

1. `ludics tasks abandon <id>` works from the command line and exits non-zero with a clear error message if the task does not exist.
2. Abandoning a task that is already in a terminal status (`done`, `abandoned`, `merged`) exits with a non-zero status and an error message (not silently succeeds).
3. If the task is assigned to a slot, `slotClear(slotNum, "abandoned")` is called (in-process, not via subprocess), which handles setting status, completed timestamp, and clearing the slot field.
4. If the task is not in a slot, the function sets `status: abandoned` and `completed: <ISO timestamp>` in the task frontmatter directly.
5. In both the slotted and unslotted paths, `deferred_launch` and `approved` frontmatter fields are removed.
6. A `task_abandon` event is emitted via `emitEvent` with `source: "cli"`, `scope: "task"`, and the task ID — exactly once per abandon call.
7. `abandonTaskFromNotification` in `src/mag.ts` is refactored to call `tasksAbandon()` internally (no behavioral change; event source/scope may differ — see Approach note below).
8. `/api/deferred-abandon` in `src/dashboard-server.ts` is refactored to call `tasksAbandon()` and no longer shells out to a subprocess.
9. `/api/task-dismiss` in `src/dashboard-server.ts` is refactored to call `tasksAbandon()`, gaining the `completed` timestamp and `deferred_launch`/`approved` cleanup it previously lacked.
10. Help text in `src/index.ts` USAGE string lists `tasks abandon <id>`.
11. All existing tests pass.

## Context

### Three existing abandon sites and their inconsistencies

| Behavior | `abandonTaskFromNotification` | `/api/deferred-abandon` | `/api/task-dismiss` |
|---|---|---|---|
| Clears slot if assigned | Yes (in-process `slotClear`) | Yes (subprocess `ludics slot N clear abandoned`) | No |
| Sets `completed` timestamp | Yes | Yes | **No** |
| Clears `deferred_launch` | Yes | Yes | **No** |
| Clears `approved` | Yes | Yes | **No** |
| Emits structured event | Yes (`notify_abandon`) | **No** | **No** |

### Key code locations

- `src/tasks/index.ts:578-681` — `runTasks` switch; new `case "abandon"` goes here
- `src/tasks/index.ts:1-9` — existing imports (`updateFrontmatterField`, `removeFrontmatterField`, `emitEvent`, etc. already imported)
- `src/mag.ts:649-659` — `findSlotForTask` export
- `src/mag.ts:671-732` — `abandonTaskFromNotification` (to be refactored)
- `src/slots/index.ts:267` — `slotClear` export
- `src/dashboard-server.ts:365-391` — `/api/task-dismiss` (to be refactored)
- `src/dashboard-server.ts:414-448` — `/api/deferred-abandon` (to be refactored)
- `src/index.ts:146-162` — USAGE string for `tasks` subcommands (add `abandon` entry)

## Approach

### New `tasksAbandon(taskId, options?)` in `src/tasks/index.ts`

```typescript
export function tasksAbandon(
  taskId: string,
  opts: { source?: string; scope?: string } = {}
): void {
  const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) {
    throw new Error(`task not found: ${taskId}`);
  }
  const content = readFileSync(taskFile, "utf-8");
  const fm = parseTaskFrontmatter(content);
  const currentStatus = fm.status ?? "";
  if (["done", "abandoned", "merged"].includes(currentStatus)) {
    throw new Error(`task ${taskId} is already in terminal status: ${currentStatus}`);
  }

  // Dynamic imports to avoid circular deps (slots → tasks → slots)
  const { findSlotForTask } = require("../mag.ts");
  const { slotClear } = require("../slots/index.ts");

  const slotNum = findSlotForTask(taskId);
  if (slotNum !== null) {
    slotClear(slotNum, "abandoned");
  } else {
    updateFrontmatterField(taskFile, "status", "abandoned");
    updateFrontmatterField(taskFile, "completed", new Date().toISOString().slice(0, 19) + "Z");
  }
  removeFrontmatterField(taskFile, "deferred_launch");
  removeFrontmatterField(taskFile, "approved");

  emitEvent({
    event_type: "task_abandon",
    source: opts.source ?? "cli",
    scope: opts.scope ?? "task",
    task: taskId,
    status: "abandoned",
    message: slotNum !== null
      ? `abandoned from slot ${slotNum}`
      : "abandoned (no slot)",
  });
}
```

**Circular dependency note**: `tasks/index.ts` is imported by `mag.ts` which exports `findSlotForTask`. To avoid a circular import, use dynamic `import()` inside the function body (consistent with how `runTasks` already does `await import("../federation.ts")`) or extract `findSlotForTask` into a lower-level module. The dynamic import approach is lower risk.

### CLI case in `runTasks`

```typescript
case "abandon": {
  const id = args[1];
  if (!id) throw new Error("task ID required");
  tasksAbandon(id);
  console.log(`ludics: abandoned task ${id}`);
  break;
}
```

### Refactored callers

- **`abandonTaskFromNotification`**: call `tasksAbandon(taskId, { source: "notify", scope: "mag" })` and preserve the existing error-handling try/catch wrapper. The `notify_abandon_ignored` (task not found) case stays inline since `tasksAbandon` throws on missing file — catch that and emit the ignored event.
- **`/api/deferred-abandon`**: replace inline logic with `tasksAbandon(taskParam)`. The subprocess call to `ludics slot N clear abandoned` is eliminated.
- **`/api/task-dismiss`**: replace inline `updateFrontmatterField(taskFile, "status", "abandoned")` with `tasksAbandon(taskParam)`. Remove the `needs-confirmation` status guard or keep it (semantically it still makes sense to validate — just call `tasksAbandon` after the check).
