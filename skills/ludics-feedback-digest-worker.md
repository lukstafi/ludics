---
name: ludics-feedback-digest-worker
description: Read workflow feedback, cluster themes, file GitHub issues
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep
---

# Feedback Digest Worker — Theme Clustering & Issue Filing

You are a worker subagent invoked by the `/ludics-feedback-digest` orchestrator.
Your job: read accumulated workflow feedback from completed tasks, group by theme,
deduplicate against existing GitHub issues, and file structured issues.

Follow the conventions in [worker-conventions.md](worker-conventions.md).

## Arguments

`$ARGUMENTS` format: `<repo>`

- `<repo>`: GitHub repository (e.g., `owner/repo`)

## Process

### 1. Read feedback files

Read all `.md` files from `$LUDICS_STATE_PATH/feedback/` (skip the `processed/`
subdirectory). Files are named `<task-id>--workflow-feedback-<agent>.md`.
If no files exist, report `status: "empty"` and stop.

### 2. Extract individual data points

For each file, extract individual bullet points / feedback items. Track:
- Source file name (encodes date, feature, and agent)
- Category headers within the file

Use the Task tool with Haiku for extraction if files are large.

### 3. Group by theme

Cluster related items into themes. Examples:
- "tmux command reliability"
- "review phase coordination"
- "worktree cleanup issues"

Each theme: short title + list of data points.

### 3a. Filter — capture-textbook

For each theme/data-point grouped in step 3, decide between two
dispositions before falling through to GH issue filing:

- **`file-issue`** (existing behaviour, continues into step 4):
  actionable workflow defect that should become a tracked GitHub
  issue.
- **`capture-textbook`** (new): competent-SWE-filter-rejected
  recurring lesson that should be remembered but not turned into
  always-loaded prompt doctrine. The lesson is real but too general
  or too obvious to live in always-loaded prompts; journaling it to
  `docs/swe-textbook.md` keeps it findable for Mag without bloating
  the prompts. See
  `harness/claude-memory/feedback_competent_swe_filter.md`.

For the `capture-textbook` path:

1. Derive `ENTRY_HEADLINE` (a short pattern-naming phrase) and
   `PRECIPITATING_RETRO` (the source feature/agent/date or the
   originating task/issue/PR) from the data point.
2. Run the canonical idempotency check at
   `docs/swe-textbook.md#capture-idempotency` and treat its outputs
   per that section's prose contract: on `append`, write a fresh
   `### ENTRY_HEADLINE` block to `docs/swe-textbook.md` with the
   four labelled fields (`Description:`, `Precipitating retro:`,
   `Filter decision:`, optional `Second occurrence:`); on
   `skip-duplicate`, do not append, but you MAY amend the matched
   entry's `Second occurrence:` line.
3. Captured items are NOT counted toward `issues_skipped`. Their
   count surfaces via `textbookCaptures.length` in the Response
   Contract — this is a third disposition, not discarded work.

A single feedback theme may both file a GH issue (for an actionable
workflow defect) and capture a textbook entry (for an orthogonal
recurring lesson). The two dispositions are independent.

### 4. Fetch existing issues and ensure label

Parse `$ARGUMENTS` to extract the repo (the entire argument string, e.g., `owner/repo`).

```bash
gh label create workflow-feedback -R <repo> --description "Auto-filed workflow feedback from agent sessions" --color "c5def5" 2>/dev/null || true
gh issue list -R <repo> --label workflow-feedback --state open --json number,title,body --limit 100
```

### 5. Deduplicate and file

For each theme:
- **New theme**: Create issue with body:
  ```markdown
  ## Summary
  <2-3 sentence summary>

  ## Data Points
  - <rewritten point> (from <feature>/<agent>, <date>)

  ## Raw Excerpts
  <details><summary>Original feedback</summary>

  > <exact quote> — <source file>

  </details>

  ## Suggested Action
  <actionable suggestion>

  ---
  *Filed by ludics-feedback-digest*
  ```

- **Partial overlap**: Add comment to existing issue
- **Exact match**: Skip

### 6. Move processed files

```bash
mkdir -p "$LUDICS_STATE_PATH/feedback/processed/"
mv "$LUDICS_STATE_PATH/feedback/"*.md "$LUDICS_STATE_PATH/feedback/processed/"
```

## Final Response

Use the structured response format from worker-conventions.md. Emit a fenced JSON block
as the last code block in your response:

### Response Contract

1. `status` — string, required. Values: `"completed"`, `"empty"`, `"error"`.
2. `issues_created` — number, required. 0 when none created.
3. `issues_updated` — number, required. 0 when none updated.
4. `issues_skipped` — number, required. 0 when none skipped.
5. `files_processed` — number, required. 0 when none processed.
6. `summary` — string, required.
7. `textbookCaptures` — array, optional, default `[]`. Each item:
   `{"feedbackItem": "...", "entryHeadline": "...",
   "precipitatingRetro": "..."}`. Captured items from step 3a; do
   not double-count them in `issues_skipped`.

Note: when `status = "error"`, count fields may be absent. The `summary` or
`error` field carries the explanation. `textbookCaptures` defaults to
`[]` when absent.

```json
{
  "status": "completed | empty | error",
  "issues_created": <count>,
  "issues_updated": <count>,
  "issues_skipped": <count>,
  "files_processed": <count>,
  "summary": "<one-line summary>",
  "textbookCaptures": []
}
```

## Error Handling

- `gh` not authenticated or repo inaccessible: Report `status: "error"`
- Some issues fail to create: Continue with the rest, report partial results
- Always move processed files even if some issue creation fails
