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

## Process

### 1. Read task file (for Mag's awareness)

```bash
cat "$LUDICS_STATE_PATH/tasks/$ARGUMENTS.md"
```

Extract: title, project, slot number. Gives Mag context about what's being verified.

### 2. Resolve project path

Same logic as draft-proposal: look up the task's `project` field in
`$LUDICS_STATE_PATH/config.yaml`, resolve to local checkout path.

### 3. Compose context brief

Write a short free-form context brief (3-10 lines) distilling relevant
background from Mag's conversation history. Include any of:
- User comments about completion status (e.g., "finished core but skipped edge cases")
- Known criteria changes since the task was started
- Related completed or in-progress work that affects verification
- Session observations relevant to the verdict

If nothing relevant, pass an empty brief.

### 4. Delegate to worker

```
/ludics-verify-completion-worker <task_id> <project_path> <context_brief>
```

The worker runs in a forked context — its codebase reads, git log queries, and
file inspections do not enter Mag's conversation history.

### 5. Interpret worker result and act

Parse the worker's VERDICT and act accordingly:

#### VERDICT: complete
- Clear the slot:
  ```bash
  ludics slot <N> clear done
  ```
- Send notification:
  ```bash
  ludics notify outgoing "Completed: <task_id> (<title>)" 3 "Task Complete"
  ```

#### VERDICT: complete-with-followups
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

#### VERDICT: uncertain
- Do NOT clear the slot
- Send notification with the QUESTIONS from the worker:
  ```bash
  ludics notify outgoing "<questions>" 3 "Completion check — <task_id>"
  ```

#### VERDICT: incomplete
- Do NOT clear the slot
- Note findings in result JSON but do not notify

### 6. Write result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "task_id": "<task_id>",
  "verdict": "<verdict>",
  "followup_tasks": ["task-NNN", "..."],
  "output": "Verified <task_id>: <verdict summary>"
}
```

## Delegation Strategy

- **Worker subagent** (`/ludics-verify-completion-worker`): All codebase inspection,
  git log analysis, acceptance criteria checking — runs in isolated context
- **Orchestrator** (this skill): Task file read, verdict routing, slot clearing,
  follow-up task creation, notifications, result JSON — runs inline in Mag's context

## Error Handling

- Task not found: Write result with `"status": "error"`
- Task not in any slot: Write result with `"verdict": "not-slotted"`, skip slot operations
- Worker returns error: Propagate to result JSON
