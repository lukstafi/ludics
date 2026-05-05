# Adapter-call-site lint for `mag.orchestration.*` YAML keys

## Goal

Extend `lint:config-reference` so that any leaf key documented under
`mag.orchestration:` in `templates/config.reference.yaml` has at least
one read site in `src/adapters/t3code.ts` **or**
`src/adapters/tmux-adapter.ts`. Today the bidirectional lint catches
TS-vs-YAML drift, but it does not catch the case where YAML documents a
key that no adapter init path ever reads — the precise failure mode
that PR #493 round 2 surfaced (`mag.orchestration.substantive_stall.*`
was documented and runtime-honoured but neither adapter extracted it
from the YAML; the round-2 fix shipped a shared
`parseSubstantiveStallOverrides` parser called from both adapters).

In the same PR, capture two filtered-out doctrine reminders into
`docs/swe-textbook.md` so future Mag/feedback-digest filter decisions
have written precedent. The textbook landed via PR #499 (task-c4e0e80a,
merged earlier today) precisely to absorb hygiene-flavoured retro
learnings without bloating always-loaded coder/reviewer prompts.

Tracks GitHub issue [#496](https://github.com/lukstafi/ludics/issues/496).
Precipitating retro: `task-a670cdbf` round-2 reviewer
([PR #493](https://github.com/lukstafi/ludics/pull/493)).

## Acceptance Criteria

1. **Lint extension wired through `runLint`.** `scripts/lint-config-reference.ts`'s
   `RunLintResult` gains a new array (suggested name: `inertYamlKeys`)
   that lists each `mag.orchestration.<first-segment>` leaf documented
   in `templates/config.reference.yaml` whose name does not appear in
   either adapter source. The exit-code path treats a non-empty
   `inertYamlKeys` as drift (joins the existing
   `missingFromYaml + missingFromTs + harnessExtras` error sum).

2. **Adapter-source extractor in `lint-config-helpers.ts`.** A new
   exported function (suggested name:
   `extractAdapterReadKeysFromSource(adapterFile: string): Set<string>`)
   returns the set of literal first-segment keys read from `orchCfg`
   in a single adapter source file. Patterns recognised:
   `orchCfg?.<key>` and `orchCfg.<key>`, with the
   `gh-ludics-406` SILENT-DRIFT-WARNING comment block reproduced near
   the new extractor (same DRY-refactor-safety hazard, same mitigation
   wording adapted to `orchCfg`). The function follows the shape of
   the existing `extractMagPathsFromSource` precedent.

3. **Disjunctive read pinned.** The lint considers a key "covered" when
   it appears in `extractAdapterReadKeysFromSource("src/adapters/t3code.ts")`
   *or* `extractAdapterReadKeysFromSource("src/adapters/tmux-adapter.ts")`.
   Conjunctive coverage would over-strict: today
   `default_mode`/`default_coder`/`default_reviewer` are read only by
   t3code; the tmux adapter has no notion of mode/coder/reviewer
   selection.

4. **First-segment granularity.** The check operates on the leaf
   immediately under `mag.orchestration.`, not on nested keys. A read
   of `orchCfg?.phase_timeouts` covers every documented child under
   `mag.orchestration.phase_timeouts.*` (the adapter spreads the whole
   record); a read of `orchCfg?.substantive_stall` (passed into
   `parseSubstantiveStallOverrides`) covers
   `mag.orchestration.substantive_stall.*`. The lint does not recurse
   into nested-block keys.

5. **Self-test arm against silent regex drift.** When the new extractor
   returns the empty set for either adapter source file (zero literal
   matches), `runLint` emits a distinct error indicating the extractor
   has lost coverage — modelled after `extractMagPathsFromSource`'s
   floor-count test. This is a self-test, not a per-key probe: it fires
   when a future DRY refactor moves *all* `orchCfg?.<key>` literals
   behind a helper, before the lint goes silently green at zero
   coverage.

6. **`IGNORE_ADAPTER_READ` opt-out set bootstrapped empty (or with
   documented exceptions).** A single named constant in
   `scripts/lint-config-reference.ts` (suggested name:
   `IGNORE_ADAPTER_READ`) lists keys intentionally not read by either
   adapter, with a one-line comment per entry explaining why. The
   initial set is empty — every current `mag.orchestration:` leaf
   (`default_mode`, `default_coder`, `default_reviewer`, `coder_model`,
   `reviewer_model`, `coder_effort`, `reviewer_effort`, `phase_timeouts`,
   `substantive_stall`) has at least one adapter read site, verified by
   the unit test in AC8.

7. **Unit test for `extractAdapterReadKeysFromSource`** in
   `scripts/lint-config-helpers.test.ts`. Covers: (a) positive — a
   fabricated adapter source string with two `orchCfg?.<key>` reads
   and one `orchCfg.<key>` read returns the three keys; (b) negative —
   a source string with no `orchCfg` access returns the empty set; (c)
   floor-count guard — the live `src/adapters/t3code.ts` returns at
   least N keys (pick N as the count from the current file: 9 covering
   `default_mode`, `default_coder`, `default_reviewer`, `coder_model`,
   `reviewer_model`, `coder_effort`, `coder_thinking_effort`,
   `reviewer_effort`, `reviewer_thinking_effort`, `phase_timeouts`,
   `substantive_stall` — adjust to actual count after re-grep), so a
   future DRY refactor that drops literals trips the floor-count
   assertion before reaching CI.

8. **End-to-end tmp-fixture tests in `lint-config-reference.test.ts`**
   for the new direction:
   - **Happy path** — fixture with `mag.orchestration.foo: ...` in
     `templates/config.reference.yaml` *and* an `orchCfg?.foo` read
     in a fabricated `src/adapters/t3code.ts` returns
     `result.inertYamlKeys === []` and `exitCode === 0`.
   - **Inert key** — fixture with `mag.orchestration.bar: ...` in YAML
     but no `bar` read in either fabricated `src/adapters/*.ts` returns
     `result.inertYamlKeys.includes("bar")` and `exitCode === 1`.
   - **Disjunctive coverage** — fixture with `mag.orchestration.baz: ...`
     in YAML, no read in `src/adapters/t3code.ts`, but a read in
     `src/adapters/tmux-adapter.ts` returns
     `result.inertYamlKeys === []` and `exitCode === 0` (pins the
     disjunctive reading from AC3).
   - **Self-test** — fixture with adapter sources that contain *no*
     `orchCfg` literals at all returns a self-test failure
     (distinguishable from per-key inert errors) and `exitCode === 1`
     (pins AC5).

9. **Two textbook entries appended to `docs/swe-textbook.md`** as part
   of the same PR, conforming to the entry shape locked in by PR #499
   (`### <headline>` followed by `Description:`,
   `Precipitating retro:`, `Filter decision:`, optional
   `Second occurrence:`). Both entries cite `task-a670cdbf` round-2
   review (PR #493) as the precipitating retro:
   - **Entry A — Four-surfaces pattern.** Headline: `### New OrchestrationConfig fields require parse+merge in adapter init`.
     Body names the four surfaces (interface in
     `src/orchestration/state.ts`, default in
     `defaultOrchestrationConfig`, migrateState backfill, adapter
     parse+merge in `t3code.ts`/`tmux-adapter.ts`) and points to
     `parseSubstantiveStallOverrides` as the worked example.
   - **Entry B — AC-template hint.** Headline: `### "Adapter init reads YAML" is a separate AC for OrchestrationConfig field additions`.
     Body explains that proposals adding a new
     `OrchestrationConfig` field should enumerate "adapter init reads
     YAML and produces non-default value" as its own AC, distinct from
     interface/default/migrateState ACs.
   - **Capture Idempotency satisfied.** Before appending, run the
     `docs/swe-textbook.md#capture-idempotency` short-circuit
     (`grep -F "### <ENTRY_HEADLINE>"` *and*
     `grep -F "<PRECIPITATING_RETRO>"`). Both must miss for the
     append to proceed; if a near-duplicate exists, fall back to a
     `Second occurrence:` amendment instead.

10. **GH issue closed via comment.** Issue #496 receives a comment
    linking the merged PR plus the two textbook entry anchor IDs
    (`docs/swe-textbook.md#new-orchestrationconfig-fields-require-parsemerge-in-adapter-init`
    and the slugged form of Entry B's headline — verify the literal
    slugger output before pinning, per
    `feedback_github_md_slugger`), then is closed via `gh issue close`
    or via the GH-issue auto-sync triggered by task status (per
    `feedback_gh_issue_auto_sync`). A docs-side cite alone does not
    satisfy this AC, per the `gh-ocannl-270` AC6 lesson seeded in
    `docs/swe-textbook.md` itself.

11. **Scope invariant — no agent-loaded surfaces touched.** In
    `git diff --name-only main...HEAD`, no path matches any of:
    `src/coder/**`, `src/reviewer/**`, `src/orchestration/**`,
    `skills/orchestration/pair-coder-*.md`,
    `skills/orchestration/pair-reviewer-*.md`,
    `skills/worker-conventions.md`,
    `skills/ludics-draft-proposal-worker.md`. Phrased as a (b)-form
    invariant per
    `docs/ac-rigor-reference.md#proposal-path-enumeration-goes-stale-when-proposal-commits-to-main-first-anchor-to-scope-invariant`
    so the AC survives a proposal-commit-on-main merge-base advance
    between proposal landing and implementation forking.

12. **Negative control on always-loaded skill content.** The PR adds no
    `consult docs/swe-textbook.md` (or `see textbook` / `see SWE
    textbook` / `swe-textbook.md`) pointer in any skill loaded by
    coder or reviewer agents (the file set in AC11). Verifier:
    `git diff main...HEAD -- skills/orchestration/pair-coder-*.md skills/orchestration/pair-reviewer-*.md skills/worker-conventions.md skills/ludics-draft-proposal-worker.md`
    is empty (already enforced by AC11), AND
    `git grep -F "swe-textbook" -- skills/orchestration/pair-coder-*.md skills/orchestration/pair-reviewer-*.md skills/worker-conventions.md skills/ludics-draft-proposal-worker.md`
    on the merged tree returns no hits (i.e., no pre-existing pointer
    that the PR could fail to remove either).

## Context

### Precipitating failure mode

PR #493 round 2 (`task-a670cdbf`) caught that the new
`mag.orchestration.substantive_stall.*` YAML keys — documented in
`templates/config.reference.yaml`, typed in
`src/orchestration/state.ts`, and consumed by the runtime via
`defaultOrchestrationConfig` + the `migrateState` backfill — were
silently inert because neither `src/adapters/t3code.ts` nor
`src/adapters/tmux-adapter.ts` read/parsed/merged them out of the
YAML. The fix shipped a shared `parseSubstantiveStallOverrides` parser
called from both adapter init paths.

The bidirectional `lint:config-reference` (TS interface ↔ reference
YAML) does not catch this: both directions passed because the runtime
*type* existed and the YAML *documentation* existed; what was missing
was the **adapter init path's read**, which is a third surface.

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
  proposal commits to main first** clause under the
  Verification-evidence family. AC11 above adopts that clause's
  (b)-form invariant phrasing.

### Code pointers

- `templates/config.reference.yaml` — `mag.orchestration:` block
  (around the `orchestration:` heading). Direct leaves: `default_mode`,
  `default_coder`, `default_reviewer`, `coder_model`, `reviewer_model`,
  `coder_effort`, `reviewer_effort`. Nested blocks: `phase_timeouts:`,
  `substantive_stall:`. Comment-only legacy aliases mentioned but not
  defined: `coder_thinking_effort`, `reviewer_thinking_effort` (these
  are not flattened YAML paths and are invisible to the existing
  `flattenYamlPaths` walker — no special-casing needed).

- `scripts/lint-config-reference.ts` — `runLint(root: string): RunLintResult`.
  The current shape returns `{ exitCode, missingFromYaml, missingFromTs, harnessExtras }`
  and sums the three array lengths into the error count. The new
  `inertYamlKeys` array slots in alongside, and the error sum gains a
  fourth term. The CLI wrapper at the bottom of the file prints each
  array with a distinct `❌` heading; the new array gets its own
  heading.

- `scripts/lint-config-helpers.ts` — `extractMagPathsFromSource`
  (around the `Mag Source Grep` section header) is the precedent
  extractor: it takes a `sourceDir`, scans `.ts` files non-recursively
  on `.test.ts`, and emits a `Set<string>` of first-level mag property
  names. The new extractor follows the same shape but: (a) targets a
  single file path, not a directory; (b) returns first-segment keys
  *as found* (no `mag.` prefix); (c) anchors on the literal
  `orchCfg?.<key>` and `orchCfg.<key>` patterns. The
  SILENT-DRIFT-WARNING comment block above
  `extractMagPathsFromSource` is the doctrine to mirror.

- `scripts/lint-config-reference.test.ts` — `makeFixture` builds tmp
  fixtures by writing arbitrary file paths under a temp root. The new
  E2E tests add `src/adapters/t3code.ts` and
  `src/adapters/tmux-adapter.ts` fixture files alongside the existing
  `src/config.ts`, `templates/config.reference.yaml`, and
  `templates/harness/config.yaml` files. The CLI-integration tests at
  the bottom of the file exercise the real `import.meta.main` path
  against a tmp fixture; the new direction does not require new CLI
  tests if the `runLint` unit-tests cover the exit-code branch.

- `src/adapters/t3code.ts` — `loadConfigOrchestration` returns the
  `mag.orchestration` block as `Record<string, unknown>`. Reads at
  call sites:
  - `selectOrchestration` (~line 737): `orchCfg?.default_mode`,
    `orchCfg?.default_coder`, `orchCfg?.default_reviewer`.
  - Model resolvers (~line 823): `orchCfg?.coder_model`,
    `orchCfg?.reviewer_model`.
  - Effort resolvers (~line 852): `orchCfg?.coder_effort`,
    `orchCfg?.coder_thinking_effort`, `orchCfg?.reviewer_effort`,
    `orchCfg?.reviewer_thinking_effort`.
  - Launch path (~line 886): `orchCfg?.phase_timeouts`.
  - Launch path (~line 895):
    `parseSubstantiveStallOverrides(orchCfg?.substantive_stall)`.

- `src/adapters/tmux-adapter.ts` — mirror set of reads at ~lines 217,
  221, 239, 243, 531, 541. The tmux adapter does **not** read
  `default_mode`/`default_coder`/`default_reviewer`; those are
  t3code-only, which is why the lint must be disjunctive (AC3).

- `package.json` — `lint:config-reference` script is already wired
  into the lint family. No new package-script entry needed.

- `docs/swe-textbook.md` — entry shape locked from PR #499. The
  `Capture Idempotency` block lives at the file's
  `#capture-idempotency` anchor and provides the `grep -F` short-circuit
  the proposal's AC9 invokes.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Four ordered edits (medium-effort, plan phase warranted):

1. **Extractor + unit test.** Add
   `extractAdapterReadKeysFromSource` to
   `scripts/lint-config-helpers.ts` next to `extractMagPathsFromSource`,
   reproducing the SILENT-DRIFT-WARNING comment shape. Add the
   positive/negative/floor-count tests in
   `scripts/lint-config-helpers.test.ts`. Plan-phase decisions: the
   exact regex set (`/\borchCfg\?\.(\w+)/g` and `/\borchCfg\.(\w+)/g`,
   or a single union pattern), and whether to also recognise patterns
   like `orchCfg?.[varName]` (probably no — variable-key access
   already breaks the literal-key contract by design).

2. **Lint check + tmp-fixture E2E test.** Wire
   `inertYamlKeys` into `RunLintResult` in
   `scripts/lint-config-reference.ts`. Compute the documented YAML key
   set by walking the parsed `yamlObj` for first-segment leaves under
   `mag.orchestration.`. Subtract the union of
   `extractAdapterReadKeysFromSource("src/adapters/t3code.ts")`,
   `extractAdapterReadKeysFromSource("src/adapters/tmux-adapter.ts")`,
   and `IGNORE_ADAPTER_READ`. Anything left is inert. Add the four
   E2E tests in `scripts/lint-config-reference.test.ts`
   (happy / inert / disjunctive / self-test). Plan-phase decision:
   how the YAML walker collects "first-segment leaves under
   `mag.orchestration.`" — most directly by inspecting
   `yamlObj?.mag?.orchestration` keys rather than by parsing flattened
   paths.

3. **`IGNORE_ADAPTER_READ` set.** Bootstrap the constant in
   `scripts/lint-config-reference.ts`. Initial value is the empty
   `Set<string>()`. Verify by running the new lint against the live
   tree before committing — every current
   `mag.orchestration:` leaf must be covered by an adapter read; if
   any aren't (surprise discovery), seed `IGNORE_ADAPTER_READ` with a
   one-line per-entry rationale comment.

4. **Two textbook entries.** Run the
   `docs/swe-textbook.md#capture-idempotency` `grep -F` check for
   each headline+precipitating-retro pair. Append both `### …`
   blocks if both checks miss. Re-run the two `grep -F` checks
   afterwards as a self-test that the entries landed in the file.

After the implementation merges, comment on issue #496 with the PR
link plus both entry anchors and close the issue.

## Scope

**In scope:**

- New extractor in `scripts/lint-config-helpers.ts` + unit tests in
  `scripts/lint-config-helpers.test.ts`.
- New `inertYamlKeys` direction in `scripts/lint-config-reference.ts`
  + E2E tests in `scripts/lint-config-reference.test.ts`.
- `IGNORE_ADAPTER_READ` constant (initially empty).
- Two new entries appended to `docs/swe-textbook.md`.
- GH issue #496 closed via comment with PR link + entry anchors.

**Out of scope (explicitly):**

- No edits to `src/coder/**`, `src/reviewer/**`, or
  `src/orchestration/**` (AC11). The lint reads adapter source files
  but does not modify them.
- No edits to coder/reviewer-loaded skills (AC11/AC12). The textbook
  entries are write-side memory for Mag and feedback-digest only.
- No edits to `skills/ludics-process-suggestions.md` or
  `skills/ludics-feedback-digest{,-worker}.md` — the
  capture-textbook disposition was wired in by PR #499 and needs
  nothing further here. This proposal hand-writes textbook entries
  directly, the same way a coder hand-edits the file rather than
  going through the skill flow.
- No project-doc additions to `docs/orchestration-patterns.md` (per
  user direction Q1: scope is "lint + SWE-textbook", not "lint +
  project doc").
- No AC-template additions to `worker-conventions.md` (per user
  direction Q1).
- No codegen / DSL approach to the adapter read pattern (issue's
  action #4, explicitly out of scope at the issue level).

**Dependencies:** none. PR #499 (textbook bootstrap) and PR #498
(ac-rigor proposal-path-enumeration clause) are both merged and on
`origin/main`.
