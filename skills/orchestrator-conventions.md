# Orchestrator Conventions

Shared conventions for orchestrator skills. Each orchestrator references
this file by section letter.

## Scope posture

When composing context briefs, surfacing verifier follow-ups, or framing
worker requests, treat acceptance criteria as a floor (every criterion must
be met) but not a ceiling (small adjacent fixes can be absorbed without
spawning a follow-up). See
[scope: floor, not ceiling](../docs/orchestration-patterns.md#scope-floor-not-ceiling)
for the absorb/declare/reject boundary; do not pressure workers to defer
fixes that fit the absorb tier.

## Section A — Task Resolution (task-based orchestrators only)

Read the task file so Mag has it in context:

```bash
cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

- Extract frontmatter fields: `title`, `project`, `slot`.
- Extra fields (e.g., `proposal:`) are skill-specific — parse them in the skill.
- If the task file isn't found, write an error result (Section E) and stop.
- Argument parsing beyond the task ID is skill-specific (e.g., revise-proposal
  appends feedback; feedback-digest takes a repo instead).

## Section B — Project Path Resolution (task-based orchestrators only)

- Look up `project` in `$LUDICS_STATE_PATH/config.yaml`.
- Each config entry has a `repo` field; the local checkout is `~/<repo-name>`.
- The `personal` project refers to the state repository itself.
- Skill-specific path extensions (e.g., draft-proposal's `proposals_path`
  probe) live in the skill, not here.

## Section C — Context Brief Composition (task-based orchestrators only)

Write a short free-form context brief (3-10 lines) drawn from Mag's
conversation history. Typical sources:

- Related tasks that cover adjacent ground (overlap or dependency risks)
- User preferences for scope, approach, or priorities
- Recent decisions relevant to this task's domain
- What other slots are working on
- Staleness signals or priority shifts

If nothing is relevant, pass an empty brief. Skill-specific additions (e.g.,
revise-proposal includes user feedback verbatim) are noted in each skill.

## Section D — Worker Delegation

- Invoke `/ludics-<name>-worker <args...>`.
- The worker runs in a forked context (`context: fork`), so its file reads,
  git operations, and tool outputs stay out of Mag's conversation history.
- Only the worker's structured response returns to the orchestrator.
- Each orchestrator parses the worker JSON for `status` plus skill-specific
  fields. The per-skill field set is documented in "Expected Worker Fields".
- The canonical cross-skill reference for field types and
  `required` / `conditional` / `optional` annotations is the "Field Contract
  Reference" table in `worker-conventions.md`. Per-skill routing tables here
  remain the source for `Used for` and `Missing-field fallback` behaviour.

## Section E — Result JSON

Read the request ID and write the result file:

- Request ID comes from `$LUDICS_STATE_PATH/mag/current-request-id`.
- Write to `$LUDICS_RESULTS_DIR/$REQ_ID.json`.
- Required fields in every result:

```json
{
  "id": "<request-id>",
  "action": "<skill-action-name>",
  "status": "<outcome>",
  "timestamp": "<ISO-8601>",
  "output": "<human-readable summary>"
}
```

- `action` is the queue action name (e.g., `"elaborate"`, `"draft-proposal"`,
  `"health-check"`, `"process-suggestions"`), used by the dashboard queue panel.
- Skill-specific fields (`proposal_path`, `verdict`, `followup_tasks`,
  `issues_created`, etc.) are documented in each skill.

## Section F — Error Handling

- Task not found: result with `"status": "error"` and a descriptive output.
- Worker returns `"status": "error"`: propagate to the result JSON.
- Each orchestrator documents per-field fallback behavior in "Expected
  Worker Fields".
- **State-mutation failure** (slot clear/start, task creation): report the
  failure in the result JSON rather than continuing as if successful —
  silent failures here desync Mag from actual repo/slot state.
- Notification failure: log a warning and carry on.
- Best-effort tool failure (editor open, `gh` for non-critical ops): log
  and carry on with the remaining work.

## Environment

- `$LUDICS_STATE_PATH`: path to the ludics harness directory (always set).
- `$LUDICS_RESULTS_DIR`: directory for result JSON files.
- Orchestrators run inline in Mag's context — keep side effects light
  (task reads, notifications, result writing).
