---
name: ludics-elaborate
description: Elaborate a task into a detailed specification
---

# /ludics-elaborate - Task Elaboration (Orchestrator)

Thin orchestrator that reads the task, delegates context gathering and spec
writing to an isolated worker, then handles notifications and result reporting.

## Trigger

This skill is invoked:
- When the user runs `ludics mag elaborate <task_id>`
- Before assigning a task to a slot
- For freshly generated tasks from the `ludics tasks sync` automation

## Arguments

- `$ARGUMENTS`: `<task_id>` — Task identifier (e.g., `task-042`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **A** (Task Resolution): read task file, extract title/project/slot
- **B** (Project Path): resolve project checkout path from config
- **C** (Context Brief): compose 3-10 line brief from conversation history
- **D** (Worker Delegation): invoke worker in forked context
- **E** (Result JSON): write result with request ID
- **F** (Error Handling): standard error patterns

Worker: `/ludics-elaborate-worker <task_id> <project_path> <context_brief>`

## Skill-Specific: Status Routing

Extract the JSON block from the worker's response (the last fenced ` ```json ` block).
Parse the JSON for `status`, `questions`, and `summary`.

If no JSON block is found, fall back to line-based parsing: look for `STATUS: <value>`,
`QUESTIONS: <value>`, and `SUMMARY: <value>` lines. On the legacy path, treat `QUESTIONS:`
content as a pre-formatted string and send as-is in the questions notification step.

- **status: completed** — proceed to notifications
- **status: merged** — write result JSON noting the merge, stop
- **status: already-elaborated** — ask if re-elaboration is wanted, or skip
- **status: error** — write result JSON with `"status": "error"`, stop

## Skill-Specific: Questions Notification

If `questions` is not `"none"` and is non-empty, send as notification text:
- JSON array path: format each element as a numbered list (e.g., `1. <q1>\n2. <q2>`)
- Legacy pre-formatted string (fallback path): send as-is

```bash
ludics notify outgoing "<formatted questions>"
```

Use title: "Elaboration questions — <task_id>: <title>"

Skip if `questions` is `"none"` or an empty array/string.

## Skill-Specific Result Fields

```json
{
  "task_id": "<task_id>"
}
```

## Delegation Strategy

- **Worker** (`/ludics-elaborate-worker`): Duplicate checking, context gathering,
  codebase exploration, spec writing, task file update — runs in isolated context
- **Orchestrator** (this skill): Task file read, decision routing, notifications,
  result JSON — runs inline in Mag's context
