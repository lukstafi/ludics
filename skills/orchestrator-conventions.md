# Orchestrator Conventions

Shared conventions for all orchestrator skills. Each orchestrator references
this file by section letter — follow the referenced sections exactly.

## Section A — Task Resolution (task-based orchestrators only)

Read the task file for Mag's awareness:

```bash
cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

- Extract frontmatter fields: `title`, `project`, `slot`
- Extra fields (e.g., `proposal:`) are skill-specific — parse them in the
  skill, not here
- If task file not found: write error result JSON (per Section E), stop
- Argument parsing beyond the task ID is skill-specific (revise-proposal
  appends feedback; feedback-digest takes `<repo>` instead of `<task_id>`)

## Section B — Project Path Resolution (task-based orchestrators only)

- Look up `project` in `$LUDICS_STATE_PATH/config.yaml`
- Each config entry has a `repo` field; local checkout is `~/<repo-name>`
- The `personal` project refers to the state repository itself
- Skill-specific path extensions (e.g., draft-proposal's `proposals_path`
  probe) are documented in the skill, not here

## Section C — Context Brief Composition (task-based orchestrators only)

Write a short free-form context brief (3-10 lines) from Mag's conversation
history. Standard sources:

- Related tasks that cover adjacent ground (overlap or dependency risks)
- User preferences for scope, approach, or priorities
- Recent decisions or discussions relevant to this task's domain
- Cross-slot awareness (what other slots are working on)
- Known staleness signals or priority shifts

If nothing relevant, pass an empty brief. Skill-specific additions (e.g.,
revise-proposal includes user feedback verbatim) are noted in each skill.

## Section D — Worker Delegation

- Invoke `/ludics-<name>-worker <args...>`
- Worker runs in forked context (`context: fork`) — its file reads, git
  operations, and tool outputs do not enter Mag's conversation history
- Only the worker's structured response returns to the orchestrator
- Each orchestrator parses its own required response fields (STATUS plus
  skill-specific keys); do not assume a shared field set across workers

## Section E — Result JSON

Read the request ID and write the result file:

- Read request ID from `$LUDICS_STATE_PATH/mag/current-request-id`
- Write to `$LUDICS_RESULTS_DIR/$REQ_ID.json`
- Required fields in every result:

```json
{
  "id": "<request-id>",
  "status": "<outcome>",
  "timestamp": "<ISO-8601>",
  "output": "<human-readable summary>"
}
```

- Skill-specific fields (`proposal_path`, `verdict`, `followup_tasks`,
  `issues_created`, etc.) are documented in each skill

## Section F — Error Handling

- Task not found: result with `"status": "error"`, descriptive output
- Worker returns `STATUS: error`: propagate to result JSON
- Notification fails: log warning, continue (do not fail the skill)
- External tool failure (gh, git push): log, continue with remaining work

## Environment

- `$LUDICS_STATE_PATH`: Path to the ludics harness directory. Always available.
- `$LUDICS_RESULTS_DIR`: Directory for result JSON files.
- Orchestrators run inline in Mag's context — keep side effects minimal
  (task file reads, notifications, result writing).
