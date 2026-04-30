---
name: ludics-verify-completion
description: Verify task completion, clear slot, create follow-ups
queue-action: verify-completion
queue-args: [task]
---

# /ludics-verify-completion - Verify Task Completion (Orchestrator)

Thin orchestrator that reads the task, delegates codebase inspection to an
isolated worker, then handles slot clearing, follow-up creation, and notifications.

## Trigger

This skill is invoked when:
- The health check detects a potentially complete task and queues
  `ludics mag verify-completion <task-id>`
- The user runs `ludics mag verify-completion <task-id>` manually

## Arguments

- `$ARGUMENTS`: `<task_id>` — Task identifier (e.g., `task-042`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- `$LUDICS_RESULTS_DIR`: Directory for writing result JSON (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **A** (Task Resolution): read task file, extract title/project/slot.
- **B** (Project Path): resolve the project checkout from config.
- **C** (Context Brief): compose a 3-10 line brief from conversation history.
- **D** (Worker Delegation): invoke the worker in forked context.
- **E** (Result JSON): write the result with the request ID.
- **F** (Error Handling): standard patterns.

Worker: `/ludics-verify-completion-worker <task_id> <project_path> <context_brief>`

- **Manual-smoke ACs require evidence, not argument.** Do not accept
  "unit tests exercise the same library combination" as evidence for an
  AC that names a route, an asset, or a rendered surface. See
  [Manual-Smoke Evidence](worker-conventions.md#manual-smoke-evidence) for
  the two probe shapes (wrapper-pipeline + live HTTP) the harness can
  deliver.

## Verdict routing

Extract the final ` ```json ` block from the worker. Fields:

| Field | Used for | Missing-field fallback |
|---|---|---|
| `status` | error check | error (malformed response) |
| `verdict` | primary routing | error (malformed response) |
| `followups` | follow-up creation | treat as `"none"`, skip |
| `questions` | uncertain notification | send a generic uncertainty message |
| `slot` | slot clearing | error when the verdict needs clearing |
| `title` | notification text | fall back to task_id |
| `evidence` | result context | empty string |
| `task_id` | — | not consumed |

If `status = "error"`, write a result JSON with `"status": "error"` and stop.
Otherwise route on `verdict`:

### complete
- Clear the slot and notify:
  ```bash
  ludics slot <N> clear done
  ludics notify outgoing "Completed: <task_id> (<title>)" 3 "Task Complete"
  ```

### complete-with-followups
- Clear the slot:
  ```bash
  ludics slot <N> clear done
  ```
- For each object in `followups` (skip when `"none"` or empty), extract its
  `title` and `priority` and file a follow-up:
  ```bash
  ludics tasks create "<followup.title>" <project> <followup.priority>
  ```
- Notify with what was completed and what follow-ups were created:
  ```bash
  ludics notify outgoing "Completed <task_id>: <title> — created <N> follow-up task(s)" 3 "Task Complete + Follow-ups"
  ```

### uncertain
- Don't clear the slot.
- Notify with the numbered questions (or a generic uncertainty message when
  `questions` is `"none"`/empty):
  ```bash
  ludics notify outgoing "<formatted questions or generic uncertainty message>" 3 "Completion check — <task_id>"
  ```

### incomplete
- Don't clear the slot; note findings in the result JSON without notifying.

## Result fields

```json
{
  "task_id": "<task_id>",
  "verdict": "<verdict>",
  "followup_tasks": ["task-NNN", "..."]
}
```

## Delegation strategy

- Worker (`/ludics-verify-completion-worker`) runs in isolated context:
  codebase inspection, git log analysis, acceptance-criteria checking.
- Orchestrator (this skill) runs inline in Mag: task read, verdict routing,
  slot clearing, follow-up creation, notifications, result JSON.

## Error handling

Per [orchestrator-conventions.md](orchestrator-conventions.md) Section F, plus:
- Task not in any slot: write result with `"verdict": "not-slotted"` and skip
  slot operations.
