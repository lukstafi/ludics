---
name: ludics-feedback-digest
description: Summarize workflow feedback, file GitHub issues
queue-action: feedback-digest
---

# /ludics-feedback-digest - Workflow Feedback Digest (Orchestrator)

Thin orchestrator that delegates feedback processing to an isolated worker,
then handles result reporting.

## Trigger

This skill is invoked when:
- The user runs `ludics mag feedback-digest`
- Auto-queued daily via the briefing trigger

## Arguments

None. All workflow feedback is filed to the ludics repo regardless of which
project generated it (feedback is about the Ludics workflow, not project code).

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- `$LUDICS_RESULTS_DIR`: Directory for result JSON (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **D** (Worker Delegation): invoke the worker in forked context.
- **E** (Result JSON): write the result with the request ID.
- **F** (Error Handling): standard patterns.

Sections A, B, C don't apply — this skill has no task_id or repo argument.

Worker: `/ludics-feedback-digest-worker`

## Status routing

Extract the final ` ```json ` block from the worker. Fields:

| Field | Used for | Missing-field fallback |
|---|---|---|
| `status` | primary routing | error (malformed response) |
| `issues_created` | result JSON | 0 |
| `issues_updated` | result JSON | 0 |
| `issues_skipped` | result JSON | 0 |
| `files_processed` | result JSON | 0 |
| `summary` | result output | empty string |
| `textbookCaptures` | result JSON | `[]` |

Routing by status:
- **completed** — write the result JSON.
- **empty** — write the result JSON noting there was nothing to process.
- **error** — write the result JSON with `"status": "error"`.

## Result fields

```json
{
  "issues_created": 0,
  "issues_updated": 0,
  "issues_skipped": 0,
  "files_processed": 0,
  "textbookCaptures": []
}
```

Output: `"Created N issues, updated N, skipped N, captured N to textbook (N files processed)"`.

## Delegation strategy

- Worker (`/ludics-feedback-digest-worker`) runs in isolated context: feedback
  reading, theme extraction, issue dedup/filing, file cleanup, and the
  `capture-textbook` disposition (step 3a) that journals
  competent-SWE-filter-rejected lessons to `docs/swe-textbook.md`.
- Orchestrator (this skill) runs inline in Mag: result JSON. The
  orchestrator preserves worker-reported `textbookCaptures` in the
  result JSON; it does **not** read or write `docs/swe-textbook.md`
  itself — the worker is the only writing surface.
