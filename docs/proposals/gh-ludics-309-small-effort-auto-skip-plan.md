# Proposal: Make "small effort skips plan" an explicit, tested contract

**Task**: gh-ludics-309
**Project**: ludics
**Source issue**: https://github.com/lukstafi/ludics/issues/309

## Goal

Retrospectives across many trivial tasks (gh-ludics-204, gh-ludics-219, gh-ludics-241, task-f3b6e620) observe that the plan / plan-merge / plan-review loop adds overhead without value for tiny changes. The existing `skip_plan` frontmatter flag (gh-ludics-285) addresses this for **medium** tasks when the user manually opts in, but the natural lever is the `effort` field itself: small tasks already fall through the phase-flag selection without getting `--plan`, yet this is an implicit accident of the `if / else if` structure in `selectOrchestrationFlags()` and is not asserted by any test.

This change makes the rule explicit in code and in tests:

> **Small-effort tasks never get the `--plan` flag, regardless of `skip_plan`. `skip_plan` remains a manual override for medium-effort tasks only.**

The behavior is already what the code does today, but the rule is load-bearing for future work (notably task-da8b6dff, which adds a `tiny` effort below small and needs the same guarantee). Making it an explicit contract prevents a regression where a future refactor of `selectOrchestrationFlags()` accidentally hands `--plan` to small tasks.

## Acceptance Criteria

1. `selectOrchestrationFlags()` in `src/adapters/t3code.ts` omits `--plan` (and `--gather`) for `effort === "small"` regardless of the `options.skipPlan` value. This holds for unknown/empty effort values too (the existing fallthrough is preserved).

2. `selectOrchestrationFlags()` for `effort === "medium"` includes `--plan` when `options.skipPlan` is absent or `false`, and omits `--plan` when `options.skipPlan === true`. (No regression from the gh-ludics-285 behavior.)

3. `selectOrchestrationFlags()` for `effort === "large"` always includes `--plan --gather`, regardless of `options.skipPlan`. (No regression.)

4. `selectOrchestrationFlagsForTask()` in `src/adapters/t3code.ts` preserves the same matrix when the `skip_plan` value is read from frontmatter instead of passed explicitly.

5. `src/tasks/types.ts` and `src/tasks/markdown.ts` are **not modified**. `skip_plan` parsing stays as-is (it remains a valid manual override for medium tasks).

6. The plan-merge template at `skills/orchestration/pair-coder-plan-merge.md` and the single-plan skip logic at `src/orchestration/phases.ts` / `src/orchestration/runner.ts` are **not modified**.

7. The unit-test suite for `selectOrchestrationFlags` / `selectOrchestrationFlagsForTask` in `src/adapters/t3code.test.ts` covers the full effort × skip_plan matrix with explicit small-effort rows:
   - small, no skipPlan → no `--plan`, no `--gather`
   - small, skipPlan: true → no `--plan`, no `--gather` (already present; keep)
   - medium, no skipPlan → `--plan`
   - medium, skipPlan: true → no `--plan`
   - large, no skipPlan → `--plan --gather`
   - large, skipPlan: true → `--plan --gather`
   - For `selectOrchestrationFlagsForTask`: small task with `skip_plan: true` in frontmatter → no `--plan` (new).

8. A one-line docstring note is added to `selectOrchestrationFlags()` stating that small effort auto-skips the plan phase and that `skip_plan` is only consulted for medium effort.

9. The CHANGELOG has a line under the next unreleased section calling out that small-effort tasks are now documented to always skip the plan phase (no behavior change for existing users; it codifies the rule).

## Context

### Current code — `selectOrchestrationFlags()` in `src/adapters/t3code.ts`

The phase-flag selection block (the logic this proposal targets):

```typescript
if (norm === "large") {
  phaseFlags.push("--plan", "--gather");
} else if (norm === "medium" && !options?.skipPlan) {
  phaseFlags.push("--plan");
}
// small / unknown: no pre-work phases
```

`small` (and anything unrecognized) falls through both branches, so `phaseFlags` stays empty and the emitted args never contain `--plan`. This is what we want, but nothing in the tests covers the `small, no skipPlan` row explicitly — the only small-effort assertion is the `small + skipPlan: true` variant in the existing `t3code.test.ts` block at the `"small effort with skipPlan: true has no phase flags"` test.

### Wrapper — `selectOrchestrationFlagsForTask()`

```typescript
export function selectOrchestrationFlagsForTask(
  taskContent: string,
  effort: string,
  config?: LudicsFullConfig,
): { adapter: string; args: string; isDuo: boolean } {
  const skipPlan = readFrontmatterField(taskContent, "skip_plan") === "true";
  return selectOrchestrationFlags(effort, config, { skipPlan });
}
```

This wrapper is the one actually called from `mag.ts` (keepalive auto-fill) and `slots/index.ts` (slotStart auto-fill). It passes `skipPlan` through unconditionally, which is fine: the small-effort branch already ignores it.

### Why not touch `skip_plan` parsing

The user-resolved questions on the task file (Q1, Q2, Q3) explicitly narrow scope to "effort-based skip only", drop plan-convergence detection and configurable iteration caps, and keep `skip_plan` as a **manual override for medium tasks**. So `src/tasks/types.ts` line 17 and `src/tasks/markdown.ts` line 55 stay untouched.

### Interaction with task-da8b6dff (tiny effort + solo mode)

task-da8b6dff adds a new `tiny` effort level below small. Under this proposal's rule, tiny will also fall through the `if / else if` and automatically skip the plan phase — no additional work needed in this task. That task's solo mode also skips plan by default, but on a different axis (mode-driven vs. effort-driven); the two compose cleanly. This proposal does not need to block on tiny.

### Existing related fixes in the tree

- `phases.ts` lines ~467–481 already skip the plan-merge step when only one plan file exists (single-plan promote). This was done after the issue was filed and partially addressed the "merge is wasted for trivial tasks" complaint. No change needed here.
- gh-ludics-285 introduced `skip_plan` as a manual medium-task override. This proposal does not alter that mechanism.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. Make the small-effort branch explicit in `selectOrchestrationFlags()`

Rewrite the phase-flag block so the intent is unambiguous and the existing "fall-through" becomes a named branch:

```typescript
// Small / tiny / unknown effort: never run pre-work phases.
// `skip_plan` is only consulted for medium effort (manual override for
// exhaustive proposals). Large always runs --plan --gather.
if (norm === "large") {
  phaseFlags.push("--plan", "--gather");
} else if (norm === "medium") {
  if (!options?.skipPlan) phaseFlags.push("--plan");
}
// else: small / tiny / unknown → no pre-work phases (no --plan, no --gather)
```

The behavior is identical to today, but the comment and the separated `else if` make the rule obvious to anyone reading the code.

### 2. Extend the test matrix

In `src/adapters/t3code.test.ts`, inside the existing `describe("selectOrchestrationFlags — skip_plan", …)` block, add the missing small-effort row:

```typescript
test("small effort without skipPlan has no phase flags", () => {
  const { args } = selectOrchestrationFlags("small");
  expect(args).not.toContain("--plan");
  expect(args).not.toContain("--gather");
});

test("large effort with skipPlan: true still includes --plan --gather", () => {
  // already present — keep
});

test("large effort without skipPlan includes --plan --gather", () => {
  const { args } = selectOrchestrationFlags("large");
  expect(args).toContain("--plan");
  expect(args).toContain("--gather");
});

test("unknown effort has no phase flags", () => {
  const { args } = selectOrchestrationFlags("");
  expect(args).not.toContain("--plan");
  expect(args).not.toContain("--gather");
});
```

In the `describe("selectOrchestrationFlagsForTask — skip_plan from frontmatter", …)` block, add a small-task row:

```typescript
test("small task with skip_plan: true in frontmatter still omits --plan", () => {
  const content = "---\nid: test\ntitle: test\neffort: small\nskip_plan: true\n---\n";
  const { args } = selectOrchestrationFlagsForTask(content, "small");
  expect(args).not.toContain("--plan");
});

test("small task without skip_plan omits --plan", () => {
  const content = "---\nid: test\ntitle: test\neffort: small\n---\n";
  const { args } = selectOrchestrationFlagsForTask(content, "small");
  expect(args).not.toContain("--plan");
});
```

### 3. Docstring + CHANGELOG

Update the JSDoc comment above `selectOrchestrationFlags()` (around lines ~650–665) so the effort rubric is explicit:

```
* Effort-based selection (when coder is claude-code):
* - small:  pair mode, no pre-work phases, Sonnet model. skip_plan is ignored (already skipped).
* - medium: pair mode, --plan unless skip_plan: true in frontmatter, Opus model.
* - large:  pair mode, --plan --gather (skip_plan is ignored), Opus model.
```

Add a short entry to `CHANGELOG.md` under the next unreleased heading, e.g.:

```
### Documentation / contracts
- **Small-effort tasks are now explicitly documented to skip the plan phase.**
  `skip_plan` remains a manual override applying only to medium effort. No
  behavior change; the rule is now asserted by tests (selectOrchestrationFlags
  / selectOrchestrationFlagsForTask).
```

## Scope

### In scope

- `src/adapters/t3code.ts` — make the small-effort branch explicit (comment + structure), update docstring.
- `src/adapters/t3code.test.ts` — fill out the effort × skip_plan test matrix with the currently missing small-effort and large-no-skipPlan rows.
- `CHANGELOG.md` — one-line entry.

### Out of scope (explicit non-goals from user-resolved questions)

- Plan-convergence detection via string diff between coder and reviewer plans (rejected: "identical plans" in retrospectives was semantic alignment, not byte-identical text).
- Heuristic file-type or title-pattern detection of triviality (rejected: project-specific, won't generalize).
- Making the plan-merge iteration cap (currently 3 at `phases.ts:492`) configurable.
- Modifying the plan-merge template (`skills/orchestration/pair-coder-plan-merge.md`).
- Adding a `tiny` effort level — handled by task-da8b6dff.
- Modifying `skip_plan` parsing in `src/tasks/types.ts` or `src/tasks/markdown.ts`.
- Modifying `src/orchestration/phases.ts` or `src/orchestration/runner.ts` — the single-plan-skip shortcut is already in place.

### Dependencies

- None. task-da8b6dff (tiny effort) is orthogonal and will slot into the same `else` branch when it lands; nothing in this task needs to wait for it.
