# Lint: `test("exits …")`-named tests must spawn the CLI in their describe block

## Goal

Mechanize the trip-wire grep from `feedback_cli_exit_code_needs_spawn.md`
(originally captured from gh-ludics-439; second occurrence flagged in the
PR #518 / task-9329e350 retrospective) as an automated CI lint.

When a `*.test.ts` file under `scripts/` declares
`test("exits 0|1|N|non-zero …", …)` inside a `describe(…)` block, that test
is asserting on a CLI surface contract (exit code, stderr/stdout shape,
remediation prompt). A correct test for that contract must spawn the actual
CLI binary via `Bun.spawnSync` / `Bun.spawn` / `Bun.$` / `execFileSync` /
`execSync` / a standalone `spawnSync` / `spawn`. An in-process resolver
assertion (`runLint(...)`, `lintCorpus(...)`, etc.) inside such a test is
the gh-ludics-439 / PR #518 anti-pattern: the test name promises CLI-level
coverage but the body only exercises the pure-function surface, missing
`process.exit(…)` wiring, output-shape regressions, and remediation-prompt
edits.

This class has now rotted twice across two coders despite a documented
coder memory (`feedback_cli_exit_code_needs_spawn.md`) with a second-
occurrence note (2026-05-10). Per the competent-SWE filter, hygiene catches
usually stay with the reviewer — but a memory-only catch-net that has
failed twice in a year is structurally inadequate. This task ships the
mechanical sibling of `lint:skill-shell` (PR #518) / `lint:skill-cli-refs`
for the test-coverage discipline.

## Acceptance Criteria

- [ ] `scripts/lint-test-spawn-coverage.ts` exists and exits non-zero when
      any in-scope `*.test.ts` file contains a `test("exits 0|1|N|non-zero
      …", …)` or `it("exits 0|1|N|non-zero …", …)` row whose enclosing
      `describe(…)` body does not contain at least one spawn call from the
      allowlist (see below), and the row is not preceded by a
      `// lint:allow-no-spawn` pragma line.
- [ ] In-scope file set is exactly `scripts/*.test.ts` (Q1). Files under
      `src/**`, `templates/**`, or any other path are out of scope. The
      glob is a single in-file literal (no parallel re-export); the
      `IN_SCOPE_GLOBS` constant is exported from the new lint module so
      tests can re-assert the glob without duplicating the literal.
- [ ] Trigger recognizer is `(?:test|it)\s*\(\s*"exits\s+(?:0|1|\d+|non-zero)\b`
      (Q2 + Q4). Test names starting with `exits after …` / `exits early
      …` / `exits when …` (no leading number / non-zero literal) do NOT
      fire. The synonym shapes `test("returns exit 0 …")`,
      `test("returns exitCode 0 …")`, `test("fails CI when …")` and
      similar are intentionally NOT flagged — the lint stays narrow; the
      user renames their tests for hits to land.
- [ ] Spawn-call recognizer matches any of, in a single anchored
      expression: `Bun\.spawn(?:Sync)?\(` (both sync and async Bun forms),
      `Bun\.\$`, `execFileSync\s*\(`, `execSync\s*\(`,
      `\bspawnSync\s*\(`, `\bspawn\s*\(` (Node-style standalone; the
      `\b` boundary keeps `Bun.spawn(` from being double-counted under
      both anchors but accepts an imported `spawnSync` / `spawn` from
      `child_process`). Q3 allowlist.
- [ ] `describe(…)` body scoping (Q4): a trigger fires only if its
      **nearest enclosing** `describe(…)` block body contains no spawn
      call from the allowlist. Ancestor `describe(…)` bodies count toward
      coverage (a spawn-once-assert-many idiom with nested describes is
      not flagged). Top-level `test(…)` rows with no enclosing `describe`
      use the file body as their "describe body".
- [ ] Pragma escape hatch (Q5): a line-comment `// lint:allow-no-spawn`
      that appears on the line **immediately above** a trigger row
      (allowing intervening blank lines but no other code) suppresses the
      lint for that one trigger only. The pragma scope is "skip the
      immediately-following `test(/it(` call"; a single pragma above a
      multi-line `test.each` or a block of tests does NOT suppress
      subsequent rows.
- [ ] `scripts/lint-no-shadow-util.test.ts` lines 198 (`test("exits 0 on
      a clean tree (only util.ts defines the helpers)")`) and 233
      (`test("exits 1 with path:line on a planted shadow")`) each receive
      a `// lint:allow-no-spawn` pragma applied as part of this PR.
      Rationale: that file uses an injectable-IO `runCli({ writeErr,
      writeOut, ... })` pattern that intentionally exercises the
      assignable CLI surface without spawning. The pattern differs from
      gh-ludics-439's "assert-on-resolver" anti-pattern (it asserts on
      `result.exitCode` from a function that returns the same exit-code
      shape the CLI tail would `process.exit(…)` on). The lint should
      remain green on `main` after this PR; the pragma is the
      sanctioned way to opt out.
- [ ] Output shape mirrors `lint-skill-cli-refs.ts` / `lint-skill-shell.ts`:
      on success, stdout prints `✅  All N exits-named tests in M
      scripts/*.test.ts files spawn the CLI in their describe block.` and
      exits 0. On violation, stderr prints `❌  K test("exits …")
      row{s} do not spawn the CLI in their describe block:` followed by
      one `file:line test("…")` row per violation, followed by a brief
      remediation prompt naming the three fixes (rewrite to spawn via
      `Bun.spawnSync` and assert on `proc.exitCode` / `proc.stderr` /
      `proc.stdout`; rename the test if it is genuinely asserting on an
      in-process function's exit-code-shaped return; add `// lint:allow-
      no-spawn` if the in-process pattern is intentional and the test
      name's CLI promise has been re-read), and exits 1.
- [ ] `scripts/lint-test-spawn-coverage.test.ts` exercises the lint with
      at least these cases:
      - **Positive — flagged**: a synthetic file containing `describe("CLI
        exit code", () => { test("exits 1 when foo", () => {
        const result = runLint(...); expect(result.exitCode).toBe(1); });
        })` flags exactly one violation, with the correct `file:line`
        and the test-name literal in the row.
      - **Positive — flagged for `it`**: same shape but `it("exits 0 …")`
        instead of `test(...)`, flags one violation (Q4 alias).
      - **Negative — describe contains `Bun.spawnSync`**: the round-2 PR
        #518 shape (`test("exits 1 when …", () => { const proc =
        Bun.spawnSync({...}); expect(proc.exitCode).toBe(1); })` inside a
        `describe("CLI exit code", …)` block) does not flag.
      - **Negative — describe contains `Bun.$`**: a fixture using
        `Bun.$` instead of `Bun.spawnSync` does not flag.
      - **Negative — describe contains `Bun.spawn(` (async form)**: a
        fixture using `const proc = Bun.spawn({...}); await proc.exited`
        does not flag (Q3 sync+async coverage).
      - **Negative — describe contains `execFileSync` from
        `child_process`**: does not flag.
      - **Negative — describe contains standalone `spawnSync` from
        `child_process`** (no `Bun.` prefix): does not flag (current
        corpus pattern in `lint-no-nul-bytes.test.ts` /
        `lint-no-mock-module.test.ts`).
      - **Negative — `test.each([...])("exits 1 when …", …)`**: not
        flagged (current recognizer does not anchor on `test.each`; this
        is intentional v1 scope).
      - **Negative — trigger excludes `exits after …` / `exits early …`**
        (Q2 tightening): a synthetic `test("exits after grace window when
        tmux sibling state is missing", () => { ... })` does NOT fire,
        even with zero spawns in the enclosing describe — proves the
        `src/orchestration/runner.lifecycle.test.ts` collision class is
        avoided structurally.
      - **Negative — trigger excludes `returns exit 0` synonym**: a
        synthetic `test("returns exit 0 against an empty fixture", () =>
        { ... })` does NOT fire even with zero spawns. Documents the
        narrow-scope decision.
      - **Negative — pragma suppresses immediately-following row**: a
        synthetic file with `// lint:allow-no-spawn` immediately above
        `test("exits 1 when ...", ...)` (no spawns in the describe) does
        NOT flag.
      - **Positive — pragma does NOT suppress a non-immediately-following
        row**: a synthetic file with `// lint:allow-no-spawn` followed by
        `test("exits 1 ...", ...)` THEN `test("exits 0 ...", ...)` — the
        first is suppressed, the second still flags.
      - **Negative — nested describes (ancestor spawn)**: a fixture
        `describe("outer", () => { const proc = Bun.spawnSync(...);
        describe("inner", () => { test("exits 1 ...", ...) }) })` does
        NOT flag — ancestor describe's spawn counts.
      - **Negative — top-level test with file-body spawn**: a fixture
        with `Bun.spawnSync(...)` at file scope (outside any describe) and
        a top-level `test("exits 1 ...", ...)` does NOT flag — file body
        is the implicit describe body for top-level test rows.
      - **Live-corpus smoke**: `lintCorpus(collectInScopeFiles(root), ...)
        ` against the live `scripts/*.test.ts` set after the pragma
        applications mandated above yields exactly zero violations. If a
        future test under `scripts/` introduces an unwrapped `test("exits
        N …")` without spawn or pragma, this assertion fires.
      - **Floor-count meta-test** (SILENT-DRIFT guard, sibling to
        `lint-skill-cli-refs.test.ts`'s pattern): the number of `test|it
        ("exits 0|1|\d+|non-zero …")` rows in the live `scripts/*.test.ts`
        set is at least the count observed at implementation time (≥ 30
        rows across ≥ 10 files — verified count via the lint's own
        `findTriggers` recognizer at HEAD `6b2121a`: 31 trigger rows in
        10 files; the proposal-time estimate of 35 / 12 was an
        unverified agent count). If a future refactor drops the trigger
        recognizer to zero matches, this assertion fires.
- [ ] `scripts/lint-test-spawn-coverage.test.ts` itself complies with the
      lint's own contract: its `describe("CLI exit code", …)` block (or
      equivalent) MUST contain `Bun.spawnSync` and assert on `proc.exitCode`
      / `proc.stdout` / `proc.stderr`. The self-test is also a smoke-test
      that the lint family's discipline applies recursively. **Failure-path
      tamper test required**: inside a `try { writeFileSync(target,
      tampered); … } finally { writeFileSync(target, original); }` block,
      mutate one of the lint's own assertions or an in-scope test file to
      introduce a violation, spawn the CLI, and assert `proc.exitCode ===
      1` plus the AC stderr substrings — `❌`, the violating
      `file:line`, the test-name literal, and at least one of the three
      remediation phrases.
- [ ] `package.json` declares `"lint:test-spawn-coverage": "bun run
      scripts/lint-test-spawn-coverage.ts"`, placed adjacent to the
      existing `"lint:skill-shell"` and `"lint:skill-cli-refs"` entries.
- [ ] `.github/workflows/ci.yml` adds a step named `Lint — test spawn
      coverage` running `bun run lint:test-spawn-coverage`, placed
      alongside the existing `Lint skill body shell variables` /
      `Lint skill body CLI references` steps under the same `build` job.
- [ ] Running `bun run lint:test-spawn-coverage` against the current
      `main` corpus (post-PR, with the two pragma applications above)
      exits 0 with the `✅` summary line. Verifiable with the concrete
      command `cd /Users/lukstafi/ludics && git checkout <merge-sha> &&
      bun run lint:test-spawn-coverage` (or in CI: the new step is green
      on the merge commit).

## Context

Sibling-shape models (verified on current `main`, HEAD `6b2121a`,
2026-05-10):

- `scripts/lint-skill-cli-refs.ts` + `scripts/lint-skill-cli-refs.test.ts` —
  the canonical sibling for output shape, `IN_SCOPE_GLOBS` /
  `collectInScopeFiles` export pattern, `import.meta.main` CLI tail
  printing `✅` on success / `❌` on failure with a remediation prompt.
- `scripts/lint-skill-shell.ts` + `scripts/lint-skill-shell.test.ts` (PR
  #518, the most recent sibling). The test file's `describe("CLI exit
  code", …)` block at the bottom is the canonical **failure-path
  tamper-and-restore harness template**:
  ```ts
  const target = join(root, "templates", "harness", "CLAUDE.md");
  const original = readFileSync(target, "utf-8");
  try {
    writeFileSync(target, tampered);
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("❌");
    // … per-violation row shape and remediation-prompt assertions
  } finally {
    writeFileSync(target, original);
  }
  ```
  The new lint's failure-path test follows this exact shape.
- `scripts/lint-cli-subcommands.ts` exports `extractNamedBody(source: string,
  name: string, open: "{" | "[" = "{")` (verified, file:line `lint-cli-
  subcommands.ts` definition at the function declaration starting around
  the comment block "Locate the body of a named function declaration …").
  The function walks balanced delimiters with a depth counter. The new
  lint's describe-body walk can either reuse `extractNamedBody` for the
  describe arrow body OR use a sibling-pattern duplicate that anchors on
  `describe(…) => {` specifically (since `extractNamedBody` anchors on
  named function / const declarations, not `describe(…)` callsites). The
  agent picks; both shapes are acceptable. If duplicating, it stays in
  the same file (no util.ts shadow per `lint:no-shadow-util`).
- `feedback_cli_exit_code_needs_spawn.md` lives in coder memory at
  `~/.claude/projects/-Users-lukstafi-ludics/memory/feedback_cli_exit_
  code_needs_spawn.md` (verified present 2026-05-10, with the 2026-05-10
  second-occurrence note and the specific trip-wire grep recipe). This
  proposal mechanizes the grep recipe.

Existing exit-shape test inventory (verified on HEAD `6b2121a` via the
lint's own `findTriggers` recognizer): 31 trigger-matching rows across
10 `scripts/*.test.ts` files. All currently comply with the spawn
requirement except for the two `describe("runCli", …)` rows in
`scripts/lint-no-shadow-util.test.ts` (lines 198, 233) which use the
injectable-IO `runCli({ writeErr, writeOut, … })` pattern. Those two
rows receive `// lint:allow-no-spawn` pragmas as part of this PR (per
the AC above). (The proposal-draft text originally cited "35 / 12";
that count was an unverified agent estimate corrected here against the
recognizer's actual output.)

The runner.lifecycle false-positive class is structurally avoided by Q1
(in-scope: `scripts/*.test.ts` only — `src/orchestration/runner.lifecycle.
test.ts` is not scanned) AND by Q2's tightened trigger (`exits 0|1|\d+
|non-zero` only — `exits after grace window` / `exits early when …` do
not match). Two independent defenses; either alone would suffice. The
combination buys forward-safety against `scripts/` test names drifting in
either direction.

The `// lint:allow-no-spawn` pragma is the residual escape hatch (Q5).
Sanctioned use cases: (a) injectable-IO patterns like
`lint-no-shadow-util.test.ts`'s `runCli` (the assertable surface is by
construction exit-code-shaped, no `process.exit` wiring is at issue), and
(b) tests whose name accidentally matches the trigger pattern but whose
contract genuinely is in-process (rename is preferred but pragma is
allowed). Pragma scope is one immediately-following trigger row; this
keeps drift between the pragma and what it's silencing visually obvious
in code review.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Create `scripts/lint-test-spawn-coverage.ts` exporting `IN_SCOPE_GLOBS`
   (`["scripts/*.test.ts"]`), `collectInScopeFiles(root)`, a per-file
   `lintFile(filePath, source)` returning `Violation[]`, and a
   `lintCorpus(files, readSource)` aggregator. Define `Violation` as
   `{ readonly file: string; readonly line: number; readonly testName: string }`.
2. In `lintFile`:
   a. Find every trigger row using the recognizer regex `(?:test|it)\s*\(\s*"exits\s+(?:0|1|\d+|non-zero)\b[^"]*"` (capture the full quoted name for the violation snippet).
   b. For each trigger row, check the immediately-preceding non-blank source line for `// lint:allow-no-spawn`. If present, skip the row.
   c. For each non-pragma'd trigger row, locate the nearest enclosing `describe\s*\(` callsite by walking backward through the source while tracking balanced `{` / `}` and `(` / `)` to find an unclosed `describe(` whose body contains the trigger row. Once found, extract the body (via `extractNamedBody`-style balanced-brace walk on the arrow body, OR via `lint-cli-subcommands.ts`'s `extractNamedBody` helper if applicable; agent's call). If no enclosing `describe` is found, the body is the file source.
   d. Scan the body for any allowlist match: `Bun\.spawn(?:Sync)?\(`, `Bun\.\$`, `execFileSync\s*\(`, `execSync\s*\(`, `\bspawnSync\s*\(`, `\bspawn\s*\(`. If none match, emit a violation.
3. Print aggregated violations in the `lint-skill-shell.ts` output shape
   (✅ / ❌ + per-violation row + remediation prompt) and exit 1 on any
   violation.
4. Add `scripts/lint-test-spawn-coverage.test.ts` covering the case
   matrix in the AC above. Include the failure-path tamper-and-restore
   harness (the lint's own test must spawn the CLI, otherwise it fails
   its own check — the right invariant).
5. Apply `// lint:allow-no-spawn` pragmas to lines 198 and 233 of
   `scripts/lint-no-shadow-util.test.ts` (immediately above each `test(...)`
   row).
6. Wire `package.json` and `.github/workflows/ci.yml` as siblings to the
   existing `lint:skill-shell` entries.
7. Before submitting, run `bun run lint:test-spawn-coverage` locally and
   confirm `✅` and exit 0; run `bun test scripts/lint-test-spawn-coverage.
   test.ts` and confirm green.

Regex-over-source is the right tool here (no AST); siblings all do the
same. The describe-body walk needs balanced-delimiter care (count `{` /
`}` and `(` / `)` depth) — `lint-cli-subcommands.ts`'s `extractNamedBody`
handles balanced-brace walking but anchors on named function / const
declarations rather than `describe(` callsites; the new lint either
extends that helper to take a custom anchor regex or duplicates the
walking logic inline (preferred if the helper would grow many anchor-
shape branches).

Test-helper indirection (a future test that hides the spawn behind a
helper imported from another file) is the false-positive case the pragma
addresses; per-file body scanning suffices for v1. Cross-file analysis
is explicitly out of scope.

## Scope

In scope:
- New file `scripts/lint-test-spawn-coverage.ts`.
- New file `scripts/lint-test-spawn-coverage.test.ts`.
- Edit `package.json` to add `"lint:test-spawn-coverage"` entry.
- Edit `.github/workflows/ci.yml` to add a `Lint — test spawn coverage`
  step.
- Edit `scripts/lint-no-shadow-util.test.ts` to add `// lint:allow-no-spawn`
  pragmas at lines 198 and 233 (immediately above each `test("exits …")`
  row). This is the one file that requires a pragma to keep the lint
  green on `main` after the PR.

Out of scope:
- Any other edits under `scripts/` (the existing 33 trigger rows across
  11 other files already comply with the spawn requirement post-PR-#518).
- All paths under `src/**`, `templates/**`, `docs/**` (Q1 boundary).
- `test.each([...])("exits …", …)` recognition (currently unused; v2 if
  the corpus drifts).
- Cross-file spawn-helper resolution (handled by pragma in v1).
- Renaming `lint-no-shadow-util.test.ts`'s `test("exits …")` rows to
  `test("returns exit-code …")` (the rename would also avoid the lint
  hit, but the pragma is the lower-cost choice for an established
  injectable-IO pattern).

Dependencies: none. Relates to (does not block / is not blocked by)
task-9329e350 (PR #518, the second-occurrence trigger) and gh-ludics-439
(the originating retrospective).
