# Scope enforcement for agent changes

## Goal

Prevent agents from modifying files outside the proposal's declared scope during implementation. Across 7+ retrospectives, coder agents make "while I'm here" cleanups, ignore explicit out-of-scope markers, or expand scope without documenting it (evidence: task-c603d177, task-cb53777e, gh-ludics-257, task-d0292512, gh-ludics-256, gh-ocannl-116, task-e2c7cef8). The existing gh-ludics-220 alignment checklist verifies the plan matches the proposal but does not enforce scope boundaries during the work and review phases.

Issue: https://github.com/lukstafi/ludics/issues/305

## Acceptance Criteria

1. The coder work template (`pair-coder-work.md`) instructs the coder to verify every modified file is within the proposal's declared scope before committing, using `git diff --stat`. Out-of-scope changes require documented justification in the commit message. "While I'm here" cleanups to out-of-scope files are explicitly prohibited.

2. The reviewer review template (`pair-reviewer-review.md`) instructs the reviewer to check scope compliance as a blocking review item. Modifications to files not listed in or implied by the proposal's scope section are blocking action items unless the coder documented a justified scope expansion.

3. The coder plan template (`pair-coder-plan.md`) instructs the coder to cross-reference the plan's file list against the proposal's `## Scope` section and flag any out-of-scope files as scope expansions with justification.

4. The plan-review template (`pair-reviewer-plan-review.md`) instructs the reviewer to verify that all files in the merged plan fall within the proposal's declared scope, and request changes if unjustified out-of-scope files are included.

5. All scope-check instructions are conditional on a proposal existing (i.e., they reference the proposal's `## Scope` section and are only actionable when `{{PROPOSAL_PATH}}` is non-empty). Tasks without proposals are unaffected.

## Context

### Current template structure

The orchestration templates in `skills/orchestration/` guide coder and reviewer agents through the plan-work-review cycle. Each template receives `{{PROPOSAL_INSTRUCTION}}` (a "Step 0: read the proposal" directive) and `{{PROPOSAL_PATH}}` (the repo-relative path) via `buildSkillContext()` in `src/orchestration/skills.ts`.

The proposal template (`skills/ludics-draft-proposal-worker.md`) already instructs proposal authors to include a `## Scope` section with in-scope and out-of-scope items. Many existing proposals follow the `**In scope:** / **Out of scope:**` structure. However, no downstream template references or enforces this section.

### Template insertion points

- **`pair-coder-work.md`**: Currently has an AC verification block guarded by `{{#IF PROPOSAL_PATH}}` (after the main implementation instructions). The scope check should go before the AC check, as a pre-commit gate.

- **`pair-reviewer-review.md`**: Currently reviews correctness (config/CLI consistency, data shapes, round-trip tests, pre-existing failures). The scope compliance check should be added as a blocking review criterion alongside these.

- **`pair-coder-plan.md`**: Currently instructs the coder to list files, grep symbols, and plan regression tests. The scope cross-reference should follow the file-listing instruction.

- **`pair-reviewer-plan-review.md`**: Currently has the Code-Proposal Alignment section (from gh-ludics-220) that checks technical assumptions. Scope verification is a natural extension of this section.

### Related variables

`buildSkillContext()` already passes `GIT_DIFF_STAT` (computed via `gitOutput(agent.worktreePath, ["diff", "--stat"])`) which templates can reference. The coder work and reviewer review templates can instruct agents to run `git diff --stat` themselves for the most current state, or reference `{{GIT_DIFF_STAT}}` for the snapshot at template render time.

### Related tasks

- **gh-ludics-220** (completed): Added the Code-Proposal Alignment Checklist to plan-merge and plan-review. This task extends that pattern to the work and review phases, targeting scope rather than technical assumptions.
- **gh-ludics-311**: Proposal assumption drift (complementary, different concern).
- **gh-ludics-316**: Acceptance criteria verification (complementary, shares the "before signaling done" checkpoint pattern).

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

Template-only changes to four files. No code changes to `skills.ts` or any TypeScript source. No new template variables.

### 1. `pair-coder-work.md` -- pre-commit scope check

Add a scope verification block before the existing `{{#IF PROPOSAL_PATH}}` AC verification block (currently at the end of the template). Use the same `{{#IF PROPOSAL_PATH}}` guard so it only applies when a proposal exists:

```
{{#IF PROPOSAL_PATH}}
**Scope discipline**: Before each commit, run `git diff --stat` and verify every modified file falls within the proposal's `## Scope` section (read it from `{{PROPOSAL_PATH}}`). If a necessary change touches an out-of-scope file, include a scope-expansion note in the commit message explaining why. Do NOT make "while I'm here" cleanups, reformatting, or adjacent fixes to files outside the proposal's declared scope.
{{/IF}}
```

Insert this after the "drift tends to creep in" bullet list and before the `Write any PR URL` line.

### 2. `pair-reviewer-review.md` -- blocking scope compliance check

Add a scope compliance section after the existing data-shape/round-trip check paragraph:

```
{{#IF PROPOSAL_PATH}}
**Scope compliance**: Run `git diff --stat` on the coder's changes and cross-reference against the `## Scope` section of the proposal at `{{PROPOSAL_PATH}}`. Modifications to files not listed in or implied by the proposal's scope are blocking action items, unless the coder documented a justified scope expansion in their commit messages. "While I'm here" cleanups to out-of-scope files are always blocking -- request their removal.
{{/IF}}
```

### 3. `pair-coder-plan.md` -- scope cross-reference

Add after the existing symbol-grep instruction (the "For every symbol, pattern, or function you plan to touch" paragraph):

```
{{#IF PROPOSAL_PATH}}
**Scope check**: After listing files to change, cross-reference each against the proposal's `## Scope` section (in `{{PROPOSAL_PATH}}`). If the plan requires modifying files outside the declared scope, note each as a scope expansion with justification. The reviewer will verify this.
{{/IF}}
```

### 4. `pair-reviewer-plan-review.md` -- scope verification in alignment check

Add a bullet to the existing "Code-Proposal Alignment" section:

```
- Does every file in the plan fall within the proposal's declared `## Scope`? Flag any out-of-scope files without justification.
```

This bullet goes inside the existing alignment check list (after the feasibility bullet), so it benefits from the same `{{PROPOSAL_INSTRUCTION}}` context and REQUEST_CHANGES escalation pattern.

## Scope

**In scope:**
- `skills/orchestration/pair-coder-work.md` -- scope check instruction
- `skills/orchestration/pair-reviewer-review.md` -- scope compliance review item
- `skills/orchestration/pair-coder-plan.md` -- scope cross-reference instruction
- `skills/orchestration/pair-reviewer-plan-review.md` -- scope verification bullet

**Out of scope:**
- Changes to `src/orchestration/skills.ts` or any TypeScript code (no new template variables needed)
- Automated `git diff --stat` validation in the runner (Approach C from elaboration -- too heavy, high false-positive risk)
- Extracting `## Scope` as a separate template variable (Approach B -- unnecessary complexity)
- Changes to the proposal template itself (already instructs `## Scope` inclusion)
- Changes to `pair-reviewer-plan.md`, `pair-reviewer-gather.md`, or other templates not in the plan-work-review critical path for scope enforcement
