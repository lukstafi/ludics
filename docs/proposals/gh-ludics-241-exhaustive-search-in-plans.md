# Enforce exhaustive search before implementation in coder plans

## Goal

Coder plans repeatedly miss inline code occurrences (regex reimplementations, template references, config files) of symbols they intend to modify. These omissions are only caught during review, adding unnecessary plan-merge rounds. This change adds explicit instructions to the orchestration templates requiring project-wide search before planning and implementation.

Related: https://github.com/lukstafi/ludics/issues/241

## Acceptance Criteria

1. The coder plan template (`pair-coder-plan.md`) instructs coders to run a project-wide grep/ripgrep search for every symbol or pattern they plan to modify, and to list all occurrences with dispositions (modify, skip with reason, or N/A) in the plan. The instruction must explicitly mention inline reimplementations (regex patterns, copy-pasted logic) as things to search for, not just canonical function names.

2. The reviewer plan-review template (`pair-reviewer-plan-review.md`) instructs reviewers to verify that the coder's occurrence list is complete, and to REQUEST_CHANGES with specific grep commands and results if occurrences are missing.

3. The coder work template (`pair-coder-work.md`) instructs coders to re-run a project-wide search for each symbol before modifying it, and to handle any newly discovered occurrences immediately rather than deferring to a future round.

## Context

The four relevant orchestration templates live in `skills/orchestration/`:

- **`pair-coder-plan.md`** (~17 lines): Instructs coder to write an implementation plan. Already has a paragraph about data-shape consumers ("When the task changes data shapes...grep for field names..."). The new instruction generalizes this to all symbols being modified, not just data shapes.

- **`pair-coder-work.md`** (~34 lines): Instructs coder to implement. No current guidance on verifying all occurrences before modifying a symbol.

- **`pair-reviewer-plan-review.md`** (~27 lines): Reviews merged plan. Has a data-shape consumer check already ("If the plan involves data shape changes...grep for field names..."). The new instruction generalizes this to all modified symbols.

- **`pair-coder-plan-merge.md`** (~38 lines): Merges two plans. Has a code-proposal alignment checklist. Does not need changes -- occurrence coverage is the planner's responsibility, verified by the reviewer.

## Scope

**In scope:**
- Adding 2-4 lines of instruction text to 3 template files (plan, work, plan-review)
- No code changes, no new template variables, no new files

**Out of scope:**
- Changes to `pair-coder-plan-merge.md` (occurrence coverage is the planner's job)
- Automated tooling to enforce search (future improvement)
- Changes to other orchestration templates (clarify, gather, pr-create, etc.)

**Dependencies:** None.
