# Proposal: Extract shared orchestrator boilerplate into reusable pattern

**Task**: task-298c4d9a
**Project**: ludics
**Author**: Claude (draft-proposal-worker)
**Date**: 2026-03-28

## Summary

Create `skills/orchestrator-conventions.md` -- a shared conventions document
analogous to the existing `skills/worker-conventions.md` -- that captures the
mechanical boilerplate repeated across all five orchestrator skills. Each
orchestrator then references the conventions document for common steps and
retains only its skill-specific routing, notifications, and result fields.

## Motivation

All five orchestrators (elaborate, draft-proposal, revise-proposal,
verify-completion, feedback-digest) repeat the same structural steps:

1. Read task file and extract frontmatter (4 of 5)
2. Resolve project path via config.yaml (4 of 5)
3. Compose a context brief from Mag's history (4 of 5)
4. Delegate to a worker skill in forked context (5 of 5)
5. Read request ID from `mag/current-request-id` (5 of 5)
6. Write result JSON to `$LUDICS_RESULTS_DIR/$REQ_ID.json` (5 of 5)
7. Handle common error conditions (5 of 5)

When the result JSON format, request-ID path, or delegation pattern changes,
all five files need updating. A shared conventions document eliminates this
duplication and gives a single authoritative reference.

## Detailed Design

### New file: `skills/orchestrator-conventions.md`

The document is organized into labeled sections that orchestrators reference by
letter. This structure allows feedback-digest to skip sections A-C while the
four task-based orchestrators reference them all.

#### Section A -- Task Resolution

Covers the standard task-file read pattern for task-based orchestrators:

- Read `$LUDICS_STATE_PATH/tasks/<task_id>.md`
- Extract frontmatter fields: `title`, `project`, `slot`, plus any
  skill-relevant fields (e.g., `proposal:` for revise-proposal)
- If task file not found: write error result JSON (per Section E), stop

This section notes that argument parsing beyond the task ID is skill-specific
(revise-proposal appends feedback, feedback-digest takes `<repo>` instead).

#### Section B -- Project Path Resolution

Covers the project-path lookup shared by all task-based orchestrators:

- Look up `project` in `$LUDICS_STATE_PATH/config.yaml`
- Each config entry has a `repo` field; local checkout is `~/<repo-name>`
- The `personal` project refers to the state repository itself
- draft-proposal additionally resolves `proposals_path` -- that detail stays
  in the draft-proposal skill, not in the conventions doc

#### Section C -- Context Brief Composition

Standardizes the 3-10 line brief pattern:

- Sources: related tasks, user preferences, recent decisions, cross-slot
  awareness, known staleness signals
- If nothing relevant, pass empty
- Skill-specific additions (e.g., revise-proposal includes user feedback
  verbatim) are noted in each skill, not in the conventions doc

#### Section D -- Worker Delegation

Covers the invocation pattern common to all five:

- Invoke `/ludics-<name>-worker <args...>`
- Worker runs in forked context (`context: fork`)
- Only the structured response returns to the orchestrator
- Parse the response per worker-conventions.md structured format
- Future: Section D.1 will cover response parsing when task-a8977ce0
  (structured worker responses) lands -- currently parsing is ad-hoc per skill

#### Section E -- Result JSON Writing

Covers the result file format shared by all five:

- Read request ID from `$LUDICS_STATE_PATH/mag/current-request-id`
- Write to `$LUDICS_RESULTS_DIR/$REQ_ID.json`
- Required fields in every result:
  - `id`: the request ID
  - `status`: outcome status string
  - `timestamp`: ISO-8601
  - `output`: human-readable summary string
- Skill-specific fields (e.g., `proposal_path`, `verdict`, `followup_tasks`,
  `issues_created`) are documented in each skill's own section

#### Section F -- Error Handling Conventions

Standardizes the error patterns:

- Task not found: result with `"status": "error"`, descriptive output
- Worker returns `STATUS: error`: propagate to result JSON
- Notification fails: log warning, continue (do not fail the skill)
- External tool failure (gh, git push): log, continue with remaining work

### Refactoring each orchestrator skill

Each skill `.md` file gains a reference block near the top:

```
## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md) sections:
- **A** (Task Resolution), **B** (Project Path), **C** (Context Brief),
  **D** (Worker Delegation), **E** (Result JSON), **F** (Error Handling)
```

The skill retains:

- Its specific trigger/argument documentation (unchanged)
- Its worker invocation line (skill name + arguments)
- Its STATUS/VERDICT routing logic (the decision tree)
- Its skill-specific notifications
- Its skill-specific result JSON fields
- A brief inline summary of each delegated step (one sentence per section
  referenced) so Mag doesn't need to context-switch to the conventions doc
  for routine execution

**feedback-digest** references only sections B (not applicable), D, E, F --
skipping A and C explicitly.

### Expected size reduction

| Skill | Current lines | Estimated after | Reduction |
|-------|--------------|-----------------|-----------|
| elaborate | ~109 | ~55 | ~50% |
| draft-proposal | ~190 | ~110 | ~42% |
| revise-proposal | ~158 | ~90 | ~43% |
| verify-completion | ~127 | ~75 | ~41% |
| feedback-digest | ~75 | ~50 | ~33% |

The conventions doc itself will be approximately 80-100 lines.

## Coordination with task-a8977ce0

Task-a8977ce0 proposes changing the worker response format from free-form
`STATUS: value` lines to a fenced JSON block. The parsing logic currently
lives implicitly in each orchestrator ("parse the worker's response for
STATUS, ..."). After this refactoring:

- A new Section D.1 in `orchestrator-conventions.md` will describe response
  parsing
- Initially it documents the current `KEY: value` format
- task-a8977ce0 updates Section D.1 only -- a single-file change instead of
  five

## Edge Cases and Risks

1. **LLM prompt interpretation**: If the conventions doc is referenced too
   tersely, Mag might skip steps. Mitigation: each orchestrator keeps a brief
   inline summary of what it delegates, so the skill file remains
   self-contained enough for routine execution.

2. **feedback-digest outlier**: It shares only sections D, E, F. The
   conventions doc must clearly mark sections A-C as "task-based orchestrators
   only" to avoid confusion.

3. **Argument format variation**: elaborate/draft-proposal/verify-completion
   take `<task_id>`, revise-proposal takes `<task_id> [<feedback>]`,
   feedback-digest takes `<repo>`. Section A acknowledges this; parsing
   beyond the first token remains skill-specific.

4. **draft-proposal's `proposals_path` resolution**: This is unique to
   draft-proposal (the probe order for docs/doc/.docs). It stays in the
   draft-proposal skill, not in Section B.

5. **No code-side changes needed**: The existing `writeResult()` in
   `src/queue.ts` and request-ID handling in `src/mag.ts` already work. This
   is purely a prompt-template refactoring.

## Implementation Steps

1. Write `skills/orchestrator-conventions.md` with sections A-F
2. Refactor `skills/ludics-elaborate.md` -- replace boilerplate with
   conventions reference, keep routing logic
3. Refactor `skills/ludics-draft-proposal.md` -- same pattern, retain
   auto-start evaluation and proposal notification logic
4. Refactor `skills/ludics-revise-proposal.md` -- same pattern, retain
   feedback parsing and re-notification
5. Refactor `skills/ludics-verify-completion.md` -- same pattern, retain
   VERDICT routing and slot clearing
6. Refactor `skills/ludics-feedback-digest.md` -- reference D, E, F only
7. Verify all skills still parse correctly by running each through a dry-run
   or manual review

Steps 2-6 can be done in any order; each is independent once the conventions
doc exists.

## Acceptance Criteria Mapping

- [x] Common orchestrator steps extracted into shared pattern
  --> `skills/orchestrator-conventions.md` sections A-F
- [x] Each orchestrator only specifies skill-specific logic
  --> Routing, notifications, and custom fields remain per-skill
- [x] All 5 orchestrator/worker pairs use the shared pattern
  --> Each references the conventions doc (feedback-digest: D, E, F only)
- [x] Fewer lines per orchestrator skill template
  --> 33-50% reduction estimated
