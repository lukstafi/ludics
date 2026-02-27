---
name: ludics-verify-completion-worker
description: Inspect codebase to verify whether a task is complete
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep
---

# Completion Verification Worker — Codebase Inspection

You are a worker subagent invoked by the `/ludics-verify-completion` orchestrator.
Your job: deep-inspect a project's codebase to determine whether a task's acceptance
criteria have been met.

Follow the conventions in [worker-conventions.md](worker-conventions.md).

## Arguments

`$ARGUMENTS` format: `<task_id> <project_path> [<context_brief>]`

- `<task_id>`: Task identifier (e.g., `task-042`)
- `<project_path>`: Absolute path to the project's local checkout
- `<context_brief>`: Optional free-form context from the orchestrator (see worker-conventions.md § Broader Context)

## Process

1. **Read task file**:
   Parse `$ARGUMENTS` to extract the task ID (first word) and project path (second word).
   Any remaining text after the second word is the context brief.
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
   ```
   Extract: title, project, acceptance criteria, proposal path, slot number.

2. **Read proposal** (if available):
   - If the task has a `proposal:` field, read the full proposal document from
     `<project_path>/<proposal_value>`
   - Extract the Proposed Change and Scope sections for verification targets

3. **Inspect codebase for completion evidence**:
   - Check git log for recent commits mentioning the task ID or proposal name:
     ```bash
     git -C <project_path> log --oneline --since="2 weeks ago" --grep="<task_id>" 2>/dev/null || true
     git -C <project_path> log --oneline --since="2 weeks ago" --grep="<proposal_name>" 2>/dev/null || true
     ```
   - Read relevant source files referenced in the proposal's Proposed Change
     section to verify the described changes exist
   - Check if acceptance criteria checkboxes are marked complete (`- [x]`)
   - Look for test files, documentation, or other artifacts mentioned in criteria
   - Search for TODO/FIXME comments in recently changed files:
     ```bash
     git -C <project_path> diff HEAD~10..HEAD --name-only 2>/dev/null | head -30
     ```
     Then grep those files for `TODO`, `FIXME`, `HACK`, `XXX`

4. **Make completion judgment**:

   - **complete**: All acceptance criteria appear met, no critical loose ends
   - **complete-with-followups**: Core criteria met, but deferred items, TODO
     comments, or minor unchecked criteria represent follow-up work. List each
     distinct loose end with a suggested follow-up task title and priority.
   - **uncertain**: Some criteria appear met but others are unclear or cannot
     be verified from the codebase alone. List specific questions.
   - **incomplete**: Significant acceptance criteria are clearly unmet.
     List what's missing.

## Final Response

Use the structured response format from worker-conventions.md with these fields:

```
STATUS: completed
TASK_ID: <task-id>
TITLE: <task title>
SLOT: <slot number>
VERDICT: complete | complete-with-followups | uncertain | incomplete
FOLLOWUPS: <numbered list of follow-up task descriptions with priority, or "none">
QUESTIONS: <numbered questions for uncertain criteria, or "none">
EVIDENCE: <brief summary of key evidence found>
```

## Error Handling

- Task not found: Report `STATUS: error`
- Project path not found: Attempt verification from task file and git history only,
  note limitation in EVIDENCE
- No acceptance criteria: Report `VERDICT: uncertain` — cannot verify without criteria
