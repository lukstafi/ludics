---
name: ludics-verify-completion
description: Verify task completion, clear slot, create follow-ups
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
- **A** (Task Resolution): read task file, extract title/project/slot
- **B** (Project Path): resolve project checkout path from config
- **C** (Context Brief): compose 3-10 line brief from conversation history
- **D** (Worker Delegation): invoke worker in forked context
- **E** (Result JSON): write result with request ID
- **F** (Error Handling): standard error patterns

Worker: `/ludics-verify-completion-worker <task_id> <project_path> <context_brief>`

## Skill-Specific: VERDICT Routing

Parse the worker's VERDICT and act accordingly:

### VERDICT: complete
- Clear the slot:
  ```bash
  ludics slot <N> clear done
  ```
- Send notification:
  ```bash
  ludics notify outgoing "Completed: <task_id> (<title>)" 3 "Task Complete"
  ```

### VERDICT: complete-with-followups
- Clear the slot:
  ```bash
  ludics slot <N> clear done
  ```
- Create follow-up tasks for each item in FOLLOWUPS:
  ```bash
  ludics tasks create "<follow-up title>" <project> <priority>
  ```
- Send notification listing what was completed and follow-ups created:
  ```bash
  ludics notify outgoing "<summary>" 3 "Task Complete + Follow-ups"
  ```

### VERDICT: uncertain
- Do NOT clear the slot
- Send notification with the QUESTIONS from the worker:
  ```bash
  ludics notify outgoing "<questions>" 3 "Completion check — <task_id>"
  ```

### VERDICT: incomplete
- Do NOT clear the slot
- Note findings in result JSON but do not notify

## Skill-Specific Result Fields

```json
{
  "task_id": "<task_id>",
  "verdict": "<verdict>",
  "followup_tasks": ["task-NNN", "..."]
}
```

## Delegation Strategy

- **Worker** (`/ludics-verify-completion-worker`): All codebase inspection,
  git log analysis, acceptance criteria checking — runs in isolated context
- **Orchestrator** (this skill): Task file read, verdict routing, slot clearing,
  follow-up task creation, notifications, result JSON — runs inline in Mag's context

## Error Handling

Per [orchestrator-conventions.md](orchestrator-conventions.md) Section F, plus:
- Task not in any slot: Write result with `"verdict": "not-slotted"`, skip slot operations
