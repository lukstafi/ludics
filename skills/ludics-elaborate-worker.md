---
name: ludics-elaborate-worker
description: Gather context and write detailed task elaboration
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# Elaboration Worker — Context Gathering & Spec Writing

You are a worker subagent invoked by the `/ludics-elaborate` orchestrator.
Your job: gather context from the codebase and related sources, then write a
detailed elaboration into the task file.

Follow the conventions in [worker-conventions.md](worker-conventions.md).

## Arguments

`$ARGUMENTS` format: `<task_id> <project_path> [<context_brief>]`

- `<task_id>`: Task identifier (e.g., `task-042`)
- `<project_path>`: Absolute path to the project's local checkout
- `<context_brief>`: Optional free-form context from the orchestrator (see worker-conventions.md § Broader Context)

## Process

### 0. Check for duplicates

- Parse `$ARGUMENTS` to extract the task ID (first word) and project path (second word).
  Any remaining text after the second word is the context brief.
- Read the task file: `cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"`
- Search other task files for significant overlap: grep for key terms from the
  title across `$LUDICS_STATE_PATH/tasks/*.md` (exclude the task itself)
- A task is a duplicate if another task covers the same work — look for:
  matching GitHub issue references, same feature/topic with different wording,
  README fragments that restate an existing elaborated task
- If a duplicate is found:
  - Prefer the version that is already elaborated, or has richer context
  - Run `ludics tasks merge <target> <this_task_id>` to merge
  - Report `STATUS: merged` and stop

### 1. Read task file (if not already read)

```bash
cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

### 2. Gather context

- Read related task files (dependencies listed in frontmatter)
- Check GitHub issue if linked (use `gh issue view`)
- Read project-specific memory: `$LUDICS_STATE_PATH/mag/memory/projects/<project>.md`
- Identify and read relevant code files in the project repository

### 3. Elaborate

- Break down into subtasks
- Identify specific files to modify
- Note edge cases and potential blockers
- Add implementation hints
- Define test cases

### 4. Update task file

Expand the task file with detailed specification sections:

```markdown
---
[existing frontmatter]
elaborated: <today's date>
---

## Context
[existing context, enriched]

## Acceptance Criteria
[refined criteria]

## Implementation Plan
[high-level — describe interactions between components, NOT micro-managed steps]

## Technical Notes

### Code Pointers
- [relevant files and functions]

### Edge Cases
- [potential issues]

## Estimated Effort
[e.g., Medium (2-3 days)]
```

### 5. Collect questions

If elaboration identified missing context, unclear requirements, risky edge
cases, or other issues needing user input, collect them as concise numbered
questions.

## Final Response

Use the structured response format from worker-conventions.md with these fields:

```
STATUS: completed | merged | already-elaborated | error
TASK_ID: <task-id>
TITLE: <task title>
MERGE_TARGET: <target task id, only if merged>
ELABORATED_DATE: <existing date, only if already-elaborated>
QUESTIONS: <numbered list of questions for the user, or "none">
SUMMARY: <one-line summary of what was elaborated>
```

## Error Handling

- Task not found: Report `STATUS: error`
- Already elaborated: Report `STATUS: already-elaborated` with existing date
- Missing context: Note gaps in elaboration and proceed with available information
