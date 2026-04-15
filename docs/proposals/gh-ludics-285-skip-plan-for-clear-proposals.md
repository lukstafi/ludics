# Proposal: Skip plan phase for tasks with unambiguous proposals

**Task**: gh-ludics-285
**Project**: ludics

## Goal

For medium-effort tasks with detailed, unambiguous proposals, the plan + plan-merge + plan-review cycle wastes 2-3 agent dispatch cycles with no value: both coder and reviewer produce near-identical plans because the proposal already specifies what to do. Six retrospectives (gh-ludics-204, gh-ludics-219, gh-ludics-243, gh-ludics-228, gh-ludics-206, task-3432c95a) confirm this pattern. Small tasks already skip planning entirely. This change introduces a `skip_plan` frontmatter flag so that medium-effort tasks with exhaustive proposals also skip planning, going directly from setup to work.

## Acceptance Criteria

1. A new optional `skip_plan: true` field in task frontmatter causes `selectOrchestrationFlags()` to omit `--plan` from medium-effort adapter args, so the orchestration skips directly from setup to work (same behavior as small tasks today).

2. The `skip_plan` field is read from the task file at both call sites that invoke `selectOrchestrationFlags()`: the auto-fill path in `slotStart()` (slots/index.ts) and the keepalive auto-assignment path in `maybeFillEmptySlots()` (mag.ts).

3. When `skip_plan` is true and planning is omitted, the existing stub-plan side effect in `applyPhaseSideEffects()` (runner.ts line ~1336) fires normally (pre-plan -> work creates a stub merged plan for the reviewer template).

4. The `TaskFrontmatter` type (tasks/types.ts) includes the new `skip_plan?: boolean` field, and `parseTaskFrontmatter()` (tasks/markdown.ts) parses it.

5. The draft-proposal worker skill and auto-start-evaluate skill are updated to document that they may set `skip_plan: true` when the proposal is unambiguous and exhaustive. (The actual Mag/skill behavior of *when* to set it is a judgment call at proposal time, not enforced by code.)

6. Large-effort tasks ignore `skip_plan` -- the flag only suppresses `--plan` for medium effort. Large tasks always get `--plan --gather`.

7. No changes to phase transition logic, plan-merge, plan-review, or any orchestration runner code. The mechanism works entirely at the adapter-args level, reusing the existing "no --plan means no planning" pathway.

## Context

### Current behavior

`selectOrchestrationFlags()` in `src/adapters/t3code.ts` (line 665) determines orchestration phase flags based on task effort:

- **small**: no `--plan`, no `--gather` -- goes setup -> work
- **medium**: `--plan` -- goes setup -> plan -> plan-merge -> plan-review -> work
- **large**: `--plan --gather` -- goes setup -> gather -> plan -> plan-merge -> plan-review -> work

The function is called from two places:
1. `maybeFillEmptySlots()` in `src/mag.ts` (line 2460) -- keepalive auto-assignment
2. `slotStart()` in `src/slots/index.ts` (line 798) -- fallback auto-fill when adapter args are empty

Both sites already read the task file content to extract `effort`. The `skip_plan` field needs to be extracted at the same time and passed to `selectOrchestrationFlags()`.

### Existing skip infrastructure

When planning is skipped (pre-plan phase transitions to work), `applyPhaseSideEffects()` in `src/orchestration/runner.ts` (line 1336) already creates a stub merged plan file so the reviewer template has a baseline section. This path fires correctly for small-effort tasks today and will fire for skip_plan medium tasks with no changes.

### Files to modify

1. **`src/tasks/types.ts`** -- Add `skip_plan?: boolean` to `TaskFrontmatter` interface
2. **`src/tasks/markdown.ts`** -- Parse `skip_plan` in `parseTaskFrontmatter()`
3. **`src/adapters/t3code.ts`** -- Add `skipPlan` parameter to `selectOrchestrationFlags()`, suppress `--plan` for medium effort when true
4. **`src/mag.ts`** -- Read `skip_plan` from task file and pass to `selectOrchestrationFlags()`
5. **`src/slots/index.ts`** -- Read `skip_plan` from task file and pass to `selectOrchestrationFlags()`

## Approach

### 1. Type and parser updates

In `src/tasks/types.ts`, add to `TaskFrontmatter`:
```typescript
skip_plan?: boolean;
```

In `src/tasks/markdown.ts`, add to `parseTaskFrontmatter()`:
```typescript
skip_plan: asBoolean(data.skip_plan),
```

### 2. Extend `selectOrchestrationFlags()` signature

In `src/adapters/t3code.ts`, add an optional `options` parameter:

```typescript
export function selectOrchestrationFlags(
  effort: string,
  config?: LudicsFullConfig,
  options?: { skipPlan?: boolean },
): { adapter: string; args: string; isDuo: boolean } {
```

In the body, change the medium-effort branch:

```typescript
if (norm === "large") {
  phaseFlags.push("--plan", "--gather");
} else if (norm === "medium" && !options?.skipPlan) {
  phaseFlags.push("--plan");
}
```

This means: medium + skipPlan behaves like small (no plan flags), while large always gets planning regardless of the flag.

### 3. Thread `skip_plan` through call sites

**`src/mag.ts` (maybeFillEmptySlots)**:

The task object is already available at line 2460. Read `skip_plan` from the task file content that's already being checked for proposals:

```typescript
const taskContent = readFileSync(join(harnessDir(), "tasks", `${task.id}.md`), "utf-8");
const skipPlan = readFrontmatterField(taskContent, "skip_plan") === "true";
const { adapter, args, isDuo } = selectOrchestrationFlags(task.effort, config, { skipPlan });
```

**`src/slots/index.ts` (slotStart auto-fill)**:

The task file content is already read at line 790. Extract `skip_plan` alongside `effort`:

```typescript
const skipPlanMatch = content.match(/^skip_plan:\s*(.+)/m);
const skipPlan = skipPlanMatch ? skipPlanMatch[1]!.trim() === "true" : false;
const { args: autoArgs } = selectOrchestrationFlags(effort, undefined, { skipPlan });
```

### 4. Skill documentation

Update the draft-proposal worker skill (`skills/ludics-draft-proposal-worker.md`) to mention that the worker should set `skip_plan: true` in the JSON response when the proposal is exhaustive and unambiguous, so the orchestrator skill can write it to frontmatter.

Update the auto-start-evaluate documentation to note that `skip_plan` is a valid frontmatter field that influences orchestration flags.

### What does NOT change

- **Phase transition logic** (`evaluateTransition()`) -- unchanged; when `--plan` is absent, `enablePlan` is false in `OrchestrationConfig`, so the runner never enters plan phase
- **`OrchestrationConfig`** -- no new fields; `enablePlan: false` already handles no-planning
- **`applyPhaseSideEffects()`** -- the existing stub-plan creation for pre-plan -> work transitions handles this case
- **Plan-merge / plan-review phases** -- untouched; they just never activate
- **Large-effort tasks** -- always get planning regardless of `skip_plan`
