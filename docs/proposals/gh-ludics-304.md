# Cross-machine test verification gaps

## Goal

Eliminate unnecessary review round-trips caused by environment differences between
coder and reviewer agents. When tests fail only because the reviewer runs on
different hardware, OS, or worktree configuration, the reviewer should classify
them as environment-specific rather than blocking -- and the coder should
proactively guard environment-dependent tests with conditional skips.

Issue: https://github.com/lukstafi/ludics/issues/304

## Acceptance Criteria

1. The coder plan template (`pair-coder-plan.md`) instructs the coder to identify
   environment-dependent tests during baseline recording and document which tests
   require specific hardware/OS (GPU, platform-specific APIs) with a note on what
   to guard with `test.skipIf()` or equivalent.

2. The coder work template (`pair-coder-work.md`) instructs the coder to add
   `test.skipIf()` guards (or framework equivalent) with descriptive skip messages
   for any new tests that depend on hardware, OS, or environment-specific resources
   (GPU, specific ports, filesystem permissions).

3. The reviewer review template (`pair-reviewer-review.md`) contains explicit
   guidance for environment-specific failures: if a test failure cannot be
   reproduced and appears caused by hardware requirements (GPU, OS),
   port allocation, filesystem permissions, or timing differences, the reviewer
   notes it as a non-blocking observation and requests a `test.skipIf()` guard
   rather than blocking the review.

4. The reviewer gather template (`pair-reviewer-gather.md`) strengthens its
   existing discrepancy note to explicitly classify hardware/OS-dependent test
   discrepancies as environment-sensitive and non-blocking when the project has
   known hardware requirements.

5. `buildSkillContext()` in `src/orchestration/skills.ts` injects
   `PROJECT_REQUIREMENTS_OS` and `PROJECT_REQUIREMENTS_GPU` from the project
   config's `requirements` object, so templates can display the project's hardware
   context. The reviewer review and gather templates reference these variables
   (via `{{#IF ...}}` conditional blocks) to surface known requirements.

6. No changes to CI workflow, runner logic, or orchestration phase transitions.
   CI test integration is out of scope (separate task).

## Context

### Problem

Across 7 retrospectives, reviewer agents operating on different machines or
worktrees from the coder encounter test failures that are environment-specific
rather than regressions. This causes:

- Unnecessary `REQUEST_CHANGES` verdicts for hardware-dependent test failures
  (e.g., Metal GPU tests failing on a Linux reviewer)
- Wasted review rounds on `EADDRINUSE`, filesystem permission, or timing flakes
- No template guidance telling the reviewer how to distinguish environment failures
  from real regressions

### What already exists (partial mitigations)

- `pair-coder-plan.md`: Instructs the coder to run `bun test` and record failing
  test names under `## Pre-existing test failures (baseline)`.
- `pair-reviewer-gather.md`: Instructs the reviewer to run `bun test` and
  cross-check against the coder's baseline, noting that "discrepancies are
  typically caused by different merge bases or environment-sensitive tests."
- `pair-reviewer-review.md`: Instructs the reviewer to check the baseline section
  and not block on pre-existing failures.
- `runner.ts` `skipPlanStub()`: Creates a stub merged plan when planning is
  skipped, so the reviewer always has a baseline section.

### Gap analysis

**Gap 1 -- No `test.skipIf()` guidance in coder templates.** Neither
`pair-coder-plan.md` nor `pair-coder-work.md` tells the coder to guard
environment-dependent tests with conditional skips. The reviewer encounters
these failures and either blocks or wastes a round requesting the guard.

**Gap 2 -- Reviewer lacks environment-aware verdict rules.** The review template
handles pre-existing failures via the baseline section but has no instruction for
new test failures that are environment-specific rather than regressions.

**Gap 3 -- Hardware requirements not surfaced in templates.**
`buildSkillContext()` auto-injects project config string fields as `PROJECT_*`
variables (line ~289), but `requirements` is an object (`{ os?, gpu? }`) so it is
skipped by the `typeof val === "string"` guard. The reviewer has no way to see
the project's hardware requirements from the template context.

### Files to modify

| File | Change |
|------|--------|
| `skills/orchestration/pair-coder-plan.md` | Add `test.skipIf()` guidance after baseline instructions |
| `skills/orchestration/pair-coder-work.md` | Add environment-dependent test guidance |
| `skills/orchestration/pair-reviewer-review.md` | Add environment-specific failure handling paragraph |
| `skills/orchestration/pair-reviewer-gather.md` | Strengthen discrepancy classification |
| `src/orchestration/skills.ts` | Extract `requirements.os` and `requirements.gpu` into `PROJECT_REQUIREMENTS_OS` / `PROJECT_REQUIREMENTS_GPU` context variables |

## Approach

### Template changes

**`pair-coder-plan.md`** -- After the existing baseline instruction paragraph
(line 9), add a new paragraph:

> For tests that depend on specific hardware (GPU type, OS) or environment
> resources (fixed ports, filesystem permissions), note the dependency next to the
> test name in the baseline section. When writing new tests in later rounds, guard
> environment-dependent assertions with `test.skipIf()` (or the project's
> equivalent) and include a descriptive skip reason.

**`pair-coder-work.md`** -- After the existing "Build, lint, and run targeted
tests before signaling done" sentence (line 13), add:

> When adding tests that require specific hardware (GPU, OS) or environment
> resources (ports, filesystem permissions), wrap them in `test.skipIf()` (or
> equivalent) with a message explaining the requirement, so the reviewer's
> environment can skip gracefully.

**`pair-reviewer-review.md`** -- After the existing pre-existing failures
paragraph (line 11), add a new paragraph:

> **Environment-specific failures**: If a test failure is absent from the coder's
> run and appears caused by hardware differences (GPU, OS), port allocation,
> filesystem permissions, or timing, note it as a non-blocking observation.
> Request a `test.skipIf()` guard rather than blocking.{{#IF PROJECT_REQUIREMENTS_OS}}
> This project requires OS: {{PROJECT_REQUIREMENTS_OS}}.{{/IF}}{{#IF PROJECT_REQUIREMENTS_GPU}}
> This project requires GPU: {{PROJECT_REQUIREMENTS_GPU}}.{{/IF}}

**`pair-reviewer-gather.md`** -- Strengthen the existing discrepancy note
(line 11) by appending to the existing sentence:

> If the project has hardware requirements (GPU, OS), classify failures from
> missing hardware as environment-sensitive, not as regressions.{{#IF PROJECT_REQUIREMENTS_GPU}}
> This project requires GPU: {{PROJECT_REQUIREMENTS_GPU}}.{{/IF}}

### Code change: `buildSkillContext()` in `src/orchestration/skills.ts`

After the existing auto-inject loop (which skips non-string fields), add explicit
extraction for the `requirements` object:

```typescript
// Inject hardware requirements as individual string fields for template conditionals.
if (_projectEntry?.requirements) {
  const reqs = _projectEntry.requirements;
  if (reqs.os) result.PROJECT_REQUIREMENTS_OS = reqs.os;
  if (reqs.gpu) result.PROJECT_REQUIREMENTS_GPU = reqs.gpu;
}
```

This goes after the `for (const [key, val] of Object.entries(_projectEntry))`
loop (after line ~294), before the `PR_CREATE_REPO_FLAG` assignment.

### Testing

- Add a unit test in `src/orchestration/skills.test.ts` (or the existing test
  file for `buildSkillContext`) that verifies `PROJECT_REQUIREMENTS_OS` and
  `PROJECT_REQUIREMENTS_GPU` are populated when the project config has
  `requirements: { os: "macos", gpu: "apple-silicon" }` and are absent when
  `requirements` is undefined.
- Verify that `substituteTemplate` correctly handles the `{{#IF PROJECT_REQUIREMENTS_GPU}}` conditional blocks (existing `{{#IF}}` tests should cover the pattern, but add one if not).
