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

<!-- section:arguments -->
## Arguments

`$ARGUMENTS` format: `<task_id> <project_path> [<context_brief>]`

- `<task_id>`: Task identifier (e.g., `task-042`)
- `<project_path>`: Absolute path to the project's local checkout
- `<context_brief>`: Optional free-form context from the orchestrator (see worker-conventions.md § Broader Context)

<!-- section:process -->
## Process

<!-- section:check-duplicates -->
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
  - Report `status: "merged"` and stop

<!-- section:milestone-blocking -->
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

<!-- section:read-task -->
### 1. Read task file (if not already read)

```bash
cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

<!-- section:gather-context -->
### 2. Gather context

- Read related task files (dependencies listed in frontmatter)
- Check GitHub issue if linked (use `gh issue view`)
- Read project-specific memory: `$LUDICS_STATE_PATH/mag/memory/projects/<project>.md`
- Identify and read relevant code files in the project repository

<!-- section:cross-task-awareness -->
### 3. Cross-task awareness

- Check for related tasks (same project, similar scope, overlapping files)
- Check milestone dependencies and ordering
- Note if this task would conflict with or be subsumed by other work
- Note any project-wide patterns or conventions relevant to this task

<!-- section:explore-codebase -->
### 4. Explore codebase for context

Explore the codebase to understand the current state:
- Identify relevant files, patterns, architecture
- Note edge cases and potential blockers
- Understand what exists vs. what needs to be built

Write findings as a **Tentative Design** section, clearly marked:

> Reference code by function, type, or symbol name, not raw line number —
> line numbers drift as other PRs merge between elaboration and
> implementation. For precise placement, quote a short distinctive snippet
> or anchor to a nearby named boundary.

```markdown
## Tentative Design

*Agent analysis — not validated by user.*

### Code Pointers
- [relevant files and functions by name — do NOT use line numbers, they drift before implementation]
- When line-level precision is needed, quote a short distinctive code snippet or reference the nearest function/symbol boundary

### Observations
- [what exists, patterns, potential approaches]

### Edge Cases
- [potential issues to consider]
```

<!-- section:surface-ambiguities -->
### 5. Surface ambiguities and questions

Genuine ambiguities look like:
- Source intent is unclear and multiple reasonable interpretations exist.
- A design choice matters and is debatable (not obvious from context).
- Missing information would meaningfully change the implementation approach.
- The approach is a creative choice (flag for possible duo-mode experiment).

Write a **Questions** section:

```markdown
## Questions

1. [Specific question about a real ambiguity]
2. [Design option where choice matters: "Option A does X, Option B does Y — which?"]
```

Skip questions that:
- Can be answered by reading the codebase.
- Are implementation details the agent should decide.
- Ask permission to proceed — just note the trade-off instead.

If there are no genuine questions, write `## Questions\n\nNone.`

<!-- section:update-task -->
### 6. Update task file

The elaboration does NOT write acceptance criteria — those belong in the
proposal phase, after questions are resolved.

```markdown
---
[existing frontmatter]
elaborated: <today's date>
---

## Context
[existing context, enriched with source quote from GitHub issue]

## Tentative Design

*Agent analysis — not validated by user.*

[code pointers by function/type/symbol name (no line numbers), observations, edge cases]

## Questions

[numbered questions about genuine ambiguities, or "None."]
```

<!-- section:final-response -->
## Final Response

Use the structured response format from worker-conventions.md. Emit a fenced JSON block
as the last code block in your response:

<!-- section:response-contract -->
### Response Contract

1. `status` — string, required. Values: `"completed"`, `"merged"`, `"already-elaborated"`, `"error"`.
2. `task_id` — string, required.
3. `title` — string, required.
4. `merge_target` — string, conditional. Present only when `status = "merged"`.
5. `elaborated_date` — string, conditional. Present only when `status = "already-elaborated"`.
6. `questions` — string[], required. `"none"` when empty.
7. `summary` — string, required.

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

<!-- section:error-handling -->
## Error Handling

- Task not found: Report `status: "error"`
- Already elaborated: Report `status: "already-elaborated"` with existing date
- Missing context: Note gaps in elaboration and proceed with available information
