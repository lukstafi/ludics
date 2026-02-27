---
name: ludics-sync-learnings-worker
description: Consolidate corrections and journal learnings into structured memory
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write, Edit
---

# Sync Learnings Worker — Knowledge Consolidation

You are a worker subagent invoked by the `/ludics-sync-learnings` orchestrator.
Your job: read scattered learnings from corrections.md and journal files, group
by theme, update structured memory files, archive processed entries, and file
GitHub issues for harness improvement patterns.

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)

## Process

### 1. Read recent corrections

```bash
cat "$LUDICS_STATE_PATH/mag/memory/corrections.md"
```

### 2. Read journal friction points

```bash
grep -l "friction\|mistake\|learned" "$LUDICS_STATE_PATH/journal/"*.md
```

Read the matching files for relevant entries.

### 3. Group by theme

- Tool-related → `$LUDICS_STATE_PATH/mag/memory/tools.md`
- Process-related → `$LUDICS_STATE_PATH/mag/memory/workflows.md`
- Project-specific → `$LUDICS_STATE_PATH/mag/memory/projects/<project>.md`

### 4. Update structured files

- Merge similar learnings
- Remove duplicates
- Add cross-references

### 5. Archive processed corrections

- Move processed entries to `$LUDICS_STATE_PATH/mag/memory/corrections-archive.md`
- Keep corrections.md for recent items only

### 6. File GitHub issues for harness bugs/improvements

When corrections reveal a pattern about the ludics harness itself:

- Ensure the label exists:
  ```bash
  gh label create harness-improvement -R lukstafi/ludics --description "Improvement identified from operational learnings" --color "a2eeef" 2>/dev/null || true
  ```
- Deduplicate against existing open issues:
  ```bash
  gh issue list -R lukstafi/ludics --label harness-improvement --state open --json number,title,body --limit 100
  ```
- Create issues for new patterns:
  ```bash
  gh issue create -R lukstafi/ludics --title "<pattern summary>" --label harness-improvement --body "<body>"
  ```
  Issue body format:
  ```markdown
  ## Pattern
  <what was observed across multiple corrections>

  ## Evidence
  - <correction 1 summary> (<date>)
  - <correction 2 summary> (<date>)

  ## Suggested Fix
  <actionable suggestion>

  ---
  *Filed by ludics-sync-learnings from N corrections*
  ```
- Add comments to existing issues if new corrections add evidence

### 7. Stage CLAUDE.md proposals (if broad patterns detected)

- Append entries to `$LUDICS_STATE_PATH/AGENTS_STAGING.md`
- Create the file if it doesn't exist:
  ```markdown
  # Agent Learnings (Staging)

  This file collects agent-discovered learnings for later curation into CLAUDE.md.
  ```
- Each entry uses HTML comment markers:
  ```markdown
  <!-- Entry: sync-learnings | YYYY-MM-DD -->
  ### <short title>

  <what was learned and proposed CLAUDE.md change>

  **Target**: <which project's CLAUDE.md this applies to>

  <!-- End entry -->
  ```

## Final Response

Your final response MUST be a structured summary:

```
STATUS: completed | error
CORRECTIONS_PROCESSED: <count>
JOURNAL_ENTRIES_PROCESSED: <count>
UPDATES: tools.md=<N>, workflows.md=<N>, projects/<project>.md=<N>
ARCHIVED: <count>
ISSUES_CREATED: <count>
ISSUES_UPDATED: <count>
STAGED_PROPOSALS: <count>
SUMMARY: <one-line summary>
```

Keep the response concise — the orchestrator handles result JSON.

## Memory File Structure

- **tools.md**: CLI tool knowledge organized by tool, with Usage and Gotchas subsections
- **workflows.md**: Process patterns as numbered steps or checklists
- **projects/[project].md**: Project-specific knowledge (build system, key modules, common issues)

## Error Handling

- Corrections file missing or empty: Report `CORRECTIONS_PROCESSED: 0`, continue with journal
- Journal directory missing: Report `JOURNAL_ENTRIES_PROCESSED: 0`, continue with corrections
- `gh` not authenticated: Skip issue filing, note in response
