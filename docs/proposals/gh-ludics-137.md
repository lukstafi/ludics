# Document worker response contracts: required vs mode-conditional fields

## Goal

Orchestrator skills consume fields from worker JSON responses, but which fields
are always present vs conditional on status/mode is undocumented. This has caused
breakage (e.g., task-83ad8e1d where `proposal_path` was assumed present in inline
mode). Each worker-orchestrator pair needs explicit per-field annotations, and
legacy line-based fallback parsing should be removed since the JSON migration
(task-a8977ce0) is complete.

Issue: https://github.com/lukstafi/ludics/issues/137

## Acceptance Criteria

1. Each of the 5 worker skill files has per-field annotations in its Final
   Response section, marking each field as either **always required** or
   **conditional** (with the condition stated, e.g., "only when status=revised").

2. Each of the 5 orchestrator skill files has its Status Routing section updated
   to document which worker fields are optional and to handle absent fields
   gracefully (no assumption that all fields are always present).

3. All legacy line-based fallback parsing paragraphs (the "If no JSON block is
   found, fall back to line-based parsing..." blocks) are removed from all 5
   orchestrator skill files.

4. The annotations are distributed -- kept in each worker/orchestrator skill file,
   not centralized in `worker-conventions.md`.

5. No behavioral changes to worker or orchestrator logic beyond the documentation
   updates and fallback removal.

## Context

There are 5 worker-orchestrator pairs. All use the JSON structured response
format established by task-a8977ce0. Each pair has a worker skill file (defining
the response schema in its "Final Response" section) and an orchestrator skill
file (parsing the response in its "Status Routing" section).

### Files to modify

**Worker skill files** (Final Response sections):
- `skills/ludics-elaborate-worker.md` -- lines ~160-178
- `skills/ludics-draft-proposal-worker.md` -- lines ~108-139
- `skills/ludics-revise-proposal-worker.md` -- lines ~155-175
- `skills/ludics-verify-completion-worker.md` -- lines ~71-91
- `skills/ludics-feedback-digest-worker.md` -- lines ~93-107

**Orchestrator skill files** (Status Routing sections):
- `skills/ludics-elaborate.md` -- lines ~41-53
- `skills/ludics-draft-proposal.md` -- lines ~64-84
- `skills/ludics-revise-proposal.md` -- lines ~52-68
- `skills/ludics-verify-completion.md` -- lines ~42-97
- `skills/ludics-feedback-digest.md` -- lines ~42-52

### Current field contracts (from task elaboration)

1. **elaborate**: `status` (always), `task_id` (always), `title` (always),
   `questions` (always), `summary` (always), `merge_target` (only when
   status=merged), `elaborated_date` (only when status=already-elaborated)

2. **draft-proposal**: `status` (always), `task_id` (always), `title` (always),
   `summary` (always), `start_confidence` (always), `start_rationale` (always),
   `ambiguities` (always), `proposal_path` (omitted when status is
   stale/split-needed/error)

3. **revise-proposal**: `status` (always), `task_id` (always), `title` (always),
   `summary` (always), `proposal_mode` (only when status=revised),
   `proposal_path` (only when proposal_mode=file), `changes_summary` (only when
   status=revised)

4. **verify-completion**: `status` (always), `task_id` (always), `title`
   (always), `slot` (always), `verdict` (always), `evidence` (always),
   `followups` (always -- use `"none"` when empty), `questions` (always -- use
   `"none"` when empty)

5. **feedback-digest**: `status` (always), `issues_created` (always),
   `issues_updated` (always), `issues_skipped` (always), `files_processed`
   (always), `summary` (always) -- no conditional fields

### Legacy fallback parsing to remove

Each orchestrator has a paragraph like: "If no JSON block is found, fall back to
line-based parsing: look for `STATUS: <value>`, ..." -- these should be deleted
entirely, along with any legacy-specific handling (e.g., "On the legacy path,
treat `QUESTIONS:` content as a pre-formatted string").

## Scope

**In scope:**
- Per-field annotations in all 5 worker Final Response sections
- Absent-field handling documentation in all 5 orchestrator Status Routing sections
- Removal of all legacy line-based fallback parsing from orchestrators

**Out of scope:**
- Changes to `worker-conventions.md` (contracts stay distributed per user decision)
- TypeScript code changes (contracts are LLM-to-LLM documentation)
- Adding new fields or changing existing field semantics
- Changing worker or orchestrator behavioral logic
