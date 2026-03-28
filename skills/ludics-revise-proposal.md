---
name: ludics-revise-proposal
description: Revise existing proposal based on feedback, re-send notification
---

# /ludics-revise-proposal - Revise Proposal & Re-notify (Orchestrator)

Thin orchestrator that reads the task and its existing proposal, checks for
user feedback, delegates revision to an isolated worker, then re-sends the
proposal notification so the user can review the update and launch or iterate
again.

## Trigger

This skill is invoked when:
- The user runs `ludics mag revise-proposal <task-id>`
- The user taps the "revise" button on a proposal notification (via ntfy)

## Arguments

- `$ARGUMENTS`: `<task_id> [<feedback>]` — Task identifier followed by optional
  user feedback text. When the user taps "revise" on a proposal notification and
  then sends a follow-up message, the feedback arrives here as a single string.

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **A** (Task Resolution): read task file, extract title/project/slot.
  **Additionally**: verify `proposal:` field exists in frontmatter; if missing,
  write error result "no proposal to revise" and stop.
  `proposal: inline` is a valid legacy value and proceeds normally; the worker
  treats the task body as the proposal source and revises it in-place.
- **B** (Project Path): resolve project checkout path from config
- **C** (Context Brief): compose 3-10 line brief from conversation history.
  **Additionally**: parse user feedback from `$ARGUMENTS` (everything after
  the task ID) and include it verbatim — this is the primary input for revision.
  If no feedback was provided, say so — the worker will use its own judgment
  from re-reading the codebase.
- **D** (Worker Delegation): invoke worker in forked context
- **E** (Result JSON): write result with request ID
- **F** (Error Handling): standard error patterns + "no proposal field" error

Worker: `/ludics-revise-proposal-worker <task_id> <project_path> <context_brief>`

## Skill-Specific: Status Routing

Parse the worker's response for STATUS, PROPOSAL_PATH, PROPOSAL_MODE,
CHANGES_SUMMARY, TITLE, and SUMMARY fields.

- **STATUS: revised** — proceed to re-notification
- **STATUS: no-changes** — write result JSON with `"status": "no-changes"`, stop
- **STATUS: error** — write result JSON with `"status": "error"`, stop

Note `PROPOSAL_MODE` for the steps below:
- `PROPOSAL_MODE: file` — worker revised a separate proposal file; `PROPOSAL_PATH` is present.
- `PROPOSAL_MODE: inline` — worker revised the task body in-place; `PROPOSAL_PATH` is absent.

## Skill-Specific: Re-send Proposal Notification

**File-based mode** (`PROPOSAL_MODE: file`):
```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "<project_path>/<PROPOSAL_PATH>"
```

**Inline mode** (`PROPOSAL_MODE: inline`):
```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

This re-sends the proposal with launch/revise/abandon buttons, completing the
iteration loop.

## Skill-Specific: Best-effort Desktop

**File-based mode**:
```bash
code "<project_path>/<PROPOSAL_PATH>" 2>/dev/null || true
```

**Inline mode**:
```bash
code "$LUDICS_STATE_PATH/tasks/<task_id>.md" 2>/dev/null || true
```

## Skill-Specific Result Fields

**File-based mode**:
```json
{
  "task_id": "<task_id>",
  "proposal_path": "<PROPOSAL_PATH>",
  "proposal_mode": "file",
  "changes_summary": "<what changed>"
}
```

**Inline mode**:
```json
{
  "task_id": "<task_id>",
  "proposal_path": null,
  "proposal_mode": "inline",
  "changes_summary": "<what changed>"
}
```

## Delegation Strategy

- **Worker** (`/ludics-revise-proposal-worker`): Codebase re-exploration,
  task file additive edits, proposal file destructive edits, git commit+push —
  runs in isolated context
- **Orchestrator** (this skill): Task file read, feedback collection, decision
  routing, re-notification, result JSON — runs inline in Mag's context
