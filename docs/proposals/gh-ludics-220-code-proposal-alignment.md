# Flag proposal/code mismatches during plan merge, not during implementation

## Goal

Shift code-proposal alignment verification into the plan merge phase so that mismatches between proposal assumptions and actual codebase state are caught before implementation begins. Currently, agents discover these gaps only during implementation rounds, causing wasted iterations and rework. Adding alignment checklists to the plan-merge and plan-review templates makes this verification explicit and early.

Ref: https://github.com/lukstafi/ludics/issues/220

## Acceptance Criteria

1. `pair-coder-plan-merge.md` contains a "Code-Proposal Alignment Checklist" section that instructs the coder to verify proposal assumptions against the actual codebase before merging plans. The checklist covers: API existence, function/module signatures, data structures, file paths, dependencies, and prior-phase additions.
2. The coder plan-merge template instructs the agent to document any assumption gaps with a visible warning marker (e.g. "ASSUMPTION GAP") in the merged plan, and to use REQUEST_CHANGES for substantial gaps.
3. `pair-reviewer-plan-review.md` contains a "Verify Code-Proposal Alignment" section that instructs the reviewer to check whether the merged plan's technical approach matches proposal assumptions, whether proposed code changes are feasible in the current codebase, and whether any previously-found gaps are documented.
4. The reviewer plan-review template instructs the agent to REQUEST_CHANGES with explicit remediation when alignment gaps are found.
5. Both checklists are positioned after the `{{PROPOSAL_INSTRUCTION}}` line and before the main action instructions, consistent with existing template structure.
6. All existing tests pass. Template substitution behavior is unchanged (no new template variables needed).

## Context

**Target files** (`skills/orchestration/`):
- `pair-coder-plan-merge.md`: Currently a short template that merges two independent plans. Has `{{PROPOSAL_INSTRUCTION}}` at line 3 but no code-alignment verification step.
- `pair-reviewer-plan-review.md`: Currently a short template that reviews the merged plan. Has `{{PROPOSAL_INSTRUCTION}}` at line 3 but no code-alignment verification step.

**Related completed work**:
- **gh-ludics-139**: Added "Step 0: read the proposal" to coder templates. This task adds the *reciprocal* check — verifying the proposal against actual code, not just reading it.
- **gh-ludics-137**: Documented worker response contracts for structured orchestrator/coder communication.
- **task-5eb4ecd7**: Added PR verification gates at phase transitions (pr-create, final-merge) — same pattern of catching issues at transition points rather than deferring.

**Template patterns**: All orchestration templates follow a consistent structure: title, `{{PROPOSAL_INSTRUCTION}}`, task-specific instructions, then the status-file printf block. New sections should be inserted between the proposal instruction and the main instructions.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

### A. `pair-coder-plan-merge.md`

Insert a "Code-Proposal Alignment Checklist" section after `{{PROPOSAL_INSTRUCTION}}` and before the "Merge the two independent plans" line. The checklist should:
- List concrete verification items (APIs exist, signatures match, data structures exist, file paths valid, dependencies available, prior-phase additions accounted for)
- Instruct the agent to grep/search/type-check in the worktree to verify each item
- Specify the gap-documentation format: a warning marker like `ASSUMPTION GAP: proposal assumes X but codebase has Y`
- Direct the agent to REQUEST_CHANGES back to the reviewer if gaps are substantial

### B. `pair-reviewer-plan-review.md`

Insert a "Verify Code-Proposal Alignment" section after `{{PROPOSAL_INSTRUCTION}}` and before the "Review the merged plan" line. The section should:
- Instruct the reviewer to check whether the plan's approach matches proposal assumptions
- Check whether proposed code changes are feasible in the current codebase
- Check whether any gaps found in the plan-merge phase are documented
- Direct the reviewer to REQUEST_CHANGES with explicit remediation suggestions for any gaps found

### Scope

**In scope:** 2 template file edits (checklist sections added).

**Out of scope:**
- Changes to the template engine or `buildSkillContext()`
- New template variables
- Changes to initial planning templates (`pair-coder-plan.md`, `pair-reviewer-plan.md`) — those create independent plans before merge, alignment checking belongs at merge time
- Duo mode templates (separate concern)
