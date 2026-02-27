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

## Arguments

`$ARGUMENTS` format: `<task_id> <project_path>`

- `<task_id>`: Task identifier (e.g., `task-042`)
- `<project_path>`: Absolute path to the project's local checkout

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)

## Process

1. **Read task file**:
   Parse `$ARGUMENTS` to extract the task ID (first word) and project path (second word).
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
     report `"status": "stale"` in your final response and stop.

5. **Check for multi-concern**:
   - If the task covers multiple independent concerns (different modules,
     separable features, could be merged to main independently), report
     `"status": "split-needed"` and stop. The orchestrator will queue the
     split skill.

6. **Determine docs directory**:
   - Check if `docs/`, `doc/`, or project root has existing documentation
   - Use `docs/` by default; create if needed

7. **Write proposal** to `<project_path>/docs/<feature-name>.md`:

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
   ```bash
   cd <project_path>
   git add docs/<feature>.md
   git commit -m "proposal: <title>"
   git push
   ```

9. **Update task frontmatter**: Set `proposal: docs/<feature>.md` in the task file.
   Add the field before the closing `---` in the YAML frontmatter.

## Final Response

Your final response MUST be a structured summary that the orchestrator can parse.
Include these fields clearly:

```
STATUS: completed | stale | split-needed | already-exists | error
TASK_ID: <task-id>
PROPOSAL_PATH: <relative path, e.g. docs/<feature>.md> (omit if stale/split-needed/error)
AMBIGUITIES: <numbered list of ambiguities, or "none">
TITLE: <task title>
SUMMARY: <one-line summary of what was proposed>
```

Keep the response concise — the orchestrator handles notifications and result JSON.

## Error Handling

- Task not found: Report `STATUS: error` with explanation
- Project path not found: Report `STATUS: error`
- Already has proposal: Report `STATUS: already-exists` with the existing path
- Git push fails: Log warning, continue — the proposal is still written locally
