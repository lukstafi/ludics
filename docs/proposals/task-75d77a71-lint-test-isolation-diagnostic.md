# Improve the `lint:test-isolation` diagnostic when a new test bumps the integration pin

## Goal

When the pinned `lint:test-isolation` integration warning count mismatches its
expected value, the thrown failure message should be self-explanatory rather
than folklore. It must tell the reader **why** the count moved (a new
`*.test.ts` transitively imports a flagged module such as `src/config.ts`,
tripping rule-3), name the **remedy** (`withSyntheticHarness(beforeEach,
afterEach)` to keep the pin, or a pin-bump only for a true pure-unit file),
and **distinguish direction** — a count that went UP (new config-importing
test → use the synthetic harness, and here are the offending files) versus a
count that went DOWN (a test was removed/isolated → the pin can legitimately be
lowered). This is a messaging/diagnostic change only: neither the lint's
pass/fail logic nor the pinned value (`expectedWarningCount = 20`) changes.

## Acceptance Criteria

- [ ] When the pinned `lint:test-isolation` integration count mismatches, the
      failure message explains *why* — a test transitively imports a flagged
      module such as `src/config.ts` — and names the remediation:
      `withSyntheticHarness(beforeEach, afterEach)` from `src/test-utils.ts` to
      keep the pin, or bumping the pinned count only for a genuine pure-unit
      file.
- [ ] The diagnostic distinguishes **count went UP** (likely a new
      config-importing test that should use the synthetic harness) from
      **count went DOWN** (a test was removed or isolated — the pin can be
      lowered to the new observed value). The synthetic-harness wrap is
      recommended only on the UP branch; the DOWN branch recommends lowering
      the pin and does *not* suggest the wrap.
- [ ] The message states both numbers (old pin → new observed count) so the
      direction and magnitude of the change are explicit.
- [ ] The **UP-direction** diagnostic lists the offending test file(s) drawn
      from rule-3 attribution (`result.issues` filtered to `rule === "rule-3"`),
      so the reader is pointed straight at the `describe` blocks to wrap. When
      several files trip rule-3 in one diff, **all** of them are listed.
- [ ] No change to the lint's actual pass/fail logic, exit codes,
      `errorCount` / `warningCount` semantics, or the pinned value
      (`expectedWarningCount` stays 20). Only the thrown `Error` text (and the
      message-builder's signature) changes.
- [ ] The pre-existing CLI success-summary wording (gh-ludics-497 pinned
      string asserted in `scripts/lint-test-isolation.test.ts`) is **byte-for-byte
      unchanged** in both the `warningCount > 0` and `warningCount === 0` cases.

## Context

Auto-generated from the retrospective of `task-7c3ec5c9` (coder durable
learning). Adding a new `*.test.ts` that imports a module which transitively
pulls in a flagged target (`src/config.ts`, `src/events.ts`,
`src/slots/json.ts`, or `src/adapters/base.ts`) trips `lint:test-isolation`
rule-3 and silently bumps the pinned integration warning count (e.g. 19 → 20).
The symptom is the cryptic failure
`integration > lint-test-isolation: no errors, warning count pinned`, easily
mistaken for a real regression and caught only by the *full* `bun test`, not by
`bun test <newfile>`. The correct fix is to wrap the new `describe` with
`withSyntheticHarness(beforeEach, afterEach)` (keeping the pin); bumping the pin
is only appropriate for genuine pure-unit files. Today the remedy is folklore —
the `formatWarningCountHeuristic` message already names the wrap (shipped under
gh-ludics-497) but never states the cause and cannot indicate direction because
it only sees the observed count, not the pin.

This is the warning-count analogue of the `feedback_bun_test_discovery_drift`
memory, which documents the same misread-as-regression trap for *test* counts.

## Approach

Messaging only. The data needed is already in scope at the throw site:
`runCli` returns `RunCliResult { exitCode, errorCount, warningCount, issues }`
(`scripts/lint-test-isolation.ts`), and the integration test's `if` block holds
the pin (`expectedWarningCount`), the observed count (`result.warningCount`),
and the per-file rule-3 attribution
(`result.issues.filter(i => i.rule === "rule-3")`, each `LintIssue` carrying
`{ rule, file, message }` with the human-readable import-path message).

1. **Add a pin-aware message builder** alongside the existing
   `formatWarningCountHeuristic` in `scripts/lint-test-isolation.ts` — e.g.
   `formatPinMismatch(observed: number, expected: number, rule3Issues?: LintIssue[]): string`
   — that branches on direction:
   - **UP** (`observed > expected`): state `warning count rose {expected} → {observed}`,
     explain that a new `*.test.ts` likely transitively imports a flagged module
     (name the `RULE_3_TARGETS`: `src/config.ts`, `src/events.ts`,
     `src/slots/json.ts`, `src/adapters/base.ts`), recommend wrapping the
     offending `describe` with `withSyntheticHarness(beforeEach, afterEach)` from
     `src/test-utils.ts` to keep the pin (bump the pin only for a true
     pure-unit file), then **list every rule-3 offending file** from
     `rule3Issues` (dedup by `file`).
   - **DOWN** (`observed < expected`): state `warning count fell {expected} → {observed}`,
     explain that a test was removed or isolated, and say this is a legitimate
     lowering — update the pin to `{observed}`. Do **not** recommend the
     synthetic-harness wrap on this branch.
2. **Thread the data at the assertion site** in
   `scripts/lint-test-isolation.test.ts`: replace the
   `throw new Error(formatWarningCountHeuristic(result.warningCount))` call with
   `throw new Error(formatPinMismatch(result.warningCount, expectedWarningCount, result.issues.filter(i => i.rule === "rule-3")))`.
3. **Leave the two pinned things untouched:**
   - `expectedWarningCount = 20` — the pin value does not change.
   - The gh-ludics-497 CLI success-summary path
     (`✅  No test-isolation anti-patterns detected …`) still calls
     `formatWarningCountHeuristic(warningCount)` (count-only, no pin context);
     keep `formatWarningCountHeuristic` and its output string exactly as-is so
     the verbatim-string assertions in `scripts/lint-test-isolation.test.ts`
     (both the `warningCount > 0` positive case and the `warningCount === 0`
     byte-identical negative case) continue to pass without modification.
4. **Add unit coverage** for the new builder: an UP case (asserts direction
   wording, the synthetic-harness remedy, and that all supplied rule-3 files are
   listed) and a DOWN case (asserts the lowering recommendation and the
   *absence* of the synthetic-harness wrap). The builder is pure given counts +
   issue list, so this needs no fixture/CLI plumbing.

### Notes

- The success-summary path has no pin to compare against, so it must keep using
  the count-only heuristic — do not route it through `formatPinMismatch`.
- Equal counts never reach the throw (guarded by `!==`), so only the UP and
  DOWN branches of `formatPinMismatch` are reachable in practice.
- If `withSyntheticHarness` is ever renamed in `src/test-utils.ts`, the
  gh-ludics-497 contract already requires updating the remedy string in the same
  PR; the new UP-branch wording is bound by the same convention.
