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

Your final response MUST use this key-value format so the orchestrator can parse it:

```
STATUS: <status_value>
FIELD_NAME: <value>
```

Rules:
- **STATUS** is always the first field and is required
- Common status values: `completed`, `error`, `stale`, `split-needed`,
  `already-exists`, `merged`, `already-elaborated`, `empty`
- Each field is on its own line: `FIELD_NAME: value`
- Multi-item values use comma-separated format or numbered lists
- Keep the response concise — the orchestrator handles notifications,
  result JSON, and downstream actions

## Error Handling

Follow these conventions for all error conditions:

- **Missing input** (task not found, path not found): Report `STATUS: error`
  with a clear explanation in SUMMARY
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
