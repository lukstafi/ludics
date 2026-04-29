# Pin warning counts in lint integration tests

## Goal

The integration tests for `lint-test-isolation` and `lint-contracts` currently
assert only `exitCode === 0`. Both lints have a warning tier where rule hits
do not fail the run, so a regression that introduces a new warning — or a
matcher fix that silently changes coverage — passes the integration test
unnoticed.

This was the actual failure mode in PR #402 (`scripts/lint-test-isolation.ts`):
a `parseImports` bug under-matched side-effect imports, but because rule 3 is
a warning, the integration test stayed green. The reviewer caught it only by
reproducing with a temp fixture. A pinned `warningCount` would have surfaced
the gap immediately — either as a regression to fix or a coverage improvement
to justify and update.

The fix is mechanical and identical across lints with a warning tier: switch
the `spawnSync` shell-out to an in-process `runCli` call (already exported
from each lint module), and assert both `errorCount` and `warningCount`
against a pinned baseline.

Sweep both lints with a warning tier in one go (`lint-test-isolation`,
`lint-contracts`) per task elaboration's resolved Q2.

Source: `tasks/task-4f13a49b.md` (retrospective follow-up from `task-68fe7177` /
PR #402).

## Acceptance Criteria

- `scripts/lint-test-isolation.test.ts` integration block calls `runCli`
  in-process (replacing the existing `spawnSync` invocation) and asserts both
  `errorCount === 0` and a pinned `warningCount` matching the count produced
  by running the lint against `src/` on the worker's HEAD.
- `scripts/lint-contracts.test.ts` integration block does the same: calls
  `runCli` in-process and asserts both `errorCount === 0` and the pinned
  `warningCount` (currently 0 on HEAD; worker re-runs to confirm).
- Each pinned-count assertion is preceded by a one-line comment explaining
  the dual interpretation: a count change either signals a regression (fix
  the new test) or a coverage improvement (justify the matcher change and
  update the count).
- `bun test scripts/lint-test-isolation.test.ts` and
  `bun test scripts/lint-contracts.test.ts` continue to pass on the worker's
  HEAD.
- `bun run lint:test-isolation` and `bun run lint:contracts` continue to pass
  (no script changes — only test changes).
- The assertion catches a regression: temporarily removing the side-effect-
  import branch in `parseImports` (in `lint-test-isolation.ts`) makes the
  pinned-count test fail. Worker verifies this manually and reverts.
- Lints without a warning tier (`lint-template-safety`, `lint-config-helpers`,
  `lint-cli-readme`) are not modified — pinning warnings on a lint that emits
  none would be churn for no signal.

## Context

### How the integration tests look today

`scripts/lint-test-isolation.test.ts:769-783` and
`scripts/lint-contracts.test.ts:508-522` both follow the same pattern:

```ts
describe("integration", () => {
  test("lint-X exits 0 on current repo", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-X.ts")],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    // ...
    expect(result.exitCode).toBe(0);
  });
});
```

Only the exit code is checked. Warning-tier rule hits (which don't change the
exit code) are invisible to the assertion.

### What `runCli` exposes

Both lints already export an in-process `runCli` with parameterised output
sinks, designed exactly for this use case:

- `scripts/lint-test-isolation.ts` — `runCli(options: RunCliOptions): { exitCode, errorCount, warningCount, issues }`.
  Options include `srcDir`, `repoRoot`, `writeErr`, `writeOut`. Used by the
  unit tests in the same file via `driveRunCli` (around line 509).
- `scripts/lint-contracts.ts` — `runCli(options: RunCliOptions = {}): { exitCode, errorCount, warningCount, fileWarnings, pairReports }`.
  Options include `skillsDir`, `writeErr`, `writeOut`. Used directly by unit
  tests.

The integration test just needs to call `runCli` with `srcDir`/`skillsDir`
pointed at the real repo and silenced sinks (`writeErr: () => {}`,
`writeOut: () => {}`), then read `errorCount` and `warningCount` off the
returned object. No stdout/stderr scraping required.

### Live counts on HEAD (2026-04-29)

```
$ bun run scripts/lint-test-isolation.ts
✅  No test-isolation anti-patterns detected (19 warnings).
errorCount: 0, warningCount: 19

$ bun run scripts/lint-contracts.ts
✅  Worker/orchestrator field contracts are in sync.
errorCount: 0, warningCount: 0
```

Worker re-runs both at HEAD before pinning to confirm; counts may drift as
new tests / skill pairs land.

### Lints without a warning tier (not in scope)

Confirmed by inspection:

- `scripts/lint-template-safety.ts` — `runLint` returns `Violation[]`, no
  warning tier. Errors only.
- `scripts/lint-config-helpers.ts` — no `warningCount`, no `severity:
  "warning"`. Errors only.
- `scripts/lint-cli-readme.ts` — not inspected in detail; integration test
  pattern likely identical, but no warning tier observed in cursory read.
- `scripts/lint-unused-vars-underscore.test.ts` — config-regression test, not
  a standalone lint script; no `runCli` to drive.

The retrospective mentioned `lint-template-safety` and
`lint-unused-vars-underscore` as candidates, but neither has a warning tier
(or a matching shape). Pinning a warning count of 0 on a lint that never
emits warnings is dead weight in the test.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

For each of the two integration test blocks, replace the `spawnSync` body
with an in-process `runCli` call. Concretely, in
`scripts/lint-test-isolation.test.ts` the integration block becomes
something like:

```ts
describe("integration", () => {
  test("lint-test-isolation: no errors, warning count pinned", () => {
    const repo = join(import.meta.dir, "..");
    const result = runCli({
      srcDir: join(repo, "src"),
      repoRoot: repo,
      writeErr: () => {},
      writeOut: () => {},
    });
    expect(result.errorCount).toBe(0);
    // When this fails: either a new test introduced an unhandled
    // isolation anti-pattern (regression — fix the test) OR a matcher
    // improvement found new real-world hits (coverage upgrade — justify
    // and update the count).
    expect(result.warningCount).toBe(<live-count>);
  });
});
```

`runCli` is already imported at `scripts/lint-test-isolation.test.ts:14`, so
no new import needed. For `scripts/lint-contracts.test.ts`, import `runCli`
from `./lint-contracts` (likely already imported by the unit tests above) and
pass `skillsDir: join(repo, "skills")` (or whichever path matches the lint's
default). Worker checks the existing import and the lint's `skillsDir`
default before writing.

Use the live counts from `bun run scripts/lint-test-isolation.ts` and
`bun run scripts/lint-contracts.ts` on the worker's HEAD. The retrospective
suggested 18 for test-isolation; the elaboration measured 19 on 2026-04-26;
the worker re-runs to confirm.

## Scope

**In scope:**
- `scripts/lint-test-isolation.test.ts` integration block — replace
  `spawnSync` with in-process `runCli`, pin both counts, add explanatory
  comment.
- `scripts/lint-contracts.test.ts` integration block — same shape.

**Out of scope:**
- Pinning counts on lints without a warning tier (`lint-template-safety`,
  `lint-config-helpers`, `lint-cli-readme`).
- Changing rule severities, matchers, or any lint-script logic.
- Adding list-snapshot assertions (sorted `(file, rule)` tuples). User
  resolved Q1: count only. The lint's stdout on failure is the diagnostic.
- Keeping the `spawnSync` invocation alongside the new in-process call.
  User resolved Q3: replace, not augment. End-to-end CLI binary coverage is
  overkill for a count-pin.

**Dependencies:** none. Self-contained test changes.
