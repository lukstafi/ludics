# Proposal: Followup suggestions skill — auto-create needs-confirmation tasks from agent refactoring notes

**Task:** task-5ef3ac11
**Effort:** medium

## Summary

Add a new LLM-invoked skill `ludics-process-suggestions` that reads retrospective
suggest-refactor and workflow-feedback content after task completion, applies judgment
to filter substantive from nitpicky suggestions, and creates tasks with a new
`needs-confirmation` status. The user confirms or dismisses these via the dashboard
or briefing review.

## Design Overview

### New status: `needs-confirmation`

A task in `needs-confirmation` is not assignable and does not appear in the ready
queue. It appears in:
- A dedicated briefing section ("Needs Confirmation")
- A new dashboard data file (`needs-confirmation.json`) with confirm/dismiss buttons

Transitions:
- confirm → `ready` (priority stays at C; user can promote afterward)
- dismiss → `abandoned`

### Skill: `ludics-process-suggestions`

An LLM skill (markdown template), not TypeScript logic. The LLM reads the
retrospective JSON, evaluates each suggestion, and creates tasks for substantive
ones via `ludics tasks create`.

## Implementation Plan

### 1. Skill template — `skills/ludics-process-suggestions.md`

New file. Follows the pattern of `ludics-elaborate.md` (orchestrator that reads
inputs, delegates judgment, writes results).

Key sections:

- **Trigger**: Auto-queued after retrospective collection; manual via
  `ludics mag process-suggestions <task-id>`
- **Arguments**: `<task-id>` — the completed task whose retrospective to process
- **Process**:
  1. Read `$LUDICS_STATE_PATH/retrospectives/<task-id>.json`
  2. Extract `suggestRefactorSummary` and `workflowFeedback` entries
  3. If both empty/null, return `STATUS: empty`
  4. For each distinct suggestion, apply judgment criteria:
     - **Substantive** (create task): architectural refactoring affecting multiple
       modules, missing error handling, performance improvements with measurable
       impact, API design issues, missing test coverage, security/correctness concerns
     - **Nitpicky** (skip with logged reason): variable renaming, comment rewording,
       import reordering, formatting, suggestions already covered by existing tasks
  5. For substantive suggestions:
     - Run `ludics tasks create "<title>" <project> C`
     - Update the new task file: set `status: needs-confirmation`,
       add `relates_to: [<source-task-id>]`, set `effort: small`,
       add context line: "Auto-generated from retrospective of <source-task-id>"
  6. Return summary: `STATUS`, `CREATED`, `SKIPPED`, `TASKS` list
- **Duplicate check**: Before creating, scan existing tasks for title overlap
  (use `ludics tasks duplicates` or grep task files)

### 2. Queue action registration — `src/mag.ts`

**resolveQueueRequestCommand()** (after line 1213, before `default`):

```typescript
case "process-suggestions": {
  const task = String(request.task ?? "");
  return `/ludics-process-suggestions ${task}`;
}
```

**runMag() CLI handler** (around line 2866, alongside other mag subcommands):

```typescript
case "process-suggestions": {
  const taskId = args[1];
  if (!taskId) throw new Error("task id required");
  queueRequest("process-suggestions", `"task":"${taskId}"`);
  console.log(`Queued process-suggestions request for ${taskId}`);
  break;
}
```

**Error message** (line 2897): Add `process-suggestions` to the valid commands list.

### 3. Auto-queue after retrospective — `src/retrospective.ts`

In `writeRetrospective()` (line 406-418), after the `emitEvent()` call:

```typescript
import { queueRequest } from "./queue.ts";  // top-of-file import

// In writeRetrospective(), after emitEvent:
if (data.suggestRefactorSummary || Object.keys(data.workflowFeedback).length > 0) {
  queueRequest("process-suggestions", `"task":"${data.taskId}"`);
}
```

`writeRetrospective()` is synchronous and `queueRequest()` is synchronous
(appendFileSync), so no async conversion needed.

### 4. Dashboard data — `src/dashboard.ts`

Add a `generateNeedsConfirmation()` function (near line 832) collecting tasks with
`status === "needs-confirmation"`:

```typescript
function generateNeedsConfirmation(tasks: DashboardTask[]) {
  return tasks
    .filter((t) => t.status === "needs-confirmation")
    .map((t) => ({
      id: t.id,
      title: t.title,
      project: t.project,
      priority: t.priority,
      created: t.created,
      relatesTo: t.dependencies.relates_to ?? [],
    }));
}
```

Write to `dashboard/data/needs-confirmation.json` in `dashboardGenerate()`.

### 5. Dashboard API — `src/dashboard-server.ts`

Two new endpoints following the `/api/task-promote` pattern (line 283):

**`/api/task-confirm`**: Validate task ID, verify `status === "needs-confirmation"`,
update frontmatter status to `ready` using the same line-by-line rewrite pattern
used by task-promote.

**`/api/task-dismiss`**: Same validation, update status to `abandoned`.

Both invalidate the dashboard cache (`lastGenerated = 0`).

### 6. Dashboard UI — `dashboard/dashboard.js`

- Add a `renderNeedsConfirmation()` function that fetches
  `data/needs-confirmation.json` and renders a card per task with Confirm/Dismiss
  buttons
- Wire button handlers to `/api/task-confirm?task=X` and `/api/task-dismiss?task=X`
  following the `promoteTask()` pattern
- Place the section between the slots view and the ready queue

### 7. Briefing integration — `skills/ludics-briefing.md`

Add to the Output Format (around line 180), between "Ready to Start" and
"Urgent Attention":

```markdown
## Needs Confirmation
- **task-abc123** (C): "Refactor tensor allocation path" — from task-xyz789 retrospective
  → confirm: `ludics tasks update task-abc123 status ready`
  → dismiss: `ludics tasks update task-abc123 status abandoned`
```

Add to Process step 4 ("Analyze, merge, and split work"): scan task files for
`status: needs-confirmation` and include in briefing. If a needs-confirmation
task duplicates an existing task, auto-dismiss it.

### 8. Flow system — no changes needed

`flowReady()` already filters `status === "ready"`, so `needs-confirmation` tasks
are naturally excluded. Same for `maybeFillEmptySlots()` and
`maybeAutoQueueProposals()` in `src/mag.ts`.

## File Change Summary

| File | Change |
|------|--------|
| `skills/ludics-process-suggestions.md` | **New** — skill template |
| `src/mag.ts` | Add `process-suggestions` case to `resolveQueueRequestCommand()`, CLI handler, and valid-commands error message |
| `src/retrospective.ts` | Import `queueRequest`, auto-queue in `writeRetrospective()` |
| `src/dashboard.ts` | `generateNeedsConfirmation()`, write `needs-confirmation.json` |
| `src/dashboard-server.ts` | `/api/task-confirm` and `/api/task-dismiss` endpoints |
| `dashboard/dashboard.js` | Needs-confirmation section with confirm/dismiss buttons |
| `skills/ludics-briefing.md` | Add "Needs Confirmation" section to output format and process |

## Risks and Mitigations

- **Over-creation of tasks**: The judgment criteria in the skill template are
  deliberately conservative (skip cosmetic/style/trivial). The `needs-confirmation`
  gate ensures nothing enters the ready queue without user review.
- **Duplicate tasks**: The skill should check existing tasks before creating.
  Briefing step 4 also catches duplicates.
- **Queue noise**: If retrospectives rarely contain suggestions, the auto-queue
  is a no-op (guarded by the if-check on suggestRefactorSummary/workflowFeedback).

## Open Questions

None — the task elaboration is thorough and all integration points are well-defined.
