# Proposal: Project health — detect local test suite failures and file priority-A fix tasks

**Task:** task-d0b61b6b
**Date:** 2026-04-06

## Goal

Periodically run each configured project's local test suite during health-check, detect failures, and auto-file priority-A fix tasks so agents always have a green baseline to work against.

## Acceptance Criteria

- `ProjectConfig` has an optional `test_command` field; when absent, the test command is auto-detected from the project directory.
- Auto-detection covers: `dune-project` → `dune runtest`, `bun.lockb` → `bun test`, `package.json` with a `"test"` script → `npm test`, `Makefile` with a `test` target → `make test`; no match → skip.
- A new `src/health.ts` module implements `detectTestCommand()`, `checkProjectTestHealth()`, and `shouldRunTestHealth()`.
- `shouldRunTestHealth()` returns true only when (a) the previous run for that project is 24+ hours ago, or (b) the current local hour is inside the configured night window (default `[0, 6)`).
- Night-window check uses `new Date().getHours()` (local time), not UTC.
- Per-project test results are stored in `$HARNESS/mag/test-health.json` with `lastRun`, `passed`, and optionally `failures`.
- On failure, `ludics tasks create "Fix broken test suite: <project>" <project> A` is called; this is idempotent due to content-fingerprint dedup.
- The health-check queue handler in `src/mag.ts` (around the `"health-check"` case) invokes test health after existing checks.
- `ludics-health-check.md` skill instructions include a "Test Suite Health" step describing what to report and when.
- Night window is configurable via `mag.test_health_night_hours: [startHour, endHour]` in `config.yaml` (default `[0, 6]`).

## Context

**Motivation:** A broken test suite is a blocker for efficient agent work. Health-check (14:20, 20:20, 02:20) is already the right cadence — especially the 02:20 night run. Tests are expensive (CPU), so they must not run on every 4h health-check invocation; only the night trigger (or 24h stale fallback) should fire them.

**Existing primitives:**
- `resolveProjectPath(name)` in `src/config.ts:335` — resolves a project's local checkout path.
- `tasksCreate(title, project, priority)` in `src/tasks/index.ts:72` — idempotent via `contentFingerprint(title)` → `task-<hash>` ID; already handles the "task already exists" case.
- `ProjectConfig` in `src/config.ts:15` — currently has no `test_command` field.
- Health-check queue handler in `src/mag.ts:3242` — queues the `health-check` action for the Mag skill; actual skill invocation happens via the queue-pop / stop-hook path.

**Scheduling logic:** The health-check trigger fires three times daily (14:20, 20:20, 02:20 local time). Tests should run only at 02:20 (inside the `[0, 6)` night window) or if the last run was 24+ hours ago. Using local hours is essential — launchd `StartCalendarInterval` uses local time, so a UTC check would be fragile.

**Related:** `gh-ludics-197` handles pre-existing failures inside orchestration plan phases. This task handles the higher-level "is the test suite currently broken at health-check time?" question.

### Key files

| File | Relevance |
|------|-----------|
| `src/config.ts:15-44` | `ProjectConfig` interface — add `test_command?: string` |
| `src/config.ts:335` | `resolveProjectPath()` — used by new health module |
| `src/health.ts` | New module: `detectTestCommand`, `checkProjectTestHealth`, `shouldRunTestHealth` |
| `src/mag.ts:3242` | Health-check case — call test health after existing checks |
| `src/tasks/index.ts:72` | `tasksCreate()` — idempotent task filing |
| `skills/ludics-health-check.md` | Add "Test Suite Health" step |
| `$HARNESS/mag/test-health.json` | Per-project last-run / pass/fail state |

## Approach

### 1. Add `test_command` to `ProjectConfig`

In `src/config.ts`, add one field to the interface:

```typescript
/** Command to run the project's test suite locally.
 *  Auto-detected from project directory contents when unset. */
test_command?: string;
```

### 2. New `src/health.ts` module

#### `detectTestCommand(projectPath: string): string | null`

Check files in order:
1. `dune-project` exists → `"dune runtest"`
2. `bun.lockb` or `bun.lock` exists → `"bun test"`
3. `package.json` exists and contains a `"test"` script → `"npm test"`
4. `Makefile` exists and contains a line matching `/^test:/m` → `"make test"`
5. Return `null` (skip this project)

#### `shouldRunTestHealth(projectName: string, state: TestHealthState, config: LudicsFullConfig): boolean`

```typescript
function shouldRunTestHealth(projectName, state, config): boolean {
  const nightHours: [number, number] = (config.mag?.test_health_night_hours as [number,number]) ?? [0, 6];
  const hour = new Date().getHours(); // local time
  const inNightWindow = hour >= nightHours[0] && hour < nightHours[1];
  const entry = state[projectName];
  const lastRun = entry?.lastRun ? new Date(entry.lastRun).getTime() : 0;
  const stale = Date.now() - lastRun >= 24 * 3600 * 1000;
  return inNightWindow || stale;
}
```

#### `checkProjectTestHealth(project: ProjectConfig, force?: boolean): TestHealthResult`

1. Resolve project path via `resolveProjectPath(project.name)`.
2. Determine test command: `project.test_command ?? detectTestCommand(projectPath) ?? null`. If null, return `{ skipped: true }`.
3. Read `$HARNESS/mag/test-health.json` (create if missing).
4. If `!force && !shouldRunTestHealth(...)`, return `{ skipped: true, reason: "rate-limited" }`.
5. Run command with `Bun.spawnSync(["sh", "-c", testCmd], { cwd: projectPath, timeout: 300_000 })`.
6. Record result in state file: `{ lastRun: new Date().toISOString(), passed: exitCode === 0, failures: stderrSnippet }`.
7. If not passed, call `tasksCreate(`Fix broken test suite: ${project.name}`, project.name, "A")`.
8. Return `{ passed, duration, failures? }`.

#### State file schema (`$HARNESS/mag/test-health.json`)

```json
{
  "ludics":  { "lastRun": "2026-04-07T02:20:00Z", "passed": true },
  "ocannl":  { "lastRun": "2026-04-07T02:21:00Z", "passed": false,
               "failures": "Error: src/node.ml line 42..." }
}
```

### 3. Integration into health-check handler (`src/mag.ts`)

After the existing health-check queuing logic (the `case "health-check"` block queues the Mag action; the actual handler runs inside Mag), add a programmatic call in the queue-action handler that processes `"health-check"`. Locate where the queue-action payload is dispatched (the handler that the Mag skill invokes via the queue pop path) and append:

```typescript
// Run test health check for all configured projects
const { checkProjectTestHealth } = await import("./health.ts");
const projects = config.projects ?? [];
for (const p of projects) {
  const result = await checkProjectTestHealth(p);
  if (!result.skipped) {
    console.log(`[test-health] ${p.name}: ${result.passed ? "passed" : "FAILED"}`);
  }
}
```

If the health-check queue action is handled entirely in Mag skill (not in `mag.ts`), expose a new CLI subcommand `ludics health run-tests [--project=NAME] [--force]` that the skill can call via bash.

### 4. Update `ludics-health-check.md` skill

Add a new step "Test Suite Health" between the existing queue-health and delta-detection steps:

```markdown
### Step N: Test Suite Health

Run `ludics health run-tests` (this is a no-op if not in the night window and last run < 24h ago).

For each project that ran tests:
- If passed: note in report as "✓ <project> tests passing".
- If failed: report "⚠ <project> tests FAILED — fix task auto-filed" and include the first ~10 lines of failure output.

Do NOT run tests manually; the CLI handles rate-limiting and task filing.
```

### 5. New CLI entry point `ludics health`

Add to the CLI dispatch:
```
ludics health run-tests [--project=NAME] [--force]   # run tests, file tasks on failure
ludics health test-status                              # print test-health.json summary
```

`--force` bypasses the `shouldRunTestHealth` gate (useful for manual debugging).

### Scope exclusions

- CI / remote test runs: local only.
- Flaky test handling: a single failure triggers a task; no multi-run averaging.
- Updating the task's Notes section with failure details: deferred to a follow-up; the task file title is sufficient for now.
- Timeout configurability: hard-coded 5 minutes per project is acceptable for v1.
