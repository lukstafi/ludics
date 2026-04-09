# Proposal: Guard against stale format assumptions in orchestration templates

**Task**: gh-ludics-228 — Refactored code inherits stale assumptions about input format
**Date**: 2026-04-09

## Goal

Add explicit guidance to orchestration prompt templates so that coders and reviewers systematically audit downstream consumers when data shapes change, and require round-trip fidelity tests for format-compatibility serializers.

## Acceptance Criteria

1. **Reviewer plan-review template** (`pair-reviewer-plan-review.md`) includes a check: when the plan touches data shapes (field extraction, JSON migration, section restructuring), verify the plan audits all downstream consumers of the changed data.
2. **Reviewer review template** (`pair-reviewer-review.md`) includes a check: when the implementation changes data shapes, verify that all helpers consuming the changed data have been updated, and that format-compat serializers include round-trip fidelity assertions.
3. **Coder plan template** (`pair-coder-plan.md`) includes guidance: when planning changes to data shapes, list all downstream consumers in the plan and note which need updating.
4. **Coder work template** (`pair-coder-work.md`) includes guidance: when implementing format-compat serializers or changing data shapes, write a round-trip test (serialize → deserialize → compare) for each affected serializer.
5. All additions are concise (2-4 sentences each) and positioned near existing related guidance so they read naturally.

## Context

During task-e19c470b (JSON migration for slot data), two helpers silently broke:
- `extractGitPathsFromString` expected a `**Git:**` header that no longer existed after fields were extracted into JSON properties.
- `slotDataToMarkdown` omitted the `Liveness` field, breaking backward-compat endpoints.

Both were caught in review (round 1 → round 2), not by tests. The code fixes are done. A round-trip fidelity test is tracked separately (task-ed1c14ea). This task adds process guardrails to the orchestration templates so similar oversights are caught earlier — ideally at the planning stage.

## Approach

Add short paragraphs to four template files:

1. **`pair-coder-plan.md`** — After the "Be concrete: files to change..." line, add a paragraph: when the task changes data shapes (field extraction, JSON migration, section restructuring), explicitly list every downstream consumer of the affected data in the plan and note which ones need updating.

2. **`pair-coder-work.md`** — After the "Build, lint, and run targeted tests" line, add a paragraph: when changing data shapes or writing format-compat serializers, write a round-trip fidelity test (serialize → deserialize → compare key fields) for each affected serializer.

3. **`pair-reviewer-plan-review.md`** — After the "Review the merged plan" line, add a paragraph: if the plan involves data shape changes, check that all downstream consumers are identified and their required updates are noted. Request changes if consumers are missing.

4. **`pair-reviewer-review.md`** — After the "First line must be APPROVE or REQUEST_CHANGES" line, add a paragraph: if the implementation changes data shapes, verify all consuming helpers have been updated and that format-compat serializers have round-trip fidelity tests. Flag missing consumer updates as blocking.
