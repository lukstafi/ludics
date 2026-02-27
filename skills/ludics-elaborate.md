# /ludics-elaborate - Task Elaboration

Elaborate a high-level task into a detailed specification.

## Trigger

This skill is invoked:
- When the user runs `ludics mag elaborate <task_id>`
- Before assigning a task to a slot
- For freshly generated tasks from the `ludics tasks sync` automation

## Arguments

- `<task_id>`: Task identifier (e.g., `task-042`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

## Process

0. **Check for duplicates**:
   - Read the task file: `cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"`
   - Search other task files for significant overlap: grep for key terms from the
     title across `$LUDICS_STATE_PATH/tasks/*.md` (exclude the task itself)
   - A task is a duplicate if another task covers the same work — look for:
     matching GitHub issue references, same feature/topic with different wording,
     README fragments that restate an existing elaborated task
   - If a duplicate is found:
     - Prefer the version that is already elaborated, or has richer context
     - Run `ludics tasks merge <target> <this_task_id>` to merge into the
       better version
     - Report the merge and stop — do NOT modify either task file further
   - If no duplicate, proceed to step 1

1. **Read task file** (if not already read in step 0):
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
   ```

2. **Gather context**:
   - Read related task files (dependencies)
   - Check GitHub issue if linked
   - Read project-specific memory: `mag/memory/projects/<project>.md`
   - Identify relevant code files in the repository

3. **Elaborate**:
   - Break down into subtasks
   - Identify specific files to modify
   - Note edge cases and potential blockers
   - Add implementation hints
   - Define test cases

4. **Update task file**:
   Expand the task with detailed specification

5. **Send questions notification** (if gaps or concerns were found):
   - If elaboration identified missing context, unclear requirements, risky edge
     cases, or other issues that need user input, formulate concise numbered
     questions
   - Send via:
     ```bash
     ludics notify outgoing "<questions text>"
     ```
     Use title: "Elaboration questions — <task-id>: <title>"
   - Skip if elaboration completed without open questions

## Output Format

### Updated Task File

The task file should be updated with additional sections:

```markdown
---
[existing frontmatter]
elaborated: 2026-02-01
---

## Context
[existing context]

## Acceptance Criteria
[refined criteria]

## Implementation Plan

[do NOT micro-manage: describe at the highest level that still captures all or most interactions between tasks]

## Technical Notes

### Code Pointers

- [...]

### Edge Cases

- [...]

## Estimated Effort
[e.g.]

Medium (2-3 days)
- Day 1: ...
- Day 2: ...
- Day 3: ...
```

### Result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "output": "Elaborated task-042 with implementation plan",
  "task_id": "task-042"
}
```

## Delegation Strategy

- **Sonnet** (via Task tool): Generate structured subtasks
- **CLI**: File navigation, code search
- **Opus**: Write detailed specification with judgment calls

## Error Handling

- Task not found: Write result with status "error"
- Already elaborated: Ask if re-elaboration is wanted
- Missing context: Note gaps and proceed with available information
