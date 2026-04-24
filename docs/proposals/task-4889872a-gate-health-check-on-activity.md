# Proposal: Gate health-check execution on volume of system activity

**Task:** task-4889872a
**Date:** 2026-04-24

## Goal

Skip the periodic `/ludics-health-check` when the system has been quiet since
the previous executed check. The 4h launchd cadence (`triggers.ts`, `StartInterval=14400`)
currently fires a full skill run — scanning every task file, running `ludics
slots status` / `ludics sessions report`, reading queue/test-health/health-last
JSON, and writing a new snapshot — regardless of how much actually changed.
The LLM turn cost dominates; a cheap pre-hook gate using an activity-volume
signal lets quiet intervals short-circuit entirely.

The gating signal, threshold, and bounds were chosen with the user on
2026-04-24 (captured in the task's Questions section).

## Acceptance Criteria

1. A new module `src/health-gate.ts` exports
   `shouldSkipHealthCheck(opts?: { now?: Date; stateDir?: string }): { skip: boolean; reason: string; currentLines: number; priorLines: number }`.
   - Reads `journal/events.jsonl` line count from the current state dir.
   - Reads `mag/health-last.json` for the `eventsJsonlLines` field.
   - Returns `skip: true` when `currentLines - priorLines < 50` *and*
     `priorLines` is a finite number recorded by a prior real run.
   - Returns `skip: false` on first run (missing `health-last.json`, missing
     `eventsJsonlLines` field, or non-numeric value).
   - Returns `skip: false` when `events.jsonl` is missing, empty, or unreadable
     (fail-open: prefer to run the check rather than silently stall).
   - The `reason` string is human-readable and explains the decision
     (e.g. `"delta 12 < 50 threshold"`, `"first run — no prior snapshot"`,
     `"events.jsonl missing — fail open"`).
   - The `stateDir` option exists purely for tests and defaults to `harnessDir()`.
   - The `now` option is accepted for API symmetry with other health utilities
     but may be unused by the initial implementation (the gate is time-free).
2. `resolveQueueRequestCommand` in `src/mag.ts` consults the gate when
   `action === "health-check"` and `executeProgrammatic === true`:
   - On `skip: true`: emit a `health_check_skipped` event with fields
     `{ event_type: "health_check_skipped", source: "keepalive", scope: "mag",
     message: <reason>, currentLines, priorLines, delta }`, then return `null`
     *before* calling `runAllTestHealth()` so no tests run either.
   - On `skip: false`: behave exactly as today — call `runAllTestHealth()` in
     a try/catch, then fall through to the Tier-2 skill-registry resolution
     which returns `/ludics-health-check`.
   - When `executeProgrammatic === false` (peek path from
     `mag.test.ts`), the gate is NOT consulted and the function returns the
     skill command as before.
3. The `/ludics-health-check` skill's step 10 ("Persist snapshot") writes
   `eventsJsonlLines` into `mag/health-last.json` alongside `timestamp` and
   `findings`. The count must be the line count of `events.jsonl` *at the
   start of the run* (captured before step 1 executes), not at the end, so
   that the next gate compares against what this check actually saw.
4. Regression tests, in a new `src/health-gate.test.ts`, cover:
   - (a) First run: no `mag/health-last.json` present — `skip: false`,
         `priorLines: 0` (or a documented sentinel), reason mentions "first run".
   - (b) `health-last.json` present but missing `eventsJsonlLines` field —
         `skip: false`, reason mentions missing field.
   - (c) Delta under threshold (e.g. prior 1000, current 1030 → delta 30) —
         `skip: true`.
   - (d) Delta exactly at threshold (prior 1000, current 1050 → delta 50) —
         `skip: false` (the check is `delta < 50`, so 50 runs).
   - (e) Delta over threshold (prior 1000, current 1200 → delta 200) —
         `skip: false`.
   - (f) `events.jsonl` not present or empty — `skip: false`, reason mentions
         fail-open.
   Tests must use per-test tmp dirs (see `health.test.ts` for the
   `makeTmpDir()` pattern) and pass `stateDir` explicitly.
5. A regression test in `src/mag.test.ts` (or a new `src/mag-health-gate.test.ts`)
   invokes `resolveQueueRequestCommand({ action: "health-check" }, true)` with
   a synthetic state dir configured via `LUDICS_HARNESS_DIR` and verifies the
   skip path returns `null`. The non-skip path (e.g. no prior snapshot) returns
   `"/ludics-health-check"`.
6. `bun run build` succeeds; all existing tests still pass; no new
   dependencies added.

## Context

### Where the gate goes — `resolveQueueRequestCommand` in `src/mag.ts`

The three-tier dispatch in `resolveQueueRequestCommand` is the single seam
for queue-driven skill invocation. The current Tier-1 pre-hook block already
special-cases `"health-check"`:

```ts
} else if (action === "health-check") {
  try {
    const { runAllTestHealth } = await import("./health.ts");
    runAllTestHealth();
  } catch (err) {
    console.error("ludics: test health check failed:", err);
  }
}
```

The gate attaches here. When the gate fires, this branch must return `null`
early (bypassing both `runAllTestHealth()` and the Tier-2 skill resolution
below). Placement is critical: returning `null` from `resolveQueueRequestCommand`
is already a documented "skip this request" signal — `queuePopSkill` checks
`if (!command) return null;` and the keepalive feeder treats that as "nothing
to deliver this cycle".

### Why this seam (recap from task)

- The launchd trigger path and the interactive `ludics mag health-check` CLI
  both funnel through the queue, so gating at a single point covers both.
- `runAllTestHealth()` is itself per-project rate-limited inside `health.ts`,
  so skipping it on quiet ticks is safe — the next real check still triggers
  test runs normally.
- The skill-self-bail alternative still burns an LLM turn, which is most of
  the cost we're trying to avoid.

### Gate signal — `journal/events.jsonl` line count

Every meaningful harness mutation (queue feed/drop/requeue, notify_launch,
mag_nudge, retrospective events, slot transitions, test-health runs) flows
through `emitEvent()` in `src/events.ts`, which appends a single JSONL line
to `journal/events.jsonl`. A line-count delta since the last executed health
check is therefore a direct "how much has happened" signal.

Line counting: the initial implementation reads the file and counts `\n`
occurrences. `events.jsonl` is small (the harness rotates state aggressively;
typical size is O(10k lines)). Byte-offset streaming is an optimization
explicitly deferred — the gate exists to reduce downstream LLM cost, which
dwarfs a single file read.

### Snapshot anchor — `mag/health-last.json`

The file currently contains `timestamp` and `findings`. The skill's step 10
writes it. The proposal adds a third field `eventsJsonlLines` — a number
written at the moment the skill run began (captured before step 1). This is
the comparison anchor: the next tick's gate reads this value and compares
against the *current* `events.jsonl` line count.

Capturing at the *start* of the run, not the end, is load-bearing:

- If we captured at the end, the lines the health check itself emitted
  (completion events, `mag_queue_feed`, any notifications it sent) would
  inflate the anchor and suppress the next real check's ability to see
  activity that happened *during* the current check.
- Start-of-run capture means the delta measures "activity since the point
  this check last observed the world".

### Skill mechanics — `skills/ludics-health-check.md`

Step 10 "Persist snapshot" already says "write current finding
keys/severities/timestamp to `health-last.json`". The proposal adds a
directive to also record `eventsJsonlLines` observed at step 0 (new
step or preamble). The skill author has shell access, so this is a
`wc -l < journal/events.jsonl` read captured into a variable at the
top of the run, then emitted in the JSON payload at step 10.

### Event emission — `src/events.ts`

`emitEvent()` takes `{ event_type, source, scope, message, ... }` and appends
to `events.jsonl` (or forwards via HTTP on worker machines — the gate runs
only on the controller where it writes locally, which matches how
`runAllTestHealth` already works). Fields beyond the core schema are
preserved (see `[key: string]: unknown` on `LudicsEvent`), so `currentLines`,
`priorLines`, `delta` pass through intact.

### Trigger unchanged — `src/triggers.ts`

The launchd `StartInterval=14400` (4h) stays as-is. The gate is a *filter*,
not a rescheduler. Skipping a tick leaves the next launchd fire 4h later,
and the natural accumulation of `events.jsonl` lines makes eventual
execution certain — a genuinely idle system that doesn't accumulate 50
events across *any* number of ticks doesn't need a health check.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **New module** `src/health-gate.ts`:
   - Export `HEALTH_GATE_THRESHOLD = 50` (a module-level const, overridable
     only via the test suite — no config key yet).
   - Implement `shouldSkipHealthCheck(opts?)` per Acceptance Criterion 1.
   - Use `readFileSync(eventsFile, "utf8").split("\n").length - 1` for the
     line count when the file exists and is non-empty; return `0` for
     missing/empty/unreadable (and take the fail-open branch).
   - Keep the module dependency footprint minimal — `fs`, `path`, and
     `harnessDir` from `./config.ts`.

2. **Patch `src/mag.ts`** at the `action === "health-check"` pre-hook branch:
   ```ts
   } else if (action === "health-check") {
     const { shouldSkipHealthCheck } = await import("./health-gate.ts");
     const gate = shouldSkipHealthCheck();
     if (gate.skip) {
       emitEvent({
         event_type: "health_check_skipped",
         source: "keepalive",
         scope: "mag",
         message: gate.reason,
         currentLines: gate.currentLines,
         priorLines: gate.priorLines,
         delta: gate.currentLines - gate.priorLines,
       });
       return null;
     }
     try {
       const { runAllTestHealth } = await import("./health.ts");
       runAllTestHealth();
     } catch (err) {
       console.error("ludics: test health check failed:", err);
     }
   }
   ```
   The dynamic `import()` matches the existing `runAllTestHealth` import
   style and keeps `health-gate.ts` off the hot path for non-health actions.

3. **Patch `skills/ludics-health-check.md`**:
   - Add a preamble "Step 0" (or equivalent) instructing the skill author
     to capture `EVENTS_LINES=$(wc -l < "$LUDICS_STATE_PATH/journal/events.jsonl" 2>/dev/null || echo 0)`
     at the very start.
   - Update Step 10 to emit `"eventsJsonlLines": <captured count>` alongside
     `timestamp` and `findings` in the JSON written to `mag/health-last.json`.
   - Update the Output Format example to show the new field.

4. **Tests** per Acceptance Criteria 4 and 5.

Implementation is contained: one new module, one call site change in
`mag.ts`, one skill edit, two test files. No config key, no schema
migration (new field is additive and readers tolerate missing values).

## Scope

**In scope:**

- `src/health-gate.ts` (new).
- Gate integration in `resolveQueueRequestCommand` (`src/mag.ts`).
- Skill edit to `skills/ludics-health-check.md` (capture at start, persist
  at step 10).
- Unit tests for `shouldSkipHealthCheck`.
- Integration test for the `mag.ts` skip path.
- `health_check_skipped` event emission with delta fields.

**Out of scope:**

- Any change to the launchd `StartInterval` or other triggers.
- A config key for the threshold (50 is hard-coded; user may adjust later
  if the value proves wrong).
- A skip counter, max-skip bound, min-run bound, or critical override
  (explicitly vetoed by user on 2026-04-24).
- Byte-offset streaming of `events.jsonl` (deferred; current file is small
  enough that full-file line counting is fine).
- Surfacing "N ticks skipped" in the health report (proposal judgment:
  omit — the `health_check_skipped` events are greppable via `ludics events
  --type health_check_skipped`, which is sufficient for auditability).
- Changes to `runAllTestHealth` itself.
