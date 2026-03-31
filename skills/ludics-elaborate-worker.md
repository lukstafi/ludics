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

### 0b. Milestone-aware blocking (watch tasks)

For tasks with `source: watch` (README-derived), determine which **milestone
section** the source line belongs to. OCANNL milestones follow this order:

  v0.7.0 → v0.7.1 → v0.8 → v0.9 → v1.0

Steps:
1. Read the project's README.md (or ROADMAP.md) and locate the source line
   referenced in the task's Context section.
2. Identify which milestone section that line falls under.
3. Check the milestone dependency chains in Mag's memory
   (`$LUDICS_STATE_PATH/mag/memory/MEMORY.md`, section "Milestone Dependency
   Chains") for known gate tasks in prior milestones.
4. Set `blocked_by` in the frontmatter to at least one representative gate
   task from the immediately prior milestone. For example, a v0.8 task should
   be blocked by a v0.7 gate task; a v1.0 task should be blocked by v0.9 work.
5. If the prior milestone has no completed gate task, set `status: blocked`.
6. If the task is a **meta-task** (umbrella for multiple sub-tasks, e.g.,
   "resolve a few explore issues"), set `status: blocked` and note in the
   elaboration that it depends on prior milestone completion.

This prevents premature scheduling of tasks whose prerequisites aren't done.

### 1. Read task file (if not already read)

```bash
cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

### 2. Gather context

- Read related task files (dependencies listed in frontmatter)
- Check GitHub issue if linked (use `gh issue view`)
- Read project-specific memory: `$LUDICS_STATE_PATH/mag/memory/projects/<project>.md`
- Identify and read relevant code files in the project repository

### 3. Derive authoritative acceptance criteria

**Source-first**: Before any codebase exploration, read the authoritative source:
- GitHub issue body + comments (via `gh issue view <number> --repo <repo> --json body,comments`)
- Task creation context (from the Context section)
- Explicit user decisions noted in the task file

**Write Acceptance Criteria from the source ONLY:**
- Each criterion must be directly derivable from the source — no agent inferences
- If the source says "consider X", the criterion is "evaluate X and document the decision", NOT "implement X"
- If the source is vague or exploratory, keep criteria vague: "investigate and report findings"
- Do NOT add implementation details, code locations, or design decisions to this section

### 4. Explore codebase and write tentative design

Now explore the codebase for implementation context:
- Identify specific files to modify, relevant code patterns
- Note edge cases and potential blockers
- Consider implementation approaches

Write this as a **Tentative Design** section, clearly marked:

```markdown
## Tentative Design

*Agent analysis — not validated by user.*

[implementation ideas, code pointers, trade-offs]
```

### 5. Collect questions

Identify **genuine ambiguities** where:
- The source intent is unclear and multiple reasonable interpretations exist
- A design choice matters AND is debatable (not obvious from context)
- Missing information would significantly change the implementation approach

Write a **Questions** section in the task file:

```markdown
## Questions

1. [Specific question about a real ambiguity]
2. [Design option where choice matters: "Option A does X, Option B does Y — which?"]
```

Do NOT ask questions that:
- Can be answered by reading the codebase
- Are implementation details (agent should decide these)
- Ask permission to proceed (just note the trade-off)

If there are no genuine questions, write `## Questions\n\nNone.`

### 6. Update task file

Expand the task file with the sections above:

```markdown
---
[existing frontmatter]
elaborated: <today's date>
---

## Context
[existing context, enriched with source quote]

## Acceptance Criteria
[authoritative — derived from user intent only]

## Tentative Design

*Agent analysis — not validated by user.*

[implementation ideas, code pointers, edge cases, effort estimate]

## Questions

[numbered questions about genuine ambiguities, or "None."]
```

## Final Response

Use the structured response format from worker-conventions.md. Emit a fenced JSON block
as the last code block in your response:

```json
{
  "status": "completed | merged | already-elaborated | error",
  "task_id": "<task-id>",
  "title": "<task title>",
  "merge_target": "<target task id — include only if status is merged>",
  "elaborated_date": "<existing date — include only if status is already-elaborated>",
  "questions": ["<question 1>", "<question 2>"],
  "summary": "<one-line summary of what was elaborated>"
}
```

Omit `merge_target` and `elaborated_date` when not applicable. Use `"none"` for
`questions` when there are no questions.

## Error Handling

- Task not found: Report `STATUS: error`
- Already elaborated: Report `STATUS: already-elaborated` with existing date
- Missing context: Note gaps in elaboration and proceed with available information
