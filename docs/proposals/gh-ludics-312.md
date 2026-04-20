# Proposal: Caller audit for function signature changes

**Task**: gh-ludics-312
**Date**: 2026-04-20

## Goal

Update orchestration templates so that agents explicitly audit all callers when changing a function's return type or parameter signature, and run `bun run typecheck` before signaling done. This addresses a recurring pattern where signature changes break unvisited callers, caught only in later review rounds or at runtime.

## Acceptance Criteria

1. `pair-coder-plan.md` contains a "Caller audit for signature changes" instruction (after the existing exhaustive-occurrence-search paragraph) that tells coders: when a plan changes a function's return type, parameter types, or parameter count, list ALL callers in the plan with a note on whether each needs updating.
2. `pair-coder-work.md` contains a "Signature change caller audit" instruction (after the existing "Before modifying any symbol" paragraph) that tells coders: when changing a function's return type or parameter shape, grep for ALL callers and update each one rather than relying solely on the type checker.
3. `pair-coder-work.md` line 13's pre-signaling checklist includes `bun run typecheck` alongside build, lint, and tests.
4. `pair-reviewer-review.md` contains a signature-change verification instruction (after the existing data-shapes paragraph) that tells reviewers: if the implementation changes any function's return type or parameter signature, grep for the function name and verify all callers were updated; flag missed callers as blocking.
5. No duplicate or conflicting instructions introduced. Existing "data shapes" and "exhaustive occurrence search" language remains intact.
6. All existing tests pass. No new template variables or runtime code changes.

## Context

- **Recurring pattern**: Across 3 retrospectives (task-db7a7bc2, task-8fa2056c, task-91ac8dbb), agents changed function signatures without auditing all callers. Tests passed for the modified code, but callers elsewhere still expected the old shape -- discovered late in review or at runtime.
- **Existing partial coverage**: Templates already mention "data shapes" (field extraction, JSON migration) and "exhaustive occurrence search" (symbols being modified/replaced), but agents interpret these narrowly -- they do not connect "I changed this function's return type" with "I must grep for all callers." The gap is the explicit trigger: "when you change a return type or parameter shape, that IS a data shape change requiring caller audit."
- **Relationship to gh-ludics-220** (completed): gh-ludics-220 added code-proposal alignment checklists verifying that proposal assumptions match existing code. This issue is the complement -- verifying that when agents *change* code, all downstream callers are updated.
- **Relationship to gh-ludics-219** (completed): gh-ludics-219 added regression test instructions to the same templates. The new instructions are complementary and non-overlapping.
- **Config key registration** (suggestion #2 from the issue): Already covered by `pair-coder-work.md` line 17-18 (config types / CLI commands drift guidance). No action needed.

## Approach

### 1. `pair-coder-plan.md` -- Add caller audit for signature changes

Insert after the existing exhaustive-occurrence-search paragraph (currently line 20, starting "For every symbol, pattern, or function...") and before the "Don't implement yet" line:

```markdown
When your plan changes a function's return type, parameter types, or parameter count, list ALL callers of that function (grep for the function name project-wide). For each caller, note whether it needs updating to handle the new signature. This applies to TypeScript function signatures, not just JSON/serialization shapes — callers using destructuring, type assertions, or `any` can mask type mismatches.
```

### 2. `pair-coder-work.md` -- Add signature-change caller instruction

Insert after the existing "Before modifying any symbol" paragraph (currently line 15) and before the "A few places where drift..." paragraph:

```markdown
When changing a function's return type or parameter shape, grep for ALL callers of that function across the codebase and update each one. Do not rely solely on TypeScript catching the mismatch — callers using destructuring, type assertions, or `any` can mask the error.
```

### 3. `pair-coder-work.md` -- Add typecheck to pre-signaling checklist

Change line 13 from:
```
Commit in small batches (4-6 files), and include a regression test alongside each behavior change in the same batch. Build, lint, and run targeted tests before signaling done.
```
To:
```
Commit in small batches (4-6 files), and include a regression test alongside each behavior change in the same batch. Build, lint, typecheck (`bun run typecheck`), and run targeted tests before signaling done.
```

### 4. `pair-reviewer-review.md` -- Add signature-change caller verification

Insert after the existing data-shapes paragraph (currently line 9, starting "If the implementation changes data shapes...") and before the "Before treating a failing test..." paragraph:

```markdown
If the implementation changes any function's return type or parameter signature, verify that ALL callers have been updated — grep for the function name and check each call site. Flag missed callers as blocking action items.
```

### Scope

**In scope:** 3 template file edits (small text additions to `pair-coder-plan.md`, `pair-coder-work.md`, `pair-reviewer-review.md`).

**Out of scope:**
- `pair-reviewer-plan-review.md` — already has occurrence completeness and data shape consumer checks (lines 20-22) that cover the plan-review side adequately
- `pair-coder-plan-merge.md` — alignment checking (gh-ludics-220) already covers this phase
- Config key registration — already covered in existing template text
- Pre-commit hooks or CI pipeline — no infrastructure exists; template instructions are the enforcement mechanism
- New template variables or runtime code changes
