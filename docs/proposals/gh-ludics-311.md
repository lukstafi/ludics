# Proposal: Proposal freshness check via commit count

## Goal

Detect stale proposals at session start by counting commits to main since the proposal was last updated, and warn agents when the codebase has diverged significantly. This addresses the temporal dimension of proposal-codebase drift that convention-based fixes (gh-ludics-220 alignment checklist, gh-ludics-243 stable references) cannot cover.

## Acceptance Criteria

- [ ] `buildSkillContext()` computes a `PROPOSAL_FRESHNESS_WARNING` template variable when a file-based proposal path is present.
- [ ] The freshness computation uses `git rev-list --count <proposal-commit>..HEAD` (run from `projectDir`) to count commits since the proposal file was last modified, where `<proposal-commit>` is obtained via `git log -1 --format=%H -- <proposal-path>`.
- [ ] When the commit count exceeds a threshold (10 commits), `PROPOSAL_FRESHNESS_WARNING` contains a warning message stating the count and advising agents to verify assumptions carefully. When the count is at or below the threshold (or the git command fails), the variable is empty string.
- [ ] The `PROPOSAL_INSTRUCTION` variable includes the freshness warning (when non-empty) appended after the existing "Read the proposal" instruction.
- [ ] The freshness warning is visible in all phases that receive `PROPOSAL_INSTRUCTION` (plan, plan-merge, plan-review, work, etc.) — no template changes needed since the warning is embedded in the existing variable.
- [ ] Inline proposals (`proposal: inline`) and missing proposals produce no freshness warning (variable is empty).
- [ ] A unit test in `skills.test.ts` verifies that: (a) `PROPOSAL_FRESHNESS_WARNING` is empty when no proposal path is set, (b) when a proposal path is set, `buildSkillContext` populates the variable (mocking or using a real git repo with commits after the proposal file).

## Context

### Primary code path: `buildSkillContext()` in `src/orchestration/skills.ts`

The function constructs template variables for orchestration skill messages. The proposal-related variables are built in a block starting around the extraction of `_proposalPath` from task frontmatter via `readFrontmatterField(_taskContent, "proposal")`. Two variables are currently produced:

- `PROPOSAL_PATH` — the repo-relative proposal file path (empty for inline/missing)
- `PROPOSAL_INSTRUCTION` — a "Step 0: Read the proposal..." string (empty when no proposal)

The freshness check adds a third variable (`PROPOSAL_FRESHNESS_WARNING`) and appends it to `PROPOSAL_INSTRUCTION`.

### Git command execution: `gitOutput()` helper in `src/orchestration/skills.ts`

A local helper wraps `safeSyncOutput()` (from `src/spawn.ts`) for git commands. It takes a `cwd` and args array, returns trimmed stdout or null on failure. This is the right mechanism for the two git calls needed:

1. `git log -1 --format=%H -- <proposalPath>` — get the commit hash of the last change to the proposal file
2. `git rev-list --count <hash>..HEAD` — count commits between that point and HEAD

Both must run with `cwd: state.projectDir` (not the worktree, since the proposal lives in the main repo).

### Template variable substitution

`substituteTemplate()` in the same file handles `{{VAR}}` and `{{#IF VAR}}...{{/IF}}` blocks. The freshness warning will be embedded directly into `PROPOSAL_INSTRUCTION`, so no template file changes are needed — every template that uses `{{PROPOSAL_INSTRUCTION}}` automatically gets the warning.

### Existing mitigations (for scope awareness)

- `pair-coder-plan-merge.md` — has Code-Proposal Alignment Checklist (from gh-ludics-220) that instructs agents to grep/search/type-check proposal assumptions. The freshness warning reinforces this checklist with urgency context.
- `pair-reviewer-plan-review.md` — has Code-Proposal Alignment section.
- `ludics-draft-proposal-worker.md` (step 7) and `ludics-revise-proposal-worker.md` — use function/type/symbol names instead of line numbers (gh-ludics-243).

### Test patterns: `src/orchestration/skills.test.ts`

Tests use `makeState()` to create an `OrchestrationState` fixture and call `buildSkillContext()` directly. Several tests set up temporary harness directories with `mkdtempSync`, write task files with frontmatter, and verify context variable values. The freshness test will need a temporary git repo with at least one commit after the proposal file commit.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Implementation

Add a helper function `proposalFreshnessWarning(projectDir: string, proposalPath: string): string` in `src/orchestration/skills.ts` that:

1. Runs `git log -1 --format=%H -- <proposalPath>` with `cwd: projectDir` via `gitOutput()`.
2. If null (file not tracked or git error), returns `""`.
3. Runs `git rev-list --count <hash>..HEAD` with `cwd: projectDir`.
4. Parses the count. If `> 10`, returns a warning string like: `"\n\n> **Freshness warning**: This proposal was last updated ${count} commits ago. The codebase may have changed — pay extra attention to the Code-Proposal Alignment Checklist and verify assumptions against the current code."`.
5. Otherwise returns `""`.

In `buildSkillContext()`, after computing `proposalPath`, call `proposalFreshnessWarning(state.projectDir, proposalPath)`. Store the result as `PROPOSAL_FRESHNESS_WARNING` in the context record. Append it to `proposalInstruction` when non-empty.

### Testing

Add a test that:
- Creates a temporary directory, initializes a git repo (`git init`), commits a proposal file, then makes additional empty commits (e.g., 15) to exceed the threshold.
- Creates a matching task file in a temporary harness.
- Calls `buildSkillContext()` and asserts `PROPOSAL_FRESHNESS_WARNING` contains the warning text and the commit count.
- Asserts `PROPOSAL_INSTRUCTION` includes both the "Read the proposal" text and the freshness warning.

Add a negative test where the proposal has 0 extra commits, verifying the warning is empty.

## Scope

**In scope:**
- Programmatic freshness check via commit count in `buildSkillContext()`
- New `PROPOSAL_FRESHNESS_WARNING` template variable
- Appending warning to existing `PROPOSAL_INSTRUCTION`
- Unit tests

**Out of scope (lower priority, separate tasks if desired):**
- `[UNVERIFIED]` markers in proposal authoring templates (Gap 2 from elaboration)
- Verified vs unverified plan sections (Gap 3 from elaboration)
- Configurable threshold (hardcoded at 10 is fine for now)

**Dependencies:** None — this is additive and does not modify existing behavior when proposals are fresh.
