# Remove unanswered-questions notification nagging

## Goal

Delete the periodic `maybeNagQuestions()` keepalive notification and its call site from `src/mag.ts`. The dashboard Unanswered Questions tile (task-ed2be1ba) now surfaces tasks with `has_questions: true` on every refresh, making the hourly push notification redundant. The one-time notification sent by the `ludics-elaborate` orchestrator at elaboration time is sufficient.

## Acceptance Criteria

1. `maybeNagQuestions()` function (lines 2098-2160, including JSDoc comment) is deleted from `src/mag.ts`.
2. The call site in the keepalive loop (lines 2736-2737 — comment `// Nag user about tasks with unanswered questions` and the `maybeNagQuestions()` invocation) is removed.
3. No periodic nag notifications are sent for `has_questions: true` tasks after the change.
4. The `has_questions` frontmatter field remains intact and continues to function for dashboard tile display and proposal-blocking logic (`maybeUnstickAssignedSlots`, `maybeQueueProposals`).
5. The one-time elaboration notification in `skills/ludics-elaborate.md` is unchanged.
6. `bun run build` succeeds with no type errors.
7. All existing tests pass.

## Context

### Code to delete

**`src/mag.ts` lines 2098–2160** — the full `maybeNagQuestions()` function:
- Scans `tasks/` for `has_questions: true` in frontmatter
- Sends `ludics notify outgoing` nag with the questions text
- Debounces via epoch files in `mag/question-nag-debounce/` (1 hour for unslotted, 30 min for slotted tasks)

**`src/mag.ts` lines 2736–2737** — call site in the keepalive loop:
```
// Nag user about tasks with unanswered questions
maybeNagQuestions();
```

### What stays untouched

- `skills/ludics-elaborate.md` lines 63-75: one-time `ludics notify outgoing` sent when elaboration produces questions. This is the desired notification path.
- `has_questions` frontmatter field: read by dashboard tile and by `maybeUnstickAssignedSlots` / `maybeQueueProposals` in `mag.ts`.
- `mag/question-nag-debounce/` directory in existing harness installations: becomes dead state but is harmless to leave. No code will reference it after the deletion.

### Why this is safe

The debounce directory and epoch files inside it are exclusively read and written by `maybeNagQuestions()`. After the function is deleted, nothing else touches that directory. No other code imports or calls `maybeNagQuestions()`.
