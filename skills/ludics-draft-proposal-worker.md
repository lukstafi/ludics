---
name: ludics-draft-proposal-worker
description: Explore codebase and write proposal document for a task
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write
---

# Proposal Worker — Codebase Exploration & Document Writing

You are a worker subagent invoked by the `/ludics-draft-proposal` orchestrator.
Your job: explore a project's codebase, assess the task, and write a proposal document.

Follow the conventions in [worker-conventions.md](worker-conventions.md).

## Arguments

`$ARGUMENTS` format: `<task_id> <project_path> <proposals_path> [<context_brief>]`

- `<task_id>`: Task identifier (e.g., `task-042`)
- `<project_path>`: Absolute path to the project's local checkout
- `<proposals_path>`: Absolute path to the proposals directory (pre-resolved by orchestrator)
- `<context_brief>`: Optional free-form context from the orchestrator (see worker-conventions.md § Broader Context)

## Process

1. **Read task file**:
   Parse `$ARGUMENTS` to extract the task ID (first word), project path (second word), and
   proposals path (third word). Any remaining text after the third word is the context brief.
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
   ```
   Extract: title, project, dependencies, context, any linked GitHub issue,
   acceptance criteria, elaboration content.

2. **Resolve project path**: Use the project path from `$ARGUMENTS`. If the
   `personal` project, use `$LUDICS_STATE_PATH/..` (the state repository root).

3. **Explore project codebase**:
   - Read relevant source files mentioned in the task elaboration
   - Understand existing patterns, architecture, related code
   - Check for existing docs, README, ARCHITECTURE files

4. **Surface task-statement ambiguities**:
   - Cross-check the task description and elaboration against the codebase.
     Watch out for staleness, unjustified assumptions, missing context.
   - If the task is clearly stale (work already done or goal no longer applies),
     report `STATUS: stale` in your final response and stop.

5. **Check for multi-concern**:
   - If the task covers multiple independent concerns (different modules,
     separable features, could be merged to main independently), report
     `STATUS: split-needed` and stop. The orchestrator will queue the
     split skill.

6. **Use provided proposals path**:
   Create the directory if it doesn't exist:
   ```bash
   mkdir -p "<proposals_path>"
   ```

7. **Write proposal** to `<proposals_path>/<feature-name>.md`:

   ```markdown
   # <Title>

   ## Motivation
   Why this change is needed. Link to issue if applicable.

   ## Current State
   How things work now. Key files and code pointers.

   ## Proposed Change
   What should change. Acceptance criteria. Edge cases to consider.

   ## Scope
   What's in/out of scope. Dependencies on other tasks.
   ```

   **Key:** No implementation plan, no effort estimates, no micro-managed steps.
   Why/What focus. Coding agents handle the How via their own plan/clarify phases.

8. **Commit and push**:
   Strip the `<project_path>/` prefix from `<proposals_path>` to get the repo-relative path:
   ```bash
   cd <project_path>
   git add <proposals_path_relative>/<feature>.md
   git commit -m "proposal: <title>"
   git push
   ```

9. **Update task frontmatter**: Set `proposal: <proposals_path_relative>/<feature-name>.md`
   (e.g., `proposal: docs/proposals/add-filter.md`) in the task file.
   Add the field before the closing `---` in the YAML frontmatter.

## Final Response

Use the structured response format from worker-conventions.md with these fields:

```
STATUS: completed | stale | split-needed | already-exists | error
TASK_ID: <task-id>
PROPOSAL_PATH: <relative path, e.g. <proposals_path_relative>/<feature>.md> (omit if stale/split-needed/error)
AMBIGUITIES: <numbered list of ambiguities, or "none">
START_CONFIDENCE: high | low
START_RATIONALE: <one sentence explaining confidence level>
TITLE: <task title>
SUMMARY: <one-line summary of what was proposed>
```

**START_CONFIDENCE guidance:**
- `high`: task is a clear, bounded improvement with specific scope — derived from
  a concrete user request, a well-defined GitHub issue, or a clearly actionable
  elaboration
- `low`: task is exploratory/speculative ("consider", "study", "look into"), has
  unresolved ambiguities that affect scope, or the elaboration is suspiciously
  overconfident for a vague task statement
- Vague acceptance criteria alone do NOT warrant `low` — improvements can be
  refined in follow-up work
- This is advisory only; the orchestrator makes the final decision

## Error Handling

- Task not found: Report `STATUS: error` with explanation
- Project path not found: Report `STATUS: error`
- Already has proposal: Report `STATUS: already-exists` with the existing path
- Git push fails: Log warning, continue — the proposal is still written locally
