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

2. **Detect proposal mode and read existing proposal**:

   Check the `proposal:` frontmatter value extracted in step 1.

   **File-based mode** (`proposal:` is any value other than `inline`):

   a. Resolve to absolute path:
      ```bash
      case "<proposal_path>" in
        ~/*)  proposal_abs="$HOME/${<proposal_path>#~/}" ;;
        /*)   proposal_abs="<proposal_path>" ;;
        *)    proposal_abs="<project_path>/<proposal_path>" ;;
      esac
      ```

   b. Verify the file is inside the project tree (can be committed):
      ```bash
      proposal_rel=$(python3 -c \
        "import os; r=os.path.relpath('$proposal_abs','<project_path>'); print(r)")
      ```
      If `$proposal_rel` starts with `..` or equals `..`, the proposal lives outside the
      project repo and cannot be committed. Report `status: "error"` with this message and stop:
      ```
      Proposal file is outside the project tree (<proposal_abs>). Cannot revise and commit
      safely. Move the proposal to <project_path>/<proposals_path>/<feature>.md and update
      the task frontmatter, then re-run revise-proposal.
      ```
      Do not make any edits before this check.

   c. Read the proposal file at `$proposal_abs`. Understand its current approach, scope,
      and structure.

   **Inline mode** (`proposal: inline`):

   The proposal content is the task file body (everything after the closing `---` of the
   frontmatter). The task file is both the metadata record and the proposal document.
   Use the task body as the proposal source. Skip the out-of-tree check — there is no
   separate file.

3. **Explore relevant codebase**:
   - Re-read source files referenced in the proposal
   - Check if anything has changed since the proposal was written
   - Look for new context that affects the approach
   - Focus exploration on areas where the proposal may be wrong or outdated

4. **Edit task file**:

   **File-based mode**: apply additive edits as described — add Notes section, correct
   factual errors, update acceptance criteria. Preserve all existing structure:
   - **Add** a `## Notes` section (or append to existing one) with observations
     discovered during revision — things the coding agent should know
   - **Correct** factual errors (wrong file paths, outdated API references,
     stale line-number references, incorrect assumptions about current state)
   - **Update** acceptance criteria if they were unclear or incomplete
   - **Preserve** existing structure — don't reorganize or rewrite sections
     that are correct
   - **Don't remove** content unless it's demonstrably wrong

   **Inline mode**: skip step 4. All task file editing — both proposal revision and
   notes/criteria updates — is handled in a single combined pass in step 5 to avoid
   conflicting with the destructive rewrite of the same file.

5. **Edit proposal content**:

   **File-based mode**: revise the proposal file at `$proposal_abs` destructively —
   rewrite the approach if off-track, cut premature details, shorten over-specified
   sections, tighten scope. Maintain the Motivation / Current State / Proposed Change /
   Scope structure:
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

   **Inline mode**: perform a single combined edit of the task file. In one pass:
   - Revise the proposal sections (Motivation, Current State, Proposed Change, Scope)
     destructively — the same rules as file-based revision apply here.
   - Make any notes or acceptance-criteria corrections that would normally go in step 4.
   - Preserve the frontmatter block unchanged.
   There is no additive-only constraint here; step 4 is skipped in this mode.

6. **Commit and push**:

   **File-based mode**:
   ```bash
   cd <project_path>
   git add "$proposal_rel"          # repo-relative path computed in step 2
   git commit -m "proposal: revise <title>"
   git push
   ```
   Then commit any task file changes (notes, criteria) written in step 4:
   ```bash
   cd "$LUDICS_STATE_PATH"
   git add tasks/<task_id>.md
   git commit -m "task: add notes for <task_id>"
   git push
   ```

   **Inline mode**: the proposal was revised in-place in the task file; commit only the
   task file:
   ```bash
   cd "$LUDICS_STATE_PATH"
   git add tasks/<task_id>.md
   git commit -m "task: revise inline proposal for <task_id>"
   git push
   ```

7. **Assess changes**:
   If after re-examination the proposal is already solid and no meaningful
   changes were needed, report `status: "no-changes"` instead of making
   trivial edits.

## Final Response

Use the structured response format from worker-conventions.md. Emit a fenced JSON block
as the last code block in your response:

### Response Contract

1. `status` — string, required. Values: `"revised"`, `"no-changes"`, `"error"`.
2. `task_id` — string, required.
3. `proposal_path` — string, conditional. Present only when `proposal_mode = "file"`. Omitted for inline.
4. `proposal_mode` — string, conditional. Required when `status = "revised"` (`"file"` or `"inline"`). Omitted for `"no-changes"`.
5. `changes_summary` — string, required. What changed, or why nothing changed.
6. `title` — string, required.
7. `summary` — string, required.

```json
{
  "status": "revised | no-changes | error",
  "task_id": "<task-id>",
  "proposal_path": "<relative path, e.g. docs/feature.md>",
  "proposal_mode": "file | inline",
  "changes_summary": "<2-3 sentence summary of what was changed and why>",
  "title": "<task title>",
  "summary": "<one-line summary for the notification>"
}
```

## Error Handling

- Task not found: Report `status: "error"` with explanation
- Proposal file not found: Report `status: "error"` — orchestrator should not
  have invoked revision without a proposal
- Project path not found: Report `status: "error"`
- Git push fails: Log warning, continue — edits are still written locally
