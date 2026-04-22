# Fix pre-existing test failures on main masking regressions in agent reviews

## Goal

Three tests on `main` have been failing for multiple days, causing agents to habituate to "pre-existing failures" in their reviews and risk missing real regressions they introduce. The failures are not caught by CI because CI does not run `bun test`. Fix the three tests so that `bun test` on `main` passes cleanly, restoring the value of regression signals in agent workflows.

Upstream: https://github.com/lukstafi/ludics/issues/326

## Acceptance Criteria

1. `src/dashboard.test.ts > generateRecentlyCompleted shape guards > non-object event lines do not create false pr_merged state` passes regardless of the current wall-clock date (i.e., fixtures use dates relative to `Date.now()` and stay inside the 7-day window used by `generateRecentlyCompleted`).
2. `src/dashboard.test.ts > generateRecentlyCompleted shape guards > non-object retrospective JSON is silently ignored` passes regardless of the current wall-clock date, for the same reason.
3. `templates/dashboard/dashboard.test.ts > style.css contains pending-action-badge class > pending-action-badge uses amber/yellow color` passes against the actual CSS implementation, which uses `var(--warning)` / `var(--warning-dim)` rather than the literal `rgba(245, 158, 11, ...)` from the original gh-ludics-172 proposal. The test continues to verify that the badge is styled with the design system's warning color.
4. A fresh clone, `bun install`, and `bun test` run on `main` after this change reports 0 failing tests.
5. A decision is recorded (in this proposal and in CHANGELOG) on whether CI should run `bun test`. Either (a) a `bun test` job is added to `.github/workflows/ci.yml`, or (b) the decision to defer that work is documented with rationale and linked to a follow-up issue/task.

## Context

### Failing test 1 & 2: `src/dashboard.test.ts` — date-sensitive fixtures

The `writeCompletedTask` helper in the `generateRecentlyCompleted shape guards` describe block hardcodes `completed: "2026-04-10T00:00:00Z"`:

```typescript
`---\nid: ${id}\ntitle: "${title}"\nstatus: done\npriority: C\ncompleted: "2026-04-10T00:00:00Z"\nstarted: "2026-04-09T00:00:00Z"\ncreated: "2026-04-09"\neffort: small\ncontext: ludics\n---\n\n# ${title}\n`
```

Production `generateRecentlyCompleted()` in `src/dashboard.ts` filters to tasks whose `completed` timestamp is within `Date.now() - 7 * 24 * 60 * 60 * 1000`. Once the wall clock passes 2026-04-17, the fixture task falls outside the window, `recent` becomes empty, and `recent.find((t) => t.id === "task-test-1")` returns `undefined`, so the `expect(task).toBeDefined()` assertion fails.

The first test also hardcodes a matching `ts` / `epoch` in the `pr_merged` event inside the events JSONL fixture — those must stay aligned with the task's `completed` timestamp.

### Failing test 3: `templates/dashboard/dashboard.test.ts` — CSS variable mismatch

The test asserts:

```typescript
test("pending-action-badge uses amber/yellow color", () => {
    expect(style).toContain("rgba(245, 158, 11");
});
```

But the CSS rule at `.slot-details .pending-action-badge` in `templates/dashboard/style.css` uses CSS custom properties:

```css
background-color: var(--warning-dim);
color: var(--warning);
border: 1px solid var(--warning);
```

Theme variables resolve to `#f5a623` (night), `#ca8a04` (day), `#ffaa00` (OLED), with `--warning-dim` being `rgba(245, 166, 35, 0.12)` (night). No theme contains the string `rgba(245, 158, 11`. The assertion was written against the color suggested in the gh-ludics-172 proposal, which the implementation did not literally adopt — it uses the design system's warning token instead.

### CI does not run `bun test`

`.github/workflows/ci.yml` runs `bun run typecheck`, `bun run build`, `bun run lint:cli-readme`, `bun run lint:config-reference`, and `bun run lint:no-mock-module`, but has no `bun test` step. That is why a regression introduced months ago only surfaced as retrospective chatter from agents.

### Overlap with task-821825e6

`task-821825e6` (spawned from `task-d1932b8f`'s retrospective) proposes fixing the same three failures. This task (`gh-ludics-326`) predates it and already has the root-cause analysis. If this proposal merges first, `task-821825e6` should be marked stale/abandoned as a duplicate.

### Out of scope

- Broader test-file restructuring — that belongs to `task-9f21d3de`.
- Changes to the `generateRecentlyCompleted` production code itself — the 7-day window is correct; the test fixtures are wrong.
- Reviewer template guidance for environment-specific failures — handled by `gh-ludics-304` (deferred).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Fix 1 & 2: relative dates in `src/dashboard.test.ts`

Rewrite `writeCompletedTask` in the `generateRecentlyCompleted shape guards` describe block to compute dates relative to `Date.now()`, staying well inside the 7-day window. A completion ~2 days ago with a `started` timestamp ~3 days ago is safe and realistic:

```typescript
function writeCompletedTask(id: string, title: string): void {
    const tasksDir = join(harnessDir(), "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const completedIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const startedIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const createdDate = startedIso.slice(0, 10);
    writeFileSync(
        join(tasksDir, `${id}.md`),
        `---\nid: ${id}\ntitle: "${title}"\nstatus: done\npriority: C\ncompleted: "${completedIso}"\nstarted: "${startedIso}"\ncreated: "${createdDate}"\neffort: small\ncontext: ludics\n---\n\n# ${title}\n`,
    );
}
```

In the first test, update the `pr_merged` event fixture so its `ts` matches the task's `completed` timestamp, and its `epoch` is derived from that:

```typescript
// Near the top of the test body — reuse the same relative completion timestamp
const completedIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const completedEpoch = Math.floor(new Date(completedIso).getTime() / 1000);
// ...
JSON.stringify({ event_type: "pr_merged", task: "task-test-1", ts: completedIso, epoch: completedEpoch }),
```

(If the helper exposes the timestamp it generated, the test can reuse it directly; otherwise recomputing with the same offset is fine since the test controls both sides.)

We prefer relative-date fixtures over mocking `Date.now()`. `dashboardGenerate` is imported dynamically per test and captures date-related values at module load, so a `spyOn(Date, "now")` approach is fragile and easy to break when internal call sites move.

### Fix 3: assert the design-system variable, not a literal RGB string

Update `templates/dashboard/dashboard.test.ts` to check that the `.pending-action-badge` rule references the warning CSS variables. This tests the design intent (badge uses the warning color token) without being brittle about theme-specific RGB values:

```typescript
test("pending-action-badge uses warning color variables", () => {
    // Find the .pending-action-badge rule block and assert it uses the
    // design system's warning color tokens.
    const ruleMatch = style.match(/\.pending-action-badge\s*\{[^}]*\}/);
    expect(ruleMatch).not.toBeNull();
    const ruleBlock = ruleMatch![0];
    expect(ruleBlock).toContain("var(--warning-dim)");
    expect(ruleBlock).toContain("var(--warning)");
});
```

Scoping the assertion to the rule block prevents accidental passes from `var(--warning)` used elsewhere in the stylesheet. The test title should also be updated to reflect that it asserts variables rather than a literal color.

### Decision on CI: add `bun test`

Recommend (a): add `bun test` to `.github/workflows/ci.yml` as a new step after build/lint. The whole point of this task is that undetected test-suite drift erodes the signal quality of agent reviews; the minimal fix (restoring a clean baseline) without CI enforcement means this situation can recur as soon as the next test is written against unstable fixtures or stale proposal text.

Proposed CI addition (to be added after the existing lint steps):

```yaml
      - name: Run tests
        run: bun test
```

If `bun test` has harness-state assumptions that do not hold in a clean CI environment, the coder should either (i) isolate the offending tests behind a skip guard with a TODO linked to a follow-up issue, or (ii) fix the harness-state coupling. The AC does not require "all tests pass in CI on first try" — it requires that either CI runs `bun test` or the decision to defer is documented with a linked follow-up issue.

Record the decision in `CHANGELOG.md` under an appropriate unreleased section (e.g., "Baseline test suite now clean on main; CI runs `bun test`." or "Baseline test suite now clean on main; `bun test` in CI deferred to #NNN.").

### Files to modify

| File | Change |
|------|--------|
| `src/dashboard.test.ts` | Replace hardcoded dates in `writeCompletedTask` and the `pr_merged` event fixture (around the `generateRecentlyCompleted shape guards` block, lines ~237–265) with dates computed from `Date.now()`. |
| `templates/dashboard/dashboard.test.ts` | Replace the literal-RGB assertion in `pending-action-badge uses amber/yellow color` with an assertion on the `var(--warning*)` tokens, scoped to the `.pending-action-badge` rule block. Update the test title. |
| `.github/workflows/ci.yml` | Add a `bun test` step (unless the coder finds a blocking harness-state issue, in which case document the deferral and link a follow-up issue). |
| `CHANGELOG.md` | Note the baseline cleanup and the CI decision. |

## Scope

**In scope**: the three test fixes, the CI workflow change (or a documented deferral), and a CHANGELOG entry.

**Out of scope**:
- Broader dashboard-test restructuring (`task-9f21d3de`).
- Changes to `generateRecentlyCompleted` or any other production code — the production behavior is correct; only fixtures and assertions are wrong.
- Reviewer-template guidance for environment-specific failures (`gh-ludics-304`, deferred).
- Investigating why the per-project health check (`task-d0b61b6b`) did not auto-file a fix task for ludics' own test suite. Worth a follow-up but not a blocker here.

**Dependencies**: none blocking. Relates to: gh-ludics-197 (baseline recording), gh-ludics-219 (regression-test reminders), gh-ludics-304 (env mismatches, deferred), task-e7bb2adc (baseline-section stub plans), task-821825e6 (duplicate — should be abandoned when this lands).
