# Proposal: Structured worker response format — JSON block instead of free-form text

**Task**: task-a8977ce0
**Project**: ludics
**Author**: Claude (draft-proposal-worker)
**Date**: 2026-03-28

## Motivation

Workers return structured data (status, task ID, paths, lists) as free-form
`KEY: value` text lines. Orchestrators — which are LLM agents reading skill
prompt templates — "parse" these by pattern matching in natural language.
There is no code-side parsing; Mag reads the worker's text output and follows
routing instructions from the orchestrator prompt.

This works most of the time, but the format is fragile in LLM output:

- **Typos in field names** (`STAUS:` instead of `STATUS:`)
- **Markdown contamination** (`**STATUS**: completed` instead of `STATUS: completed`)
- **Multiple STATUS lines** when the worker is verbose
- **Multi-line values truncated** — numbered lists or long text after `FIELD:` gets
  cut to the first line
- **Prose confusion** — the orchestrator LLM misidentifies a STATUS value mentioned
  in explanatory text before the structured block

A fenced JSON block is a well-understood format boundary that LLMs produce and
extract reliably. The ` ```json ... ``` ` fence acts as a clear delimiter, and
JSON's key-value structure eliminates the ambiguity of flat text lines.

## Current State

### Worker conventions (`skills/worker-conventions.md`, lines 28-44)

The "Structured Response Format" section defines the canonical format:

```
STATUS: <status_value>
FIELD_NAME: <value>
```

Rules: STATUS first, each field on its own line, multi-item values comma-separated
or numbered lists.

### Per-worker response sections

Each worker skill has a "Final Response" section with a code block showing its
specific fields. Five workers, five different field sets:

| Worker | Fields | Notable types |
|--------|--------|---------------|
| elaborate | 6 | `QUESTIONS` is a numbered list or "none" |
| draft-proposal | 7 | `AMBIGUITIES` is a numbered list or "none"; `START_CONFIDENCE` is an enum |
| revise-proposal | 6 | `PROPOSAL_MODE` is `file` or `inline`; `PROPOSAL_PATH` is conditional |
| verify-completion | 7 | `FOLLOWUPS` is a numbered list of items with priority; `VERDICT` is the routing field (not STATUS) |
| feedback-digest | 5 | `ISSUES_CREATED` etc. are counts (numbers) |

### Orchestrator parsing instructions

Each orchestrator's "Interpret worker result" step says something like:

- elaborate: "Parse the worker's response for STATUS, QUESTIONS, and SUMMARY"
- draft-proposal: "Parse the worker's response for STATUS, PROPOSAL_PATH, AMBIGUITIES, START_CONFIDENCE, START_RATIONALE, TITLE, and SUMMARY fields"
- verify-completion: "Parse the worker's VERDICT and act accordingly"
- feedback-digest: "Parse the worker's response for STATUS and counts"

These are all natural-language instructions to Mag. No TypeScript code parses
worker responses.

### Coordination with task-298c4d9a

Task-298c4d9a (orchestrator conventions) is running in slot 1. Its proposal
reserves Section D.1 in the planned `orchestrator-conventions.md` for response
parsing. If that task lands first, the JSON parsing convention goes into
Section D.1 as a single-file change. If this task lands first, parsing
instructions are updated in each orchestrator individually, and task-298c4d9a
later extracts them into the shared doc. Either order works.

## Proposed Change

### 1. Replace the convention in `worker-conventions.md`

Replace the "Structured Response Format" section (lines 28-44) with a JSON
block convention:

- Workers MUST emit a fenced ` ```json ... ``` ` block as the **last** code block
  in their response
- The block contains a single JSON object with all structured fields
- `status` is always required and always the first key
- Field names use `snake_case` (not `UPPER_CASE`)
- Multi-value fields use JSON arrays (not comma-separated text or numbered lists)
- Single-value fields use strings; counts use numbers
- The string `"none"` is used where the current format says "none" (for backward
  compatibility with orchestrator routing that checks for "none")
- Free-form explanation text may precede the JSON block

### 2. Update each worker skill's "Final Response" section

Convert the key-value example blocks to JSON examples. For instance,
draft-proposal-worker changes from:

```
STATUS: completed | stale | split-needed | already-exists | error
TASK_ID: <task-id>
PROPOSAL_PATH: <relative path>
AMBIGUITIES: <numbered list of ambiguities, or "none">
START_CONFIDENCE: high | low
START_RATIONALE: <one sentence>
TITLE: <task title>
SUMMARY: <one-line summary>
```

to:

```json
{
  "status": "completed",
  "task_id": "<task-id>",
  "proposal_path": "<relative path>",
  "ambiguities": ["<ambiguity 1>", "<ambiguity 2>"],
  "start_confidence": "high",
  "start_rationale": "<one sentence>",
  "title": "<task title>",
  "summary": "<one-line summary>"
}
```

The same transformation applies to all five workers. Notable type refinements:

- **verify-completion**: `followups` becomes an array of objects
  `[{"title": "...", "priority": "B"}, ...]` or `"none"`
- **feedback-digest**: count fields (`issues_created`, etc.) become numbers
- **verify-completion**: `slot` becomes a number
- **elaborate**: `questions` becomes an array of strings or `"none"`

### 3. Update orchestrator parsing instructions

In each orchestrator's "Interpret worker result" step, change the instruction to:

> Extract the JSON block from the worker's response (the last fenced
> ` ```json ``` ` block). Parse the JSON object and route based on the
> `status` field.
>
> **Fallback**: If no JSON block is found, fall back to line-based parsing:
> look for `STATUS: <value>` and `FIELD_NAME: <value>` lines.

Field references in routing logic update from `UPPER_CASE` to `snake_case`
(e.g., `PROPOSAL_PATH` becomes `proposal_path`, `VERDICT` becomes `verdict`).

### 4. "Last block" convention handles edge cases

The "last fenced ```json block" rule avoids matching JSON blocks that appear in
the worker's explanatory text (e.g., code snippets, examples). Workers sometimes
include JSON examples in their analysis; only the final one is the response.

## Scope

### In scope

- `skills/worker-conventions.md` — replace Structured Response Format section
- 5 worker skill templates — update Final Response sections
- 5 orchestrator skill templates — update parsing instructions
- Total: 11 files, all prompt template `.md` files, no TypeScript

### Out of scope

- No TypeScript code changes (no code-side parsing exists or is needed)
- No schema validation tooling (responses are parsed by LLM, not by code)
- No changes to agent-duo orchestration templates (`skills/orchestration/*.md`)
- No changes to the `ludics` CLI or `src/` directory
- Field semantics are unchanged — only the serialization format changes

### Backward compatibility

The fallback instruction in orchestrators ensures the transition is seamless:
- Workers updated first: orchestrators find the JSON block and parse it
- Orchestrators updated first: they look for JSON, fall back to line parsing
- Mixed state (cached skill templates): fallback handles it
- The fallback can be removed in a future cleanup once all templates are updated

### Files changed

| File | Change |
|------|--------|
| `skills/worker-conventions.md` | Replace lines 28-44 |
| `skills/ludics-elaborate-worker.md` | Update Final Response section |
| `skills/ludics-draft-proposal-worker.md` | Update Final Response section |
| `skills/ludics-revise-proposal-worker.md` | Update Final Response section |
| `skills/ludics-verify-completion-worker.md` | Update Final Response section |
| `skills/ludics-feedback-digest-worker.md` | Update Final Response section |
| `skills/ludics-elaborate.md` | Update step 5 parsing instruction |
| `skills/ludics-draft-proposal.md` | Update step 5 parsing instruction |
| `skills/ludics-revise-proposal.md` | Update step 5 parsing instruction |
| `skills/ludics-verify-completion.md` | Update step 5 parsing instruction |
| `skills/ludics-feedback-digest.md` | Update step 2 parsing instruction |
