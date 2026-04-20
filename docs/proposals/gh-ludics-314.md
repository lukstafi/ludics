# Proposal: Consolidated worker field contracts table and CI lint

**Task**: gh-ludics-314
**Project**: ludics

## Goal

Create a single consolidated field-contract reference table in `worker-conventions.md` that documents every worker response field across all 5 worker/orchestrator pairs with explicit required/conditional annotations, fix the missing `skip_plan` field in the draft-proposal orchestrator, and implement the CI lint script (from unbuilt task-b0df15b2) that detects field drift between worker Response Contract sections and orchestrator status-routing tables.

## Acceptance Criteria

### Part 1: Consolidated field-contract table

1. `skills/worker-conventions.md` gains a new section "## Field Contract Reference" (after the existing "## Field Annotations" section) containing a single markdown table with columns: **Skill pair**, **Field**, **Type**, **Annotation** (required / conditional / optional), **Condition / Notes**.
2. The table covers all fields from all 5 worker/orchestrator pairs: elaborate, draft-proposal, revise-proposal, verify-completion, feedback-digest.
3. Each field's annotation uses the existing `required` / `conditional` vocabulary already defined in the "Field Annotations" section of `worker-conventions.md`.
4. `skills/orchestrator-conventions.md` Section D gains a sentence directing readers to the consolidated table in `worker-conventions.md` for the canonical field-contract reference, in addition to the per-skill tables.

### Part 2: Fix `skip_plan` drift

5. The draft-proposal orchestrator (`skills/ludics-draft-proposal.md`) status-routing table gains a `skip_plan` row with: Used for = "task frontmatter", Missing-field fallback = "default `false`, remove stale frontmatter value".
6. The draft-proposal orchestrator already handles `skip_plan` in its routing logic (lines 81-84); this change makes the documentation match the code.

### Part 3: CI lint for contract field drift

7. A new script `scripts/lint-contracts.ts` discovers worker/orchestrator pairs by globbing `skills/ludics-*-worker.md` and deriving the orchestrator path (strip `-worker` suffix).
8. For each pair, the script extracts backtick-quoted field names from:
   - **Worker side**: numbered list items under `### Response Contract` heading, using regex `/^\d+\.\s+`(\w+)`/`.
   - **Orchestrator side**: table rows under `## Status routing` (or `## Verdict routing` for verify-completion), using regex `/\|\s*`(\w+)`\s*\|/`.
9. Fields present in one side but not the other are reported as **errors** (exit 1). The `task_id` field is special-cased: workers always declare it, but orchestrators may list it as "not consumed" -- mismatches on `task_id` are warnings, not errors.
10. Unpaired files (worker without orchestrator or vice versa) produce **warnings** (non-fatal).
11. Missing sections in a paired file produce **warnings** (non-fatal), to accommodate incremental skill additions.
12. A `"lint:contracts"` script entry is added to `package.json`: `"bun run scripts/lint-contracts.ts"`.
13. The script passes cleanly on the current skill files after the `skip_plan` fix (acceptance criterion 5) is applied. No false positives.
14. No `.github/workflows/ci.yml` exists in the repo today; the CI workflow file creation is out of scope for this task. The lint is runnable locally via `bun run lint:contracts` and can be added to CI when the workflow is created.

## Context

- **gh-ludics-137** (closed 2026-04-04) added per-field Response Contract sections to all 5 worker skills and Expected Worker Fields tables to all 5 orchestrator skills. `worker-conventions.md` was updated with the "Field Annotations" section defining `required` and `conditional` vocabulary. However, several gaps remained: orchestrator tables don't mirror the required/conditional vocabulary, the `skip_plan` field was omitted from the draft-proposal orchestrator, and the CI lint was never implemented.
- **task-b0df15b2** ("Add CI lint for worker/orchestrator response contract field drift") has `status: done` in harness but the implementation artifacts are absent: no `scripts/lint-contracts.ts`, no `lint:contracts` in `package.json`, no CI step. The proposal at `docs/proposals/task-b0df15b2.md` provides a solid specification that this task subsumes and refines.
- **Format details**: Worker Response Contracts use numbered lists (`1. \`field\` -- ...`). Orchestrator tables use markdown pipe tables (`| \`field\` | ... | ... |`). The lint must parse both formats. The heading on the orchestrator side varies: most use "## Status routing", verify-completion uses "## Verdict routing".
- **Existing lint patterns**: `scripts/lint-cli-readme.ts` and `scripts/lint-config-reference.ts` provide the structural template: read source files, extract sets, compare, report mismatches, exit 0 or 1. The new script follows the same conventions (Bun shebang, fs/path imports, clear error/warning formatting).
- **User decision**: The user chose a consolidated table in `worker-conventions.md` rather than duplicating required/conditional labels into each orchestrator skill. This keeps the orchestrator per-skill tables focused on "Used for" and "Missing-field fallback" while the consolidated table serves as the canonical type/annotation reference.
