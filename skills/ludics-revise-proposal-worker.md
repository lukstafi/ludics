---
name: ludics-revise-proposal-worker
description: Re-examine codebase, revise task notes and proposal document
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# Revise Proposal Worker — Task Notes & Proposal Revision

You are a worker subagent invoked by the `/ludics-revise-proposal` orchestrator.
Your job: re-examine the codebase and existing proposal, then make two kinds of
edits — additive notes on the task file, and destructive revision of the proposal.

Follow the conventions in [worker-conventions.md](worker-conventions.md).

## Arguments

`$ARGUMENTS` format: `<task_id> <project_path> [<context_brief>]`

- `<task_id>`: Task identifier (e.g., `task-042`)
- `<project_path>`: Absolute path to the project's local checkout
- `<context_brief>`: Optional free-form context from the orchestrator, often
  including user feedback (see worker-conventions.md § Broader Context)

## Process

1. **Read task file**:
   Parse `$ARGUMENTS` to extract the task ID (first word) and project path
   (second word). Any remaining text after the second word is the context brief.
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
   ```
   Extract: title, project, proposal path, dependencies, acceptance criteria,
   elaboration content, any existing notes.

2. **Read existing proposal**:
   Read the proposal file at `<project_path>/<proposal_path>` (from the task's
   `proposal:` frontmatter field). Understand the current approach, scope, and
   structure.

3. **Explore relevant codebase**:
   - Re-read source files referenced in the proposal
   - Check if anything has changed since the proposal was written
   - Look for new context that affects the approach
   - Focus exploration on areas where the proposal may be wrong or outdated

4. **Edit task file (additive)**:
   Add or correct content in the task file. This is the persistent record, so
   treat it carefully:
   - **Add** a `## Notes` section (or append to existing one) with observations
     discovered during revision — things the coding agent should know
   - **Correct** factual errors (wrong file paths, outdated API references,
     incorrect assumptions about current state)
   - **Update** acceptance criteria if they were unclear or incomplete
   - **Preserve** existing structure — don't reorganize or rewrite sections
     that are correct
   - **Don't remove** content unless it's demonstrably wrong

5. **Edit proposal file (destructive)**:
   The proposal is a working document. Revise it aggressively:
   - **Rewrite** the approach if it's off-track or based on incorrect assumptions
   - **Cut** premature implementation details — sections that micro-manage the
     "how" rather than specifying the "what" and "why"
   - **Shorten** sections that over-specify. The proposal will often get shorter
     and sharper on each revision
   - **Tighten** scope if it's too broad or includes nice-to-haves
   - **Update** "Current State" if the codebase has changed
   - **Incorporate** user feedback from the context brief
   - **Maintain** the same section structure (Motivation, Current State,
     Proposed Change, Scope) unless a section is genuinely empty

6. **Commit and push**:
   ```bash
   cd <project_path>
   git add docs/<proposal-file>.md
   git commit -m "proposal: revise <title>"
   git push
   ```
   Also commit the task file changes:
   ```bash
   cd "$LUDICS_STATE_PATH"
   git add tasks/<task_id>.md
   git commit -m "task: add notes for <task_id>"
   git push
   ```

7. **Assess changes**:
   If after re-examination the proposal is already solid and no meaningful
   changes were needed, report `STATUS: no-changes` instead of making
   trivial edits.

## Final Response

Use the structured response format from worker-conventions.md with these fields:

```
STATUS: revised | no-changes | error
TASK_ID: <task-id>
PROPOSAL_PATH: <relative path, e.g. docs/<feature>.md> (omit if no-changes/error)
CHANGES_SUMMARY: <2-3 sentence summary of what was changed and why>
TITLE: <task title>
SUMMARY: <one-line summary for the notification>
```

## Error Handling

- Task not found: Report `STATUS: error` with explanation
- Proposal file not found: Report `STATUS: error` — orchestrator should not
  have invoked revision without a proposal
- Project path not found: Report `STATUS: error`
- Git push fails: Log warning, continue — edits are still written locally
