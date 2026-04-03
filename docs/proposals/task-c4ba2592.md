# Proposal: Use retrospective review artifacts in process-suggestions

## Goal

Extend the `process-suggestions` skill to extract actionable follow-up items from
`REQUEST_CHANGES` reviews in retrospective JSON. These reviews represent issues the
reviewer explicitly flagged but the coder did not address before completion -- they
are the highest-signal source for follow-up task creation.

## Acceptance Criteria

1. The skill extracts the `reviews` array from retrospective JSON alongside existing
   `suggestRefactorSummary` and `workflowFeedback` fields.

2. Only `request_changes` reviews are processed. Reviews with `approve` or `timeout`
   verdicts are ignored.

3. When multiple `request_changes` reviews exist for the same `type` (e.g., two
   plan-review rounds), only the latest round's review is used (earlier rounds are
   superseded).

4. Actionable items from review content are split into individual suggestions,
   normalized, and deduped against suggestions from the other two sources.

5. The empty-check (step 4) considers all three sources: if `suggestRefactorSummary`
   is null, `workflowFeedback` is empty, AND there are no `request_changes` reviews,
   then stop.

6. Follow-up tasks originating from reviews include a richer Context section:
   "Auto-generated from review round N by <reviewer> (REQUEST_CHANGES) of
   `<source-task-id>`. Issue identified: <brief summary>"

7. The Judgment Criteria section notes that `REQUEST_CHANGES` items lean toward
   "substantive" classification unless purely stylistic.

## Context

- **Skill definition**: `skills/ludics-process-suggestions.md` -- the only file to edit
- **RetrospectiveReview type**: `src/retrospective.ts` lines 23-29 -- `{ round, type, reviewer, verdict, content }`
- **Review content format**: starts with verdict keyword (e.g., `REQUEST_CHANGES`), followed by numbered action items or prose
- **Existing sources**: step 3 extracts `suggestRefactorSummary` (string|null) and `workflowFeedback` (object); step 6 normalizes them
- **Real data**: `gh-ludics-121.json` and `gh-ludics-122.json` each have 1 request_changes review; `task-cb53777e.json` has 1. Most retrospectives have 0 reviews (feature was added recently in task-5b212c83).

## Approach

Edit `skills/ludics-process-suggestions.md` only:

1. **Step 3 (Parse JSON)**: Add extraction of `reviews` array. Filter to
   `verdict === "request_changes"`. For each `type` ("review", "plan-review"),
   keep only the highest-round entry.

2. **Step 4 (Empty check)**: Change condition to: if all three sources
   (`suggestRefactorSummary`, `workflowFeedback`, filtered reviews) are
   empty/null, write empty result and stop.

3. **Step 6 (Normalize and dedupe)**: Add a paragraph for review-derived
   suggestions. Strip the leading verdict keyword line from content. Split
   remaining text by numbered items or bullet points into individual suggestions.
   Dedupe against items from the other two sources.

4. **Step 9c (Task context)**: Add a conditional: when a suggestion originates
   from a review artifact, use the richer context format referencing round,
   reviewer, and verdict.

5. **Judgment Criteria section**: Add a note that `REQUEST_CHANGES` reviews are
   high-signal (reviewer explicitly flagged, coder didn't fix) and should lean
   toward "substantive" unless purely stylistic.
