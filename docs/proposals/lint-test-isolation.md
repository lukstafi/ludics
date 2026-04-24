# Add `scripts/lint-test-isolation.ts` for test-harness-isolation anti-patterns

## Goal

Catch regressions of the three test-harness-isolation anti-patterns that
motivated the [gh-ludics-306](https://github.com/lukstafi/ludics/issues/306)
retrospective (reviewer's `suggestRefactorSummary` item 3). PR #349 fixed the
immediate bugs and `docs/testing-patterns.md#harness-isolation` documents the
prohibitions for humans; this lint is the machine-checkable counterpart.

Specifically, each new `src/**/*.test.ts` should be guarded against:

1. Unconditional `delete process.env.LUDICS_HARNESS_DIR` that destroys the
   `src/test-setup.ts` preload safety net for every subsequent test file in
   the same Bun process (the bug pattern from `queue.test.ts` pre-#349).
2. The `process.env.X = Y ?? undefined` coercion anti-pattern, which assigns
   the literal string `"undefined"` rather than restoring the unset state
   (the bug pattern from `events.test.ts` pre-#349).
3. Test files that transitively resolve paths via the global `harnessDir()`
   (by importing `src/config.ts`, `src/events.ts`, `src/slots/json.ts`, or
   `src/adapters/base.ts`) without either setting `LUDICS_HARNESS_DIR`
   themselves or using `withTestHarness()` (the class of bug behind
   gh-ludics-306 — `manual.test.ts` → `manual.ts` → `base.ts::adapterStateDir`).

## Acceptance Criteria

### Script structure

1. `scripts/lint-test-isolation.ts` exists and exports pure helpers plus a
   thin `runCli()` function, matching the shape of `scripts/lint-contracts.ts`
   (pure-functions + `runCli({ writeErr, writeOut })` + `if (import.meta.main)
   { process.exit(runCli().exitCode); }`).
2. `runCli()` accepts `{ srcDir?, writeErr?, writeOut? }` with sinks defaulting
   to `process.stderr.write` / `process.stdout.write`, so tests can drive it
   against temp fixtures and capture lines without a subprocess.
3. `runCli()` returns `{ exitCode, errorCount, warningCount, ... }` where
   `exitCode === 1` iff `errorCount > 0` — warnings do not fail CI (matches
   `{ errors, warnings }` tone-separation from the retrospective).
4. Paired `scripts/lint-test-isolation.test.ts` exercises each rule with
   positive and negative temp-fixture cases (see rule-by-rule criteria below).
5. `package.json` gains `"lint:test-isolation": "bun run scripts/lint-test-isolation.ts"`
   as a sibling of `lint:contracts` / `lint:config-reference`.

### Scan root & exemptions

6. The scanner walks **`src/**/*.test.ts` only**. It must skip `scripts/**`,
   `templates/**`, `src/test-setup.ts`, and `src/test-utils.ts` (the last two
   are the canonical implementation of the isolation contract; flagging them
   would be circular).

### Rule 1 — unconditional `delete process.env.LUDICS_HARNESS_DIR`

Severity: **error**.

7. **Positive (flag):** a `delete process.env.LUDICS_HARNESS_DIR;` line with
   no `if (... === undefined)` guard on the same line and no such guard on the
   previous three non-blank lines. Example that must flag:
   ```typescript
   afterEach(() => {
     delete process.env.LUDICS_HARNESS_DIR;  // unconditional — FLAG
   });
   ```
8. **Negative (pass):**
   - One-line conditional on the same line:
     `if (ORIGINAL === undefined) delete process.env.LUDICS_HARNESS_DIR;
     else process.env.LUDICS_HARNESS_DIR = ORIGINAL;`
   - Two-line braced form where the guard is within the previous 3 non-blank
     lines:
     ```typescript
     if (ORIGINAL === undefined) {
       delete process.env.LUDICS_HARNESS_DIR;
     }
     ```
   - Any guard shape where `if (` and `=== undefined` both appear within the
     same previous-3-line lookback window (identifier name is not checked —
     the lint must accept `ORIGINAL_HARNESS_DIR`, `saved`, `orig`, etc.).
   - **Any** `withTestHarness(` occurrence anywhere in the file exempts it
     from rule 1 entirely (the helper encapsulates the save-and-restore dance;
     a file using it is known-safe).

### Rule 2 — `process.env.X = Y ?? undefined` coercion

Severity: **error**.

9. **Positive (flag):** a line matching
   `process.env.[A-Z_]+ = <identifier> ?? undefined` (scoped to `process.env`
   LHS). Example that must flag:
   ```typescript
   process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR ?? undefined;
   ```
10. **Negative (pass):**
    - Conditional restore: `if (orig === undefined) delete process.env.X;
      else process.env.X = orig;` — no `?? undefined` on a `process.env` LHS.
    - Unrelated `?? undefined` outside `process.env` context (e.g.
      `const name = raw ?? undefined;`) — the regex must not fire.

### Rule 3 — imports without isolation setup

Severity: **warning** (transitive-depth / scope heuristic carries some
false-positive risk; tone matches the retrospective and Q&A item 3).

11. **Positive (warn):** a `src/**/*.test.ts` file that
    (a) imports `config.ts`, `events.ts`, `slots/json.ts`, or
    `adapters/base.ts` — directly, or one level transitively through any
    `src/` file it imports directly — **and**
    (b) does **not** contain either `process.env.LUDICS_HARNESS_DIR = ` or
    `withTestHarness(` anywhere in its source, **and**
    (c) is not on the inline rule-3 allowlist.
12. **Transitive depth:** exactly one level. The scanner opens each `src/`
    file the test imports directly and checks *its* import paths for the
    four target modules. Deeper traversal is out of scope (pragmatic
    compromise: direct-only would miss gh-ludics-306, full module-graph walk
    is over-engineering). Relative paths must be resolved so `./config`,
    `../config.ts`, `./config.ts`, etc. all match.
13. **Allowlist:** an inline `const RULE_3_ALLOWLIST = new Set<string>([...])`
    constant near the top of the module (style: `lint-config-reference.ts::
    FREEFORM_CHILDREN`). Initial entry: `src/adapters/task-launch.test.ts`
    (operates on an explicit `harnessDir: string` parameter, imports only
    `./task-launch.ts`, which does not transitively pull `config.ts` /
    `events.ts` / `slots/json.ts` / `adapters/base.ts`; genuinely safe
    without env-var setup). Graduating to a sidecar allowlist file is
    explicitly deferred.
14. **Negative (pass):**
    - A test file setting `process.env.LUDICS_HARNESS_DIR = ...` in any
      scope (lexical presence is sufficient — brace-counting the exact
      scope is out of scope per Q&A item 3's option (a)+(c)).
    - A test file calling `withTestHarness(beforeEach, afterEach)`.
    - A test file whose direct imports (and their one-level neighbours) do
      not include any of the four target modules.
    - A test file listed in `RULE_3_ALLOWLIST`.

### Output & exit code

15. Errors and warnings are written to `writeErr` (stderr by default) one
    per line with a format like
    `❌  [src/foo.test.ts:42] rule-1: unconditional delete of process.env.LUDICS_HARNESS_DIR`
    and
    `⚠️   [src/foo.test.ts] rule-3: imports config.ts via ./foo.ts without LUDICS_HARNESS_DIR setup`.
    The exact prefix / format is a style choice; distinguishability of
    errors vs warnings in the output and inclusion of the file path (plus
    line number where meaningful — rules 1 & 2) is the only requirement.
16. Success summary: on clean exit, `writeOut` emits a single line like
    `✅  No test-isolation anti-patterns detected.` (warning-count suffix
    optional, matching `lint-contracts.ts`'s style).
17. `exitCode === 1` iff `errorCount > 0`. Warnings alone yield exit 0.
18. An integration test (similar to `lint-contracts.test.ts::integration`)
    runs the script against the real repo and asserts exit 0 — this guards
    against regressions where a *new* commit introduces a violating test.

### Test coverage

19. The paired `.test.ts` must include, at minimum:
    - For rule 1: one positive case (unconditional delete), one negative
      case for each of the same-line / two-line-braced / three-line-lookback
      guard shapes, one negative case where `withTestHarness(` exempts the
      file despite an otherwise-positive shape.
    - For rule 2: one positive case, one negative case with the correct
      conditional pattern, one negative case where `?? undefined` appears
      outside `process.env` context.
    - For rule 3: one positive direct-import case, one positive one-level
      transitive case (mirroring the gh-ludics-306 bug:
      `test.ts → helper.ts → adapters/base.ts`), one negative case where
      the file sets `LUDICS_HARNESS_DIR`, one negative case where the file
      uses `withTestHarness`, one negative case where the file is on the
      allowlist, one negative case where imports simply don't reach the
      target modules.
    - `runCli` end-to-end: at least one fixture exercising mixed
      errors + warnings and asserting `exitCode === 1`, `errorCount`,
      `warningCount`, and line content.

## Context

### Current state on `origin/main`

- **`src/test-utils.ts::withTestHarness(before, after)`** — the canonical
  safe helper. Captures `process.env.LUDICS_HARNESS_DIR` at registration
  time (the comment on lines 30–33 explains the subtle double-registration
  bug this avoids). In `after` it runs the conditional delete-or-restore
  dance plus `rmSync` of the tmpdir. Any test file containing the literal
  `withTestHarness(` is, by construction, using the correct isolation
  pattern — which is why rule 1 exempts such files and rule 3 accepts
  `withTestHarness(` as one of the two valid "setup" tokens.
- **`src/test-setup.ts`** — the Bun preload (registered via `bunfig.toml
  [test] preload = ["./src/test-setup.ts"]`). Sets `LUDICS_HARNESS_DIR`
  to a process-wide tmpdir **only when unset**. This is the safety net
  that rule 1 protects: an unconditional `delete` inside one test's
  `afterEach` destroys the preload for every subsequent file in the same
  Bun process.
- **`docs/testing-patterns.md#harness-isolation`** — the human-facing
  documentation of both prohibitions and both approved patterns.

### Lint-cohort precedents

The `scripts/lint-*.ts` cohort shows a clear pattern split:

- **`scripts/lint-cli-readme.ts`** — the early, imperative style:
  top-level execution, direct `console.error` / `process.exit`, no
  exported pure helpers.
- **`scripts/lint-config-reference.ts` + `scripts/lint-config-helpers.ts`
  + `scripts/lint-config-helpers.test.ts`** — a pure-helpers-plus-thin-CLI
  pair, but the runner still writes to `console.error` / `console.log`
  directly (tests exercise only the helpers).
- **`scripts/lint-contracts.ts` + `scripts/lint-contracts.test.ts`** —
  the most recent and most testable shape: pure extractors +
  per-pair `lintPair()` + `runCli({ skillsDir?, writeErr?, writeOut? })`
  that returns `{ exitCode, errorCount, warningCount, ... }`. The test
  file drives `runCli` against `mkdtempSync`-built fixtures without
  spawning a subprocess for the unit tests, and tacks on a single
  `spawnSync`-based integration test at the end.

**Use `scripts/lint-contracts.ts` + `scripts/lint-contracts.test.ts` as
the structural template** — it maps directly onto the requirements above
(injectable sinks, `{ errors, warnings }` shape, real-repo integration
test). The task description's reference to `scripts/lint-contracts.ts` as
a template is now accurate (it was added in gh-ludics-314 after the task
was originally drafted).

### Unsafe modules (rule 3 targets)

All four resolve paths via the global `harnessDir()`:

1. **`src/config.ts::harnessDir()`** — the root resolver. Reads
   `process.env.LUDICS_HARNESS_DIR` at call time.
2. **`src/events.ts::emitEvent()`** — writes `journal/events.jsonl` under
   `harnessDir()`. Imported transitively by a large fraction of the tree.
3. **`src/slots/json.ts::readSlotJson()` / `writeSlotJson()`** — resolve
   slot state files under `harnessDir()`.
4. **`src/adapters/base.ts::adapterStateDir(name)` = `join(harnessDir(),
   name)`** — the single root cause of the gh-ludics-306 bug; `manual.ts`
   imports this function, which is why `manual.test.ts` needs isolation
   even though its direct imports don't name `config.ts`.

### Test-file inventory (for rule-3 tuning)

From a grep of `src/**/*.test.ts` for `LUDICS_HARNESS_DIR`:

- **25 files** already set `LUDICS_HARNESS_DIR` directly (conformant with
  rule 3 via the lexical setup check).
- **`src/adapters/task-launch.test.ts`** — imports only
  `./task-launch.ts`; takes `harnessDir: string` as an explicit parameter;
  does not transitively pull the four target modules. Initial rule-3
  allowlist entry.
- **`src/test-utils.test.ts`** — uses `withTestHarness()` itself; passes
  rule 3 via the setup-token check, no allowlist needed.

### Project wiring

`package.json` already has a sequence of `lint:*` sibling scripts (lines
11–15 on main). Adding `lint:test-isolation` is a one-line addition with
no chaining or CI wiring — per the task scope, standalone manual
invocation is the target.

## Approach

*Resolved via Q&A on 2026-04-24 — straightforward implementation.*

### File layout

- `scripts/lint-test-isolation.ts` — pure helpers + `runCli` (≈ 80–120 LOC).
- `scripts/lint-test-isolation.test.ts` — unit + integration tests
  (≈ 100–150 LOC).
- `package.json` — one-line addition.

Pure helpers to export for testability (suggested; the coder may pick
different boundaries provided each rule has a standalone testable
helper):

- `checkRule1(source: string): LintIssue[]` — unconditional-delete detector.
- `checkRule2(source: string): LintIssue[]` — `?? undefined` detector.
- `checkRule3(source: string, imports: string[], neighbourSources:
  Map<string, string>, allowlist: Set<string>, relPath: string): LintIssue[]`
  — transitive-import detector; receives pre-resolved neighbour sources
  so it stays pure and testable from fixtures.
- `parseImports(source: string): string[]` — line-level import-path
  extraction (regex over the top of the file is sufficient; no full TS
  parsing).
- `runCli({ srcDir?, writeErr?, writeOut? }): RunCliResult` — discovery +
  dispatch + reporting (mirror `lint-contracts.ts`'s signature).

### Rule 1 algorithm

Line-scan for `delete process.env.LUDICS_HARNESS_DIR`. For each hit:
- Reject if the **same line** contains `if (` and `=== undefined`.
- Otherwise, look back over the previous 3 non-blank lines; if those
  lines (concatenated) contain both `if (` and `=== undefined`, accept.
- Otherwise, if the *whole file* contains the literal `withTestHarness(`,
  accept (file-level exemption per AC 8).
- Else, emit `error` with `{ file, line }`.

### Rule 2 algorithm

Per-line regex `/process\.env\.[A-Z_]+\s*=\s*[A-Za-z_][\w.]*\s*\?\?\s*undefined/`.
Emit `error` per hit with `{ file, line }`. No scope or guard analysis
needed — the pattern is unambiguous.

### Rule 3 algorithm

Per test file:
- Skip if the path is in `RULE_3_ALLOWLIST`.
- Parse direct imports via `parseImports(source)` — keep only
  relative paths into `src/` (resolved to repo-relative `src/foo.ts`).
- Target check set A = those four target modules resolved to their
  repo-relative paths. If any direct import is in A, mark the file as
  "touches unsafe module".
- For each direct-import neighbour not in A, read its source once
  (memoized at the `runCli` level), parse *its* imports, and check if
  any lands in A. If so, mark the file as "touches unsafe module
  transitively".
- If marked and the file source does **not** contain
  `process.env.LUDICS_HARNESS_DIR = ` or `withTestHarness(`, emit a
  `warning` with the triggering transitive path for diagnostic context.

### Allowlist

```typescript
const RULE_3_ALLOWLIST = new Set<string>([
  "src/adapters/task-launch.test.ts",
]);
```

Paths are repo-relative with forward slashes (normalize on the platform
boundary to keep tests portable).

### `runCli` skeleton

Mirror `scripts/lint-contracts.ts::runCli` signature and return shape.
Single sweep over `src/**/*.test.ts`, aggregate per-file `errors` /
`warnings`, report via the injected sinks, compute the exit code from
`errorCount`.

### Integration test

Run the script against the real repo (via `spawnSync` like
`lint-contracts.test.ts`'s integration block) and assert exit 0. This
guarantees the lint passes the day it lands and establishes the gate
for future PRs.

## Scope

**In scope:**
- `scripts/lint-test-isolation.ts`, `scripts/lint-test-isolation.test.ts`,
  and the `lint:test-isolation` entry in `package.json`.
- Inline allowlist with the single initial entry
  `src/adapters/task-launch.test.ts`.
- One-level transitive import scanning for rule 3.

**Out of scope:**
- Running the script in CI or from a pre-commit / pre-push hook (no CI
  pipeline exists; reviewer's item 5 and the task's Notes section both
  confirm this is a separate concern).
- The opt-in `bun:test-isolated` per-file subprocess CI mode (reviewer
  item 5 — "not needed once rule 3 exists, but cheap insurance until
  then"). Revisit only if this lint proves insufficient in practice.
- Graduation of the rule-3 allowlist to a sidecar file. Deferred; the
  initial list is expected to contain ≤ 3 entries.
- Full module-graph traversal deeper than one level. Deferred; the
  gh-ludics-306 bug was exactly one level deep, and deeper traversal
  approximates a real TS resolver.
- Exact-scope detection for `process.env.LUDICS_HARNESS_DIR = ` (checking
  whether the assignment is inside `beforeEach` / `beforeAll`). Lexical
  presence is sufficient per Q&A item 3.

### Dependencies

None. Sibling task-f60547cd (AdapterContext.harnessDir audit) may tighten
the rule-3 allowlist when it lands, but this lint can merge first and be
updated incrementally.
