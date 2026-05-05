# `lint:test-isolation` heuristic in failure surfaces (+ two textbook entries)

## Goal

Improve `lint:test-isolation`'s failure-message ergonomics so the coder
sees the two-fix heuristic exactly when the lint trips, no doctrine
required. Today the failure surface that breaks CI is the integration
test in `scripts/lint-test-isolation.test.ts`
(`expect(result.warningCount).toBe(20)`) — bun's matcher output prints
only the numeric mismatch, not the surrounding comment, so the coder
must navigate to the test file to discover that the two fixes are
either *wrap with `withSyntheticHarness(beforeEach, afterEach)` from
`src/test-utils.ts`* (preferred — actually isolates) or *bump the pin*
(only for pure-unit tests with no harness needs).

The fix is a single short heuristic string, defined once in the lint
script and surfaced at two places: (1) the CLI summary line in
`scripts/lint-test-isolation.ts` when warnings are present, and (2) a
guarded throw immediately before the `toBe` assertion in
`scripts/lint-test-isolation.test.ts`. The same idiom applies
symmetrically to the sibling pinned-warning lint
`scripts/lint-contracts.test.ts` with its own heuristic for its own
failure mode.

In the same PR, capture two filtered-out doctrine reminders into
`docs/swe-textbook.md` so future Mag/feedback-digest filter decisions
have written precedent. Mirrors the precedent set by
[`docs/proposals/gh-ludics-496-adapter-call-site-lint.md`](./gh-ludics-496-adapter-call-site-lint.md)
(landed on `main` 2026-05-05, commit `7b3980f`), which uses the same
"deliverable + two textbook entries" shape.

Tracks GitHub issue [#497](https://github.com/lukstafi/ludics/issues/497).
Precipitating retro: `task-a670cdbf` round-2 reviewer
([PR #493](https://github.com/lukstafi/ludics/pull/493)); aggregated
via `/ludics-feedback-digest` 2026-05-04.

## Acceptance Criteria

1. **Heuristic constant defined once and exported.** A single named
   constant in `scripts/lint-test-isolation.ts` (suggested name:
   `WARNING_COUNT_HEURISTIC`) holds the heuristic string. The string
   uses `${N}` (or equivalent template-literal substitution) for the
   warning count and reads, verbatim modulo the `N` placeholder:

   > `(N warnings — to silence a new test: wrap with withSyntheticHarness(beforeEach, afterEach) from src/test-utils.ts (preferred — actually isolates the harness env), OR bump the pinned count in scripts/lint-test-isolation.test.ts (only for pure-unit tests with no harness needs).`

   No second copy of the string body lives anywhere else in the repo;
   `scripts/lint-test-isolation.test.ts` imports the constant (or a
   small formatter wrapping it) from `scripts/lint-test-isolation.ts`
   rather than restating the heuristic. Verifier:
   `git grep -F "wrap with withSyntheticHarness(beforeEach, afterEach) from src/test-utils.ts"`
   on the merged tree returns hits only in (a) the constant definition
   in `scripts/lint-test-isolation.ts` and (b) any test cases that
   exercise the message — no copy-paste literal in
   `scripts/lint-test-isolation.test.ts` itself.

2. **CLI summary appends heuristic when `warningCount > 0`, prefix
   preserved.** In `scripts/lint-test-isolation.ts`, when `errorCount
   === 0` and `warningCount > 0`, the `writeOut` summary line
   continues to start with the literal prefix
   `✅  No test-isolation anti-patterns detected` (so any existing
   downstream success-grep keeps matching) and is followed by the
   heuristic substituted with the live `warningCount`. The
   `warningCount === 0` summary remains unchanged
   (`✅  No test-isolation anti-patterns detected.`). Verifier (positive):
   a unit test in `scripts/lint-test-isolation.test.ts` invokes
   `runCli` with a writeOut spy against a fixture that produces
   `warningCount > 0` and asserts the captured output contains both
   the literal prefix and the verbatim heuristic body. Verifier
   (negative): the same test against a zero-warning fixture asserts
   the output does *not* contain the heuristic body.

3. **Integration-test guarded throw before the `toBe` assertion.** In
   `scripts/lint-test-isolation.test.ts`, the `describe("integration",
   …)` block's `expect(result.warningCount).toBe(20)` (or whatever
   pin is current at merge time) is immediately preceded by:

   ```ts
   if (result.warningCount !== EXPECTED) {
     throw new Error(<heuristic with substituted N>);
   }
   ```

   where `EXPECTED` is the same numeric literal passed to `toBe`. The
   `expect(...).toBe(EXPECTED)` line is retained for tooling that
   walks `expect` calls. The thrown `Error.message` body matches the
   heuristic body verbatim (modulo the `N` placeholder substitution).
   Verifier: `git grep -F "wrap with withSyntheticHarness(beforeEach, afterEach) from src/test-utils.ts"`
   returns at least one hit in `scripts/lint-test-isolation.test.ts`
   (the throw site, via the imported constant), confirming the
   heuristic reaches this surface without literal duplication.

4. **Sibling lint coverage with own heuristic.** The
   `describe("integration", …)` block in
   `scripts/lint-contracts.test.ts` (currently
   `expect(result.warningCount).toBe(0)`) gains the same guarded-throw
   shape immediately before the `toBe` assertion. The sibling's
   heuristic message is **distinct** from the test-isolation
   heuristic: it points at the contracts-lint failure mode (a fresh
   skill pair introduced a worker/orchestrator field-contract drift,
   or a matcher improvement found new real-world hits) — not at
   `withSyntheticHarness`. The contracts heuristic constant is
   defined in `scripts/lint-contracts.ts` and exported for the test
   to import (mirroring AC1's DRY pattern), with body suggested by the
   existing comment lines above the assertion (lines 519–525:
   "either a new skill pair introduced a worker/orchestrator
   field-contract drift (regression — fix the pair) OR a matcher
   improvement found new real-world hits (coverage upgrade — justify
   and update the count)"). The exact wording is a plan-phase choice;
   the only invariant is that the contracts heuristic does **not**
   contain the substring `withSyntheticHarness` — verifier:
   `git grep -F "withSyntheticHarness" -- scripts/lint-contracts.ts scripts/lint-contracts.test.ts`
   on the merged tree returns no hits.

5. **Two textbook entries appended via Capture Idempotency.** Two new
   `### <headline>` sections are appended to `docs/swe-textbook.md`
   with the four labelled fields (`Description:`,
   `Precipitating retro:`, `Filter decision:`, optional
   `Second occurrence:`) per the entry-shape contract. Both cite
   `task-a670cdbf` round-2 review (PR #493) and the 2026-05-04
   feedback-digest filing as the precipitating retro:

   - **Entry C — Named-lint editorial inconsistency.** Headline:
     `### Cherry-picking one named lint into pair-coder-work.md is editorially inconsistent`.
     Description body captures: "Named-lint enumeration in
     `pair-coder-work.md` is editorially inconsistent unless you name
     **all** repo-wide gates; cherry-picking one
     (`lint:test-isolation`) advertises it as special. The competent-
     SWE filter applies — the other lints (`bun run lint`,
     `bun run typecheck`, `bun run lint:contracts`, etc.) are not
     enumerated either."

   - **Entry D — Pre-commit hook infrastructure must be verified.**
     Headline: `### "Optional pre-commit hook" feedback-digest items must verify the infra exists`.
     Description body captures: "Feedback-digest items proposing
     optional pre-commit hook integration if a Husky setup exists
     should verify the infrastructure is present before treating as
     in-scope. Introducing Husky is a separate decision affecting
     every commit on every machine; not a workflow-feedback fix."

   Both entries match the concise sentence-fragment idiom of the seed
   entry (`### "Issue is updated" means an actual GH-side comment, not a one-way docs cite`).

   **Capture Idempotency satisfied.** Before appending each entry,
   run the `docs/swe-textbook.md#capture-idempotency` short-circuit
   (`grep -F "### <ENTRY_HEADLINE>"` *and*
   `grep -F "<PRECIPITATING_RETRO>"`); both must miss. If a near-
   duplicate exists, fall back to a `Second occurrence:` amendment
   instead.

6. **GH issue closed via comment.** Issue #497 receives a comment
   linking the merged PR plus both textbook entry anchor IDs (the
   slugged forms of Entry C and Entry D headlines — verify the
   literal slugger output before pinning, per
   `feedback_github_md_slugger`: GitHub's slugger drops `/`, removes
   punctuation, and collapses em-dash spaces to `--`), then is closed
   via `gh issue close` or via the GH-issue auto-sync triggered by
   task status (per `feedback_gh_issue_auto_sync`). A docs-side cite
   alone does not satisfy this AC, per the `gh-ocannl-270` seed-
   entry lesson.

7. **Scope invariant — no agent-loaded surfaces touched.** In
   `git diff --name-only main...HEAD`, no path matches any of:
   `src/coder/**`, `src/reviewer/**`, `src/orchestration/**`,
   `skills/orchestration/pair-coder-*.md`,
   `skills/orchestration/pair-reviewer-*.md`,
   `skills/worker-conventions.md`,
   `skills/ludics-draft-proposal-worker.md`. Phrased as a (b)-form
   invariant per
   [`docs/ac-rigor-reference.md#proposal-path-enumeration-goes-stale-when-proposal-commits-to-main-first--anchor-to-scope-invariant`](../ac-rigor-reference.md)
   so the AC survives a proposal-commit-on-main merge-base advance
   between proposal landing and implementation forking.

8. **Negative control on always-loaded skill content.** The PR adds
   no `consult docs/swe-textbook.md` (or `see textbook` / `see SWE
   textbook` / `swe-textbook.md`) pointer in any skill loaded by
   coder or reviewer agents (the file set in AC7). Verifier: AC7
   already enforces no diff under those paths, AND
   `git grep -F "swe-textbook" -- skills/orchestration/pair-coder-*.md skills/orchestration/pair-reviewer-*.md skills/worker-conventions.md skills/ludics-draft-proposal-worker.md`
   on the merged tree returns no hits.

9. **No Husky / `lint-staged` introduction.** The PR does not create
   `.husky/`, does not add a `husky` or `lint-staged` key to
   `package.json`, and does not modify `.git/hooks/`. Verifier:
   `git diff --name-only main...HEAD` includes no `.husky/**` paths,
   `git diff main...HEAD -- package.json` shows no addition of a
   `"husky"` or `"lint-staged"` top-level key. The dropped action (3)
   is captured as Entry D in AC5 instead.

10. **Skills and worker-conventions untouched.** Restating AC7 from
    the perspective of the dropped action (1): no diff in
    `skills/orchestration/pair-coder-work.md`, no diff in
    `skills/worker-conventions.md`, and no enumeration of
    `lint:test-isolation` (or any other named lint) is added to those
    files in this PR. The dropped action (1) is captured as Entry C
    in AC5 instead. Verifier: `git diff main...HEAD -- skills/`
    returns the empty diff (this is implied by AC7 but kept distinct
    here so the named-lint-enumeration constraint reads as a positive
    AC rather than only as a side-effect of the agent-surface scope
    invariant).

## Context

### Precipitating failure mode

Adding any new `.test.ts` that transitively imports `src/config.ts`,
`src/events.ts`, `src/slots/json.ts`, or `src/adapters/base.ts` flips
the pinned `result.warningCount` in
`scripts/lint-test-isolation.test.ts` from 20 → 21 and breaks
`bun test`. There are two valid fixes — wrap with
`withSyntheticHarness` (preferred, actually isolates the harness
env) or bump the pin (acceptable only for pure-unit tests with no
harness needs) — but bun's matcher output prints only the numeric
mismatch. The fix heuristic lives in a code comment *above* the
assertion (lines 809–812 of `scripts/lint-test-isolation.test.ts`),
which the coder has to navigate to and read manually. The substantive
ergonomic shift is to surface the heuristic in the failure message
itself.

User direction (2026-05-05) confirmed action (2c) — both CLI summary
*and* integration-test guarded throw — and dropped actions (1)
(named-lint enumeration in `pair-coder-work.md`) and (3) (Husky pre-
commit hook), with both dropped items captured as `docs/swe-textbook.md`
entries via the same pattern as
[`gh-ludics-496-adapter-call-site-lint.md`](./gh-ludics-496-adapter-call-site-lint.md).

### Adjacent infrastructure (just-shipped)

- **`docs/swe-textbook.md`** — PR #499 (`task-c4e0e80a`, merged
  2026-05-05) introduced this file as Mag-side write memory for
  filter-rejected retro learnings. The seed entry covers the
  `gh-ocannl-270` AC6 lesson. The capture-textbook disposition is
  wired into `skills/ludics-process-suggestions.md` and
  `skills/ludics-feedback-digest{,-worker}.md` via the same PR.
  Capture Idempotency lives at
  `docs/swe-textbook.md#capture-idempotency`.

- **`docs/ac-rigor-reference.md`** — PR #498 (`task-097cca67`, merged
  2026-05-05) added the **Proposal-path enumeration goes stale when
  proposal commits to main first** clause under the Verification-
  evidence family. AC7 above adopts that clause's (b)-form invariant
  phrasing.

- **`docs/proposals/gh-ludics-496-adapter-call-site-lint.md`** —
  parallel proposal landed on `main` 2026-05-05 (commit `7b3980f`)
  with the same shape (deliverable + two textbook entries). This
  proposal mirrors its AC structure for ACs 5–8 and its scope-
  invariant phrasing for AC7.

### Code pointers

- `scripts/lint-test-isolation.ts` — `runCli` returns
  `{ exitCode, errorCount, warningCount, issues }`. The success
  branch (`if (errorCount === 0)`) builds the suffix as
  `(N warning|warnings)` and emits
  ``✅  No test-isolation anti-patterns detected${suffix}.`` via
  `writeOut`. The new constant `WARNING_COUNT_HEURISTIC` defines once
  and is concatenated into this summary path (warnings present
  branch only). `RULE_3_TARGETS` and `hasIsolationSetup` are the
  source-of-truth for which test-utils helpers are recognised — the
  heuristic message names the helper `withSyntheticHarness` literally,
  so a future rename of that helper would need to update both
  `RULE_3_TARGETS`/`hasIsolationSetup` and `WARNING_COUNT_HEURISTIC`
  in the same PR (same-file co-location keeps drift-risk low).

- `scripts/lint-test-isolation.test.ts` — `describe("integration",
  …)` block, single test
  `"lint-test-isolation: no errors, warning count pinned"`. The
  surrounding comment block (currently above the `toBe(20)`
  assertion) explains the two failure modes. The guarded throw goes
  *between* the comment and the `toBe` line; the comment can be
  trimmed since the message body now lives in the constant. The
  `expect(result.warningCount).toBe(20)` line is retained.

- `scripts/lint-contracts.ts` and `scripts/lint-contracts.test.ts` —
  sibling pinned-warning lint with the same shape. The integration
  block at line 508 contains the `toBe(0)` assertion at line 521. The
  surrounding comment (lines 522–525) explains the two failure modes:
  field-contract drift vs matcher-coverage upgrade. The contracts
  heuristic constant lives in `scripts/lint-contracts.ts`, imported
  by the test for the guarded throw.

- `src/test-utils.ts` — `withTestHarness` (line 74) and
  `withSyntheticHarness` (line 109) are the tokens
  `hasIsolationSetup` accepts. The heuristic names
  `withSyntheticHarness` because it actually isolates the harness env
  (positive recommendation), with `withTestHarness` not enumerated to
  keep the message short.

- `docs/swe-textbook.md` — entry shape locked from PR #499. The
  `Capture Idempotency` block lives at the file's
  `#capture-idempotency` anchor and provides the `grep -F` short-
  circuit AC5 invokes. Existing entry count: 1
  (`### "Issue is updated" …`); the gh-ludics-496 PR (commit `7b3980f`
  is the proposal — the implementation PR is still in flight at
  proposal-write time) will add Entries A and B; this PR adds
  Entries C and D.

- `package.json` — `lint:test-isolation` and `lint:contracts` are
  already wired into the lint family. No new package-script entry
  needed.

- **No Husky present** (verified by `ls .husky` returning ENOENT and
  `package.json` containing no `husky` or `lint-staged` key). Action
  (3) from the issue body is therefore captured as Entry D rather
  than acted on.

### Related prior tasks

- `gh-ludics-477` — umbrella retro for the same lint, abandoned with
  `not_planned`. This proposal does **not** resurrect umbrella
  scope; it ships only the substantive ergonomic shift (action 2c)
  + the two filter-captured doctrine entries.
- `task-219f7b16` / `task-4101f0d5` — canonical mechanical-pin-bump
  shape, unchanged by this proposal.
- `task-f6a2c842` — converting the pin to a directional bound was
  rejected (strict pinning preserves regression-detection sharpness);
  this proposal keeps strict pinning, only adding a heuristic message
  on mismatch.
- `gh-ludics-306` — upstream isolation-pattern source, unchanged.
- `gh-ludics-496` (in flight) — parallel proposal on `main` already;
  this proposal references it as the precedent for the
  "deliverable + two textbook entries" shape.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Five ordered edits (medium-effort, plan phase warranted):

1. **Define `WARNING_COUNT_HEURISTIC` in `scripts/lint-test-isolation.ts`.**
   Export the constant (or a small helper that takes `warningCount`
   and returns the substituted string). Co-locate near the top of the
   file or near the success-summary site. Plan-phase decision: the
   exact export shape — bare string with `${N}` template substitution
   point, or a function `formatHeuristic(n: number): string`. The
   bare-string form is simpler; the function form makes substitution
   centralised and avoids the test having to repeat the substitution
   logic.

2. **Wire into the CLI summary.** In `runCli`'s success branch,
   when `warningCount > 0`, append the substituted heuristic to the
   existing summary string after the closing `.`. Preserve the literal
   prefix `✅  No test-isolation anti-patterns detected` (AC2).
   Verify by running `bun run lint:test-isolation` against the live
   tree (warningCount=20 today) and inspecting the output.

3. **Wire into the integration test as a guarded throw.** In
   `scripts/lint-test-isolation.test.ts`'s `describe("integration",
   …)` block, import the constant/helper from
   `scripts/lint-test-isolation.ts`. Insert
   `if (result.warningCount !== 20) throw new Error(<formatted>);`
   immediately before the `expect(result.warningCount).toBe(20)` line.
   The comment block can be trimmed — its content now lives in the
   constant. Sanity-check by temporarily flipping the pin (`toBe(19)`
   in a scratch commit) and confirming the thrown Error message reads
   as expected.

4. **Symmetric idiom in `scripts/lint-contracts.test.ts`.** Define
   the contracts heuristic constant in `scripts/lint-contracts.ts`,
   distinct wording focused on the contracts-lint failure mode (per
   AC4). Wire the same guarded-throw idiom into the
   `describe("integration", …)` block before the `toBe(0)` assertion.
   Plan-phase decision: the exact contracts-heuristic wording — the
   existing comment lines 522–525 are the natural seed.

5. **Two textbook entries via Capture Idempotency.** For each
   headline+precipitating-retro pair (Entry C and Entry D), run the
   `docs/swe-textbook.md#capture-idempotency` `grep -F` check. Append
   both `### …` blocks if both checks miss. Re-run the two `grep -F`
   checks afterwards as a self-test that the entries landed.

After the implementation merges, comment on issue #497 with the PR
link plus both entry anchors and close the issue (per AC6).

## Scope

**In scope:**

- New `WARNING_COUNT_HEURISTIC` constant in
  `scripts/lint-test-isolation.ts` + summary-line wiring (AC1, AC2).
- Guarded-throw integration in `scripts/lint-test-isolation.test.ts`
  importing the constant (AC3).
- Sibling contracts heuristic constant in `scripts/lint-contracts.ts`
  + guarded-throw integration in `scripts/lint-contracts.test.ts`
  (AC4).
- Two new entries appended to `docs/swe-textbook.md` (AC5).
- GH issue #497 closed via comment with PR link + entry anchors (AC6).

**Out of scope (explicitly):**

- No edits to `src/coder/**`, `src/reviewer/**`,
  `src/orchestration/**` (AC7). The lint scripts are the only
  surfaces touched in `src/`-adjacent territory; `src/test-utils.ts`
  is *referenced by name in the heuristic string* but is not modified
  by this PR.
- No edits to coder/reviewer-loaded skills (AC7/AC8). The textbook
  entries are write-side memory for Mag and feedback-digest only.
- No edits to `skills/orchestration/pair-coder-work.md` and no
  named-lint enumeration anywhere — that doctrine item is
  filter-rejected and captured as Entry C (AC10).
- No Husky / `.husky/` / `lint-staged` introduction (AC9). That
  doctrine item is filter-rejected and captured as Entry D.
- No edits to `skills/ludics-process-suggestions.md` or
  `skills/ludics-feedback-digest{,-worker}.md` — the
  capture-textbook disposition was wired in by PR #499 and needs
  nothing further here. This proposal hand-writes textbook entries
  directly, the same way `gh-ludics-496` does.
- No conversion of the pinned warning count to a directional bound
  (rejected by `task-f6a2c842`). Strict pinning is preserved; only
  the failure-message ergonomics change.
- No resurrection of `gh-ludics-477` umbrella scope.

**Dependencies:** none. PR #499 (textbook bootstrap) and PR #498
(ac-rigor proposal-path-enumeration clause) are both merged and on
`origin/main`. The parallel `gh-ludics-496` proposal is on `main`
already (commit `7b3980f`); its implementation may land before or
after this proposal's implementation without ordering constraints,
since both append disjoint entries and the textbook's Capture
Idempotency check disambiguates duplicates.
