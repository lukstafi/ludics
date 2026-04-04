# Worker Conventions

Shared conventions for all worker subagents. Each worker skill references this
file — follow these conventions exactly.

## Argument Parsing

Workers receive arguments via `$ARGUMENTS`. Parse positionally:

```
$ARGUMENTS format: <arg1> <arg2> [<arg3>...]
```

Extract arguments by splitting on whitespace. The first word is typically a task
ID or repo identifier. Subsequent words are paths or additional parameters.

## Broader Context

Some workers receive a `<context_brief>` as an additional argument — free-form
text (3-10 lines) composed by the orchestrator with relevant background from
Mag's conversation history. When present:

- Use it to inform judgment calls (scope decisions, staleness checks, priority)
- Do NOT treat it as ground truth — verify claims against the codebase
- Do NOT echo it verbatim in outputs
- If absent or empty, proceed normally using only the codebase and task file

## Structured Response Format

Your final response MUST include a fenced JSON block (` ```json ``` `) as the **last
code block** in your response. All structured fields go inside this JSON object.

```json
{
  "status": "<status_value>",
  "field_name": "<value>"
}
```

Rules:
- **`status`** is always required and is the primary routing field
- Common status values: `"completed"`, `"error"`, `"stale"`, `"split-needed"`,
  `"already-exists"`, `"merged"`, `"already-elaborated"`, `"empty"`
- Field names use **snake_case**
- Multi-value fields use JSON arrays (e.g., `"questions": ["q1", "q2"]`);
  use the string `"none"` when the list is empty
- Free-form explanation text may precede the JSON block — the JSON block is
  always the last fenced code block in your response
- Keep the response concise — the orchestrator handles notifications,
  result JSON, and downstream actions

## Field Annotations

Each worker documents response fields in a "Response Contract" with these
annotations:

- **required**: Always present in non-error responses. List-like required fields
  use `"none"` when empty.
- **conditional**: Present only when a specific condition holds. Omitted entirely
  otherwise — never `null`.

The `status` field is always required. When `status` is `"error"`, only `status`
plus a narrative field are guaranteed — other fields may be absent.

Orchestrators MUST handle the absence of conditional fields gracefully.

## Error Handling

Follow these conventions for all error conditions:

- **Missing input** (task not found, path not found): Set `"status": "error"`.
  Include the explanation in the worker's primary narrative field (`summary`,
  `evidence`, etc.); if none applies, add an `"error"` string field to the
  JSON response.
- **Partial failure** (some operations succeed, others fail): Continue with
  what works, report partial results in the structured response
- **External service failure** (`gh` not authenticated, git push fails):
  Log warning, continue with remaining work, note the limitation
- **Already processed** (task already elaborated, proposal already exists):
  Report the appropriate status (`already-exists`, `already-elaborated`)
  with existing artifact details

## Environment

- `$LUDICS_STATE_PATH`: Path to the ludics harness directory. Always available.
- `$LUDICS_RESULTS_DIR`: Directory for result JSON (when workers write results directly).
- Workers run in forked context (`context: fork`) — file reads, git operations,
  and tool outputs do not enter Mag's conversation history.
