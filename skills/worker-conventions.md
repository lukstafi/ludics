# Worker Conventions

Shared conventions for worker subagents. Each worker skill references this file.

## Argument Parsing

Workers receive arguments via `$ARGUMENTS`. Parse positionally:

```
$ARGUMENTS format: <arg1> <arg2> [<arg3>...]
```

Split on whitespace. The first word is typically a task ID or repo identifier;
subsequent words are paths or additional parameters.

## Broader Context

Some workers receive a `<context_brief>` as a trailing argument — free-form
text (3-10 lines) the orchestrator composes from Mag's conversation history.
When present:

- Use it for judgment calls (scope, staleness, priority).
- Treat it as a hint, not ground truth — verify claims against the codebase.
- Don't echo it verbatim in outputs.
- If absent or empty, proceed using only the codebase and task file.

## Structured Response Format

Your final response includes a fenced ` ```json ``` ` block as the **last code
block** in the response. All structured fields go inside it.

```json
{
  "status": "<status_value>",
  "field_name": "<value>"
}
```

- `status` is always present and is the primary routing field.
- Common status values: `"completed"`, `"error"`, `"stale"`, `"split-needed"`,
  `"already-exists"`, `"merged"`, `"already-elaborated"`, `"empty"`.
- Field names use snake_case.
- Multi-value fields use JSON arrays (e.g., `"questions": ["q1", "q2"]`); use
  the string `"none"` when a list is empty.
- Free-form explanation text may precede the JSON block; the JSON block is
  still the last fenced code block.
- Keep responses concise — the orchestrator handles notifications, result JSON,
  and downstream actions.

## Field Annotations

Each worker documents response fields in a "Response Contract" with:

- **required**: always present in non-error responses. List-like required
  fields use `"none"` when empty.
- **conditional**: present only when the stated condition holds. Omitted
  entirely otherwise — never `null`.

When `status` is `"error"`, only `status` plus a narrative field are
guaranteed; other fields may be absent. Orchestrators handle missing
conditional fields gracefully.

## Field Contract Reference

Canonical cross-skill reference for field types and required/conditional/optional
annotations across all worker/orchestrator pairs. Each worker skill keeps its
own `### Response Contract` section with full prose and examples — this table
summarises, it does not replace. Vocabulary matches "Field Annotations" above.

| Skill pair | Field | Type | Annotation | Condition / Notes |
|---|---|---|---|---|
| elaborate | `status` | string | required | `completed` / `merged` / `already-elaborated` / `error` |
| elaborate | `task_id` | string | required | echoes input |
| elaborate | `title` | string | required | |
| elaborate | `merge_target` | string | conditional | when `status = "merged"` |
| elaborate | `elaborated_date` | string | conditional | when `status = "already-elaborated"` |
| elaborate | `questions` | string[] | required | `"none"` when empty |
| elaborate | `summary` | string | required | |
| draft-proposal | `status` | string | required | `completed` / `stale` / `split-needed` / `already-exists` / `error` |
| draft-proposal | `task_id` | string | required | |
| draft-proposal | `proposal_path` | string | conditional | when `status ∈ {completed, already-exists}` |
| draft-proposal | `ambiguities` | string[] | required | `"none"` when empty |
| draft-proposal | `start_confidence` | string | conditional | when `status = "completed"`; `high` / `low` |
| draft-proposal | `start_rationale` | string | conditional | when `status = "completed"` |
| draft-proposal | `title` | string | required | |
| draft-proposal | `summary` | string | required | |
| draft-proposal | `skip_plan` | boolean | optional | when `status = "completed"`; written to frontmatter when `true` |
| revise-proposal | `status` | string | required | `revised` / `no-changes` / `error` |
| revise-proposal | `task_id` | string | required | |
| revise-proposal | `proposal_path` | string | conditional | when `proposal_mode = "file"`; omitted for inline |
| revise-proposal | `proposal_mode` | string | conditional | required when `status = "revised"`; orchestrator must not default to `"file"` |
| revise-proposal | `changes_summary` | string | required | |
| revise-proposal | `title` | string | required | |
| revise-proposal | `summary` | string | required | |
| verify-completion | `status` | string | required | always `"completed"` in non-error cases |
| verify-completion | `task_id` | string | required | |
| verify-completion | `title` | string | required | |
| verify-completion | `slot` | number | required | error if verdict requires slot clearing |
| verify-completion | `verdict` | string | required | `complete` / `complete-with-followups` / `uncertain` / `incomplete` |
| verify-completion | `followups` | object[] | required | `{title, priority}`; `"none"` when empty |
| verify-completion | `questions` | string[] | required | `"none"` when empty |
| verify-completion | `evidence` | string | required | |
| feedback-digest | `status` | string | required | `completed` / `empty` / `error` |
| feedback-digest | `issues_created` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `issues_updated` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `issues_skipped` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `files_processed` | number | required | 0 when none; may be absent on `status = "error"` only |
| feedback-digest | `summary` | string | required | |

## Error Handling

- **Missing input** (task not found, path not found): set `"status": "error"`
  and put the explanation in the primary narrative field (`summary`,
  `evidence`, etc.); if none applies, add an `"error"` string field.
- **Partial failure**: continue with what works, report partial results in
  the structured response.
- **External service failure** (`gh` not authenticated, git push fails):
  log a warning, carry on, note the limitation.
- **Already processed**: report the appropriate status (`already-exists`,
  `already-elaborated`) with the existing artifact details.

## Environment

- `$LUDICS_STATE_PATH`: path to the ludics harness directory (always set).
- `$LUDICS_RESULTS_DIR`: directory for result JSON (when workers write
  results directly).
- Workers run in a forked context (`context: fork`) — file reads, git
  operations, and tool outputs stay out of Mag's conversation history.
