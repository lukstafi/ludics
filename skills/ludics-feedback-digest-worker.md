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
Your job: read accumulated agent-duo workflow feedback, group by theme, deduplicate
against existing GitHub issues, and file structured issues.

## Arguments

`$ARGUMENTS` format: `<repo>`

- `<repo>`: GitHub repository (e.g., `owner/repo`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)

## Process

### 1. Read feedback files

Read all `.md` files from `~/.agent-duo/workflow-feedback/` (skip the `processed/`
subdirectory). If no files exist, report `STATUS: empty` and stop.

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
mkdir -p ~/.agent-duo/workflow-feedback/processed/
mv ~/.agent-duo/workflow-feedback/*.md ~/.agent-duo/workflow-feedback/processed/
```

## Final Response

Your final response MUST be a structured summary:

```
STATUS: completed | empty | error
ISSUES_CREATED: <count>
ISSUES_UPDATED: <count>
ISSUES_SKIPPED: <count>
FILES_PROCESSED: <count>
SUMMARY: <one-line summary>
```

Keep the response concise — the orchestrator handles result JSON.

## Error Handling

- `gh` not authenticated or repo inaccessible: Report `STATUS: error`
- Some issues fail to create: Continue with the rest, report partial results
- Always move processed files even if some issue creation fails
