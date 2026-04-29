# Floor-count assertions for regex-based source extractors

## Goal

A class of lints in `scripts/` works by greppping source for a literal access
pattern (e.g. `mag?.<key>`) and producing a "reference set" of identifiers.
The lint then compares that set against documentation or another source of
truth. The safety claim — "every key reachable from source is documented" —
holds only as long as the regex keeps producing roughly the same number of
hits across refactors. A DRY refactor that consolidates N call sites behind
a single helper, table, or loop *deletes* the literals from source. The regex
still runs successfully, just with fewer hits, and the lint passes silently
while the keys behind the helper are now invisible to it.

This proposal is **prophylactic**, not corrective: the triggering case
(`magSecondsConfig` consolidation in `src/mag.ts`) is not on `main` today —
either it was reverted, never merged, or renamed. The fix is therefore to
add the small mechanical guard that catches the *next* recurrence of this
silent-drift pattern across all of today's regex-based extractors.

The guard already exists in one place — `scripts/lint-template-safety.test.ts`
asserts both bidirectional invariance with `ALWAYS_POPULATED_KEYS` *and* an
exhaustive "the set has the expected size for the current result literal"
sanity check (line 596–602). That third assertion is exactly what's missing
from the regex-extractor tests; it makes a refactor that collapses the
extracted set immediately and loudly visible.

Source: https://github.com/lukstafi/ludics/issues/406

## Acceptance Criteria

- `scripts/lint-config-helpers.test.ts` adds a test that runs
  `extractMagPathsFromSource` against the real `src/` directory and asserts
  `set.size >= <baseline>`, where `<baseline>` is set to roughly the current
  count minus a small slack (so intentional removal of a single key does
  not trip the lint). The test sits alongside the existing
  `describe("integration", …)` block, or in its own `describe` block, with
  a short comment explaining the dual interpretation: failure means either
  (a) a DRY refactor collapsed call sites — add a regex / register the new
  helper — or (b) keys were intentionally removed — lower the floor and
  note what moved.

- `scripts/lint-cli-readme.test.ts` adds two analogous floor-count tests in
  `describe("real repository", …)`: `extractUsageCommands(indexSrc).size >=
  <baseline>` and `extractReadmeCommands(readmeSrc).size >= <baseline>`. The
  same explanatory comment pattern applies.

- `scripts/lint-contracts.test.ts` adds floor-count tests for
  `extractWorkerFields` and `extractOrchestratorFields` aggregated across all
  paired skill files in the real `skills/` directory. The shape of this
  extractor is "pairs of files contributing to a total" rather than a single
  set, so the assertion is on the **total field count summed across pairs**
  (with a baseline ≥ ~25 to tolerate skill churn). One test per direction
  (worker, orchestrator) for symmetry.

- Each of the three regex-extractor source files (`lint-config-helpers.ts`,
  `lint-cli-readme.ts`, `lint-contracts.ts`) gains a short header comment
  block, co-located with the extractor function(s), enumerating the
  recognised regex patterns and warning that wrapping any of these in a
  helper, table, or loop *will* cause the lint to silently lose coverage
  unless the helper is added to the regex set. Phrasing per extractor is at
  the worker's discretion; the comment must call out the silent-drift
  failure mode explicitly.

- `bun test scripts/lint-config-helpers.test.ts`,
  `bun test scripts/lint-cli-readme.test.ts`, and
  `bun test scripts/lint-contracts.test.ts` continue to pass on the worker's
  HEAD.

- `bun run lint:config-reference`, `bun run lint:cli-readme`, and
  `bun run lint:contracts` continue to pass (no script changes affect
  behaviour — only test additions and inline comments).

- The lint catches the failure mode it claims to: temporarily editing
  `src/mag.ts` to replace one direct `mag?.<key>` access with a call to a
  fictitious helper (e.g. wrapping `mag?.keepalive_interval` behind a
  not-yet-known consolidation function) drops the extracted set below the
  floor and the new test fails. Worker verifies this manually for at least
  one extractor and reverts.

- Floor-count baselines are *not* set to the exact current count. They are
  set with slack (current minus a small constant, or a round-number floor
  comfortably below current) so that intentional single-key removals don't
  cascade into test maintenance pain.

## Context

### The four regex-based extractors

1. **`scripts/lint-config-helpers.ts` — `extractMagPathsFromSource`.** Greps
   `.ts` files under `src/` (skipping `.test.ts`) for four regex patterns
   capturing `mag?.<key>`, `magXxx?.<key>`, `(config.mag as ...)?.<key>`, and
   `magSecondsConfig("<key>", …)`. Output feeds `lint-config-reference.ts`'s
   `magPaths` set. Current set size on HEAD: 15 keys. Suggested floor: 10.

2. **`scripts/lint-cli-readme.ts` — `extractUsageCommands` +
   `extractReadmeCommands`.** Two extractors operating on different sources
   (the `USAGE` template literal in `src/index.ts` and the `## CLI Reference`
   section of `README.md`) but sharing the silent-drift surface. Current
   sizes on HEAD: 27 USAGE commands, 14 README commands. Suggested floors:
   20 USAGE, 10 README. The asymmetry between the two reflects that
   undocumented commands are warning-only; only README-only commands are
   stale-doc errors.

3. **`scripts/lint-contracts.ts` — `extractWorkerFields` +
   `extractOrchestratorFields`.** Markdown extractors that walk paired skill
   files in `skills/`. Counted per-file the sets are small (per-pair fields
   are often 5–10), but summed across all paired files the total is a
   meaningful integrity signal. Current totals on HEAD: 37 worker fields, 37
   orchestrator fields, across 5 paired skills. Suggested floor: 25 each.

4. **`scripts/lint-template-safety.ts` + `.test.ts`** — already imports
   `ALWAYS_POPULATED_KEYS` from source rather than re-deriving by regex.
   **NOT a target.** It already has the meta-test pattern (the
   `describe("ALWAYS_POPULATED_KEYS …")` block at lines ~565–602 of the test
   file) that this proposal generalises. Mirror its shape; do not modify it.

The elaboration mentioned a possible fourth in the at-risk family but, on
verification at HEAD, only three regex-over-source extractors match the
pattern (config-helpers, cli-readme, contracts). `scripts/lint-test-isolation.ts`
also greps source but matches *anti-patterns* (rule violations) rather than
extracting a reference set, so it isn't vulnerable to the same silent-drift
failure mode and is out of scope.

### The mirror target — `lint-template-safety.test.ts`

The existing meta-test triple (around lines 569–602) is:

```ts
test("every literally-non-empty assignment is in ALWAYS_POPULATED_KEYS", …);
test("every key in ALWAYS_POPULATED_KEYS appears as a non-empty-default assignment", …);
test("the set has the expected size for the current result literal", () => {
  // Sanity check: 33 keys today. Update when buildSkillContext gains/loses
  // an always-populated key — failure here is a prompt to also update the
  // tests above with an explanatory comment in the same change.
  const nonEmpty = keys.filter((k) => !hasEmptyDefault(k.rhs)).map((k) => k.name);
  expect(new Set(nonEmpty)).toEqual(new Set(ALWAYS_POPULATED));
});
```

The third test catches DRY collapse: if a refactor wraps the assignments
behind a loop, `keys` empties out and the equality fails loudly. For the
regex extractors there's no second source of truth to assert equality
*against*, so the analogue is a floor-count assertion using
`toBeGreaterThanOrEqual(<baseline>)` — same mechanical guard, weaker
specification, same failure mode coverage.

### Live counts on HEAD (2026-04-29)

```
extractMagPathsFromSource(src/)              → 15 keys
extractUsageCommands(src/index.ts)           → 27 commands
extractReadmeCommands(README.md)             → 14 commands
sum extractWorkerFields across skills/       → 37 fields  (5 paired skills)
sum extractOrchestratorFields across skills/ → 37 fields
```

Worker re-runs these at HEAD before pinning baselines; they are stable enough
that small drift between proposal and implementation is fine, but the floors
should be set with enough slack that incremental key removal doesn't cascade
into test maintenance.

### Existing test infrastructure to mirror

- `scripts/lint-cli-readme.test.ts:171–205` — `describe("real repository", …)`
  block already runs the extractors against the real repo. Add the floor-count
  tests there.
- `scripts/lint-config-helpers.test.ts:318–364` — `describe("integration", …)`
  block. Add the floor-count test alongside the existing extra-key fixture
  test. It can be in a sibling `describe` to keep the integration block
  focused on the script-spawn end-to-end case.
- `scripts/lint-contracts.test.ts:508–522` — `describe("integration", …)`
  block. Add the cross-pair floor-count tests there.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

For each of the three extractor test files, add a `describe` block (or a
test inside an existing real-repo block) of the shape:

```ts
test("extractMagPathsFromSource: floor count of 10 keys", () => {
  const repoRoot = join(import.meta.dir, "..");
  const set = extractMagPathsFromSource(join(repoRoot, "src"));
  // When this fails: either a DRY refactor collapsed call sites (add a
  // new regex / register the new helper in extractMagPathsFromSource) OR
  // keys were intentionally removed (lower the floor and note what moved
  // in this comment).
  expect(set.size).toBeGreaterThanOrEqual(10);
});
```

Inline `expect(...).toBeGreaterThanOrEqual(N)` per call site is the floor.
A shared `floorCountAssertion(name, set, min)` test helper across three
files would save one line per call site and add an import — not enough
duplication to justify the indirection. Worker may consolidate to a shared
helper *only* if a fourth extractor is introduced during implementation,
or if the message-construction logic needs to be deduplicated for some
reason that's not visible from the proposal.

The header comment block on each extractor source file should be brief
(3–6 lines) and call out:

- the regex patterns this extractor recognises;
- the silent-drift failure mode (DRY refactor → fewer literal call sites
  → lint passes with reduced coverage);
- the mitigation (the floor-count test in the sibling `.test.ts`, plus the
  rule "if you wrap one of these patterns in a helper, add the helper to
  the regex set").

## Scope

**In scope:**

- Floor-count tests in `scripts/lint-config-helpers.test.ts`,
  `scripts/lint-cli-readme.test.ts`, and `scripts/lint-contracts.test.ts`
  (three test files, ~5 new tests total: one for mag paths, two for
  cli-readme, two for contracts).
- Header comment block on each of the three extractor source files
  (`lint-config-helpers.ts`, `lint-cli-readme.ts`, `lint-contracts.ts`),
  co-located with the extractor function(s).
- Manual verification (not a permanent test) that the floor-count assertion
  trips when a literal call site is wrapped behind a fictitious helper.

**Out of scope:**

- AST-based extraction (issue's suggestion #3, deferred per resolved Q3 —
  the `typescript` parser dependency cost is not justified for a class of
  bug that floor-counts catch with five lines per extractor).
- Modifying `scripts/lint-template-safety.ts` / `.test.ts` — it's the
  canonical mirror target, not a fix target.
- Modifying `scripts/lint-test-isolation.ts` — it's a regex-over-source
  lint but matches anti-patterns rather than extracting a reference set,
  so it has no silent-drift failure mode in this family.
- Adding any new lint script or wiring into CI beyond what already runs in
  `bun test scripts/`. The existing test runners already cover these files.
- Pinning warning counts on lint integration tests (a separate, related
  proposal: `docs/proposals/pin-lint-warning-counts.md`).
- Generalising the regex set to handle "any function call whose first arg
  is a string literal in a `mag*Config(...)` family" — over-triggering risk
  is too high; the right interface is "the lint enumerates known wrapper
  helpers explicitly" and the floor-count test catches the missed
  registration.

**Dependencies:** none. Self-contained test additions and source comments.
