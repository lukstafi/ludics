---
name: ludics-feedback-digest
description: Summarize workflow feedback, file GitHub issues
---

# /ludics-feedback-digest - Workflow Feedback Digest (Orchestrator)

Thin orchestrator that delegates feedback processing to an isolated worker,
then handles result reporting.

## Trigger

This skill is invoked when:
- The user runs `ludics mag feedback-digest <repo>`
- Auto-triggered by agent-duo on session completion (if `auto_digest=true`)

## Arguments

- `$ARGUMENTS`: `<repo>` — GitHub repo (e.g., `owner/repo`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- `$LUDICS_RESULTS_DIR`: Directory for result JSON (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **D** (Worker Delegation): invoke worker in forked context
- **E** (Result JSON): write result with request ID
- **F** (Error Handling): standard error patterns

Sections A, B, C do not apply — this skill takes `<repo>`, not `<task_id>`.

Worker: `/ludics-feedback-digest-worker <repo>`

## Skill-Specific: Status Routing

Parse the worker's response for STATUS and counts.

- **STATUS: completed** — write result JSON
- **STATUS: empty** — write result JSON indicating nothing to process
- **STATUS: error** — write result JSON with `"status": "error"`

## Skill-Specific Result Fields

```json
{
  "issues_created": 0,
  "issues_updated": 0,
  "issues_skipped": 0,
  "files_processed": 0
}
```

Output format: `"Created N issues, updated N, skipped N (N files processed)"`

## Error Handling

Per [orchestrator-conventions.md](orchestrator-conventions.md) Section F, plus:
- Repo not specified: Write result with `"status": "error"`, stop

## Delegation Strategy

- **Worker** (`/ludics-feedback-digest-worker`): All feedback reading, theme
  extraction, issue dedup/filing, file cleanup — runs in isolated context
- **Orchestrator** (this skill): Result JSON — runs inline in Mag's context
