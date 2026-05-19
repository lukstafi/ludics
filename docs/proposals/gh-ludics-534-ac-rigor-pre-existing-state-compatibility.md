# AC verification rigor: Pre-existing-state compatibility — name the recovery path for each rejectable shape

## Goal

Append one new clause to `docs/ac-rigor-reference.md` § **Falsifier-shape family**, sibling to the existing `### Time-since-X ACs need two boundary fixtures`, `### 'X unchanged' ACs need structural snapshot, not single-field check`, and other Falsifier-shape clauses. The new clause captures a durable learning from `gh-ludics-524` round 3 review (PR #527): when a new validator or migration tightens what is accepted, dismissing an edge case as "consistent rejection is acceptable" silently relies on a recovery verb existing for that state shape. In the precipitating instance the merged plan classified `slotRestore` against a stash carrying a phantom `previousMode` (`agent-claude`, `agent-pair-codex`, ...) as "acceptable and consistent rejection — no special-casing"; the reviewer flagged this as a P1 because `slot reset` recovers a slot but no verb recovers a stash, so the stash would have been permanently stranded. Commit `85c24f6` added a read-path coercion in `slotRestore` (out-of-`VALID_ASSIGN_ADAPTERS` → `"manual"`) and the new test in `src/slots/index.test.ts` pins the invariant.

The general shape: for every persisted-state shape a new validator or migration could reject, the proposal / merged plan must name one of (a) an explicit migration rewriting pre-existing state, (b) a documented user recovery verb, or (c) a coercion in the read path. "Consistent rejection is acceptable" is **not** a disposition.

This is doc-only; no code changes to ludics. No skill-template touch — the plan-merge checklist in `skills/orchestration/pair-coder-plan-merge.md` and the reviewer hint in `skills/orchestration/pair-reviewer-plan-review.md` are dropped per the user's `feedback_reference_layer_not_inline` discipline (filter-vulnerable always-loaded-prompt taxation on a single occurrence).

Refs: `gh-ludics-534` (this task), `gh-ludics-524` (precipitating instance — PR #527 round 3, fix commit `85c24f6`), `task-96d69bf9` (the sibling structural-snapshot clause that established the placement and commit-message template).

## Acceptance Criteria

The verifier checks every AC below by literal-string `grep -F` or `grep -cE` against the post-commit tree (cite `git diff main...HEAD -- <paths>` or line-numbered direct source reads, not bare `git diff`).

### AC1 — Clause cardinality is exactly 25, paired with per-clause presence of the new title

After the change, `grep -cE '^### ' docs/ac-rigor-reference.md` returns the integer `25`. In addition, `grep -F` against the new H3 literal returns at least one match:

- `### Pre-existing-state compatibility — name the recovery path for each rejectable shape`

**Falsifier (count):** `grep -cE '^### ' docs/ac-rigor-reference.md` returns any value other than `25`.

**Falsifier (presence):** `grep -F "### Pre-existing-state compatibility — name the recovery path for each rejectable shape" docs/ac-rigor-reference.md` returns no match.

### AC2 — Heading-separator convention matches the dominant em-dash style

The new H3 title uses an em-dash (`—`, U+2014) between the short and long parts (`Pre-existing-state compatibility — name the recovery path for each rejectable shape`), not a colon or hyphen-minus. The em-dash shape mirrors the existing `### Closed-set / cardinality ACs — set-equality is the strongest probe shape`, `### Literal-grep AC — relocate the literal, don't keep it under a new rule`, and the majority of Falsifier-shape clauses.

**Falsifier:** `grep -F "### Pre-existing-state compatibility — name the recovery path for each rejectable shape" docs/ac-rigor-reference.md` returns no match (would fail if a hyphen-minus or colon were substituted for the em-dash).

### AC3 — Thematic placement: under Falsifier-shape family

The new clause is inserted under `## Falsifier-shape family`. The exact intra-family position is left to the coder's judgement (the family currently runs Literal-grep → Per-element → Window-scoped pairing → Closed-set / cardinality → Byte-pinned → Prose-only → Time-since-X → X-unchanged → Literal paths → Capture-and-feed); a thematically natural slot is at the end of the family or adjacent to one of the existing structural-invariant clauses (`'X unchanged' ACs need structural snapshot` or `Capture-and-feed ACs need a direct mock-driven invariant test`), since pre-existing-state compatibility is also a structural-invariant shape.

**Falsifier (relative-position):** Run `grep -nE '^(##|###) ' docs/ac-rigor-reference.md`. The line number of the new H3 must satisfy:

- Strictly greater than the line of `## Falsifier-shape family`.
- Strictly less than the line of `## Verification-evidence family`.

If either relative-position check fails, the AC is falsified.

### AC4 — Body content: rule, the three dispositions, the hybrid scope, the worked example, and forward-looking-only note

The new clause body (prose between the new H3 and the next `### ` or `## ` heading) covers all of:

1. **The rule.** When a new validator or migration tightens what is accepted, every persisted-state shape that could carry a now-rejected value must name one of three dispositions: (a) an explicit migration that rewrites pre-existing state, (b) a documented user recovery verb (`slot reset`, `slotRestore`, dashboard action, manual edit, ...), or (c) a coercion in the read path that maps the rejected value to an accepted one.
2. **The anti-pattern.** "Consistent rejection is acceptable" / "consistent" / "no special-casing" is **not** a disposition. Dismissing an edge case with that vocabulary silently relies on a recovery verb existing for the affected shape; the AC's falsifier is "the proposal / merged plan does not name (a) / (b) / (c) for shape S."
3. **The hybrid scope.** The base enumeration of persisted-state shapes is the `PERSISTED_TYPES` allowlist in `scripts/lint-state-migration.ts` (`OrchestrationState`, `OrchestrationConfig`, `SlotData`, `TmuxSlotState`, `SessionSweepState`, `CleanupEntry`, `PreemptStash`, `InFlightDelivery`; the lint maintains this list day-one). Plus any out-of-allowlist persisted shape the PR touches — named in the proposal text, not enumerated up-front (e.g., per-task `.peer-sync/` files, ad-hoc sentinels). The clause's scope explicitly admits both: in-allowlist as the base, out-of-allowlist as PR-named additions.
4. **The worked example.** `gh-ludics-524` PR #527 introduced `VALID_ASSIGN_ADAPTERS = ["tmux", "t3code", "manual"]` and an assign-time adapter validator. A pre-existing `PreemptStash` could carry a `previousMode` like `"agent-claude"` from before the validator. The merged plan dismissed `slotRestore` against such a stash as "acceptable and consistent rejection"; the reviewer correctly flagged that `slot reset` recovers a slot but no verb recovers a stash. Commit `85c24f6` added the coercion path in `slotRestore` (`src/slots/index.ts`): an out-of-`VALID_ASSIGN_ADAPTERS` `previousMode` is coerced to `"manual"` rather than hard-failing. The regression test `slotRestore coerces a legacy phantom previousMode to manual instead of hard-failing` pins the invariant in `src/slots/index.test.ts`.
5. **Forward-looking-only note.** The clause is forward-looking: existing unaudited persisted shapes may already have validators that strand state. Out of scope for this clause to retrofit them — a retrofit audit would be a follow-up if appetite arises.

Required literal phrases (per AC4) — `grep -F` against `docs/ac-rigor-reference.md` returns at least one match for each:

- `Pre-existing-state compatibility` (the clause name).
- `PERSISTED_TYPES` (the allowlist anchor — base scope of the hybrid).
- `gh-ludics-524` (worked-example anchor).
- `previousMode` (the worked-example field name).
- `slotRestore` (the worked-example verb).
- `VALID_ASSIGN_ADAPTERS` (the worked-example validator).
- `85c24f6` (the worked-example fix commit).
- `recovery verb` (or `recovery path`) (the rule's primary vocabulary).
- `coercion` (the (c) disposition's name).
- `migration` (the (a) disposition's name).
- `consistent rejection` (the anti-pattern literal — explicitly rejected as a disposition).

Body length: the body is between 5 and 9 sentences inclusive (matching the doc's existing template; the `'X unchanged'` sibling clause is ~7 sentences). Sentence count is reviewer-checked, not mechanically asserted.

**Falsifier (per-element literal presence):** Any of the eleven literal-phrase `grep -F` checks above returns no match in `docs/ac-rigor-reference.md`.

### AC5 — Preamble count update: "twenty-four clauses" replaced by "twenty-five clauses"

The preamble's clause-count assertion at `docs/ac-rigor-reference.md:5` (currently `"twenty-four clauses across five thematic families"`) is updated from `"twenty-four"` to `"twenty-five"`. The literal must change, not be left alongside the new one.

**Falsifier (count present):** `grep -F "twenty-five clauses" docs/ac-rigor-reference.md` returns no match.

**Falsifier (count absent):** `grep -F "twenty-four clauses" docs/ac-rigor-reference.md` still returns a match. (The literal `"twenty-four"` must be replaced, not left alongside.)

### AC6 — Doc-shape regression probe pins the clause (heading-anchor + content-fingerprint pair)

A doc-shape regression probe pins the new clause against silent drift, following the `### Vacuous doc/config harness — same rule, doc artifacts` sub-paragraph "Per-AC clause: pair the two probes — heading-anchor AND content-fingerprint." The probe is implemented in a new test file `docs/ac-rigor-reference.shape.test.ts` (mirroring the existing `docs/swe-textbook.shape.test.ts` and `docs/task-frontmatter-reference.shape.test.ts` harness style) with at least one heading-anchor assertion and at least one content-fingerprint assertion for the new clause:

- **Heading-anchor probe:** asserts the H3 line `### Pre-existing-state compatibility — name the recovery path for each rejectable shape` is present in `docs/ac-rigor-reference.md`. Falsifier-mutation: rename or delete the heading → assertion fails.
- **Content-fingerprint probe(s):** within the slice from the new H3 to the next `### ` or `## ` heading, assert presence of distinguishing literals from the body — at minimum `PERSISTED_TYPES`, `gh-ludics-524`, `slotRestore`, `previousMode`, and `consistent rejection` (or an equivalent subset that uniquely identifies the body). Falsifier-mutation: empty out the clause body or replace the body literals with paraphrases → at least one content-fingerprint assertion fails.

The two probes are independent: heading-only would pass a doc whose body has been emptied; content-only would pass a doc that buries the literals in some unrelated paragraph. Both are required.

**Falsifier (probe-file present):** `ls docs/ac-rigor-reference.shape.test.ts` returns the file.

**Falsifier (heading-anchor probe present):** `grep -F "Pre-existing-state compatibility — name the recovery path for each rejectable shape" docs/ac-rigor-reference.shape.test.ts` returns at least one match.

**Falsifier (content-fingerprint probes present):** `grep -F "PERSISTED_TYPES"`, `grep -F "gh-ludics-524"`, `grep -F "slotRestore"`, `grep -F "previousMode"`, and `grep -F "consistent rejection"` against `docs/ac-rigor-reference.shape.test.ts` each return at least one match.

**Falsifier (test runs and passes):** `bun test docs/ac-rigor-reference.shape.test.ts` exits non-zero or reports any failing test.

**Mutation-test (informational):** delete the new H3 line locally and re-run — the heading-anchor assertion fails. Empty out the clause body and re-run — at least one content-fingerprint assertion fails. Do not commit either mutation; this is verification evidence, not a code change.

### AC7 — No code changes to ludics; no skill-template touch

This is doctrine-only: the changes are confined to `docs/ac-rigor-reference.md` and the new `docs/ac-rigor-reference.shape.test.ts`. Per harness convention (memory: `feedback_reference_layer_not_inline.md`), no skill-template change. Specifically, `skills/orchestration/pair-coder-plan-merge.md`, `skills/orchestration/pair-reviewer-plan-review.md`, and `skills/worker-conventions.md` are *not* updated by this task. Following the precedent of `task-96d69bf9` (which landed the `'X unchanged'` sibling clause and also did not update worker-conventions or skill files).

**Falsifier:** `git diff --name-only main...HEAD` returns any path other than `docs/ac-rigor-reference.md`, `docs/ac-rigor-reference.shape.test.ts`, and `docs/proposals/gh-ludics-534-ac-rigor-pre-existing-state-compatibility.md`.

## Context

The reference doc as merged on `origin/main` (verified at HEAD before this task starts) contains 24 `### ` clauses across 5 `## ` family sections. Heading inventory (line numbers will drift; reference by named-section boundaries):

- `## Vacuous-harness family` — seven clauses (Vacuous test harness; Stash-prod mutation test; Sibling-mutation for cardinality probes; Vacuous doc/config harness; Probe before cleanup; Real-decoy + byte-identity for path-safety probes; Test inputs your guard accepts pass for the wrong reason).
- `## Proposal-as-canonical family` — two clauses (Proposal beats task file; Self-contradicting AC literal probe).
- `## Falsifier-shape family` — ten clauses (Literal-grep AC; Per-element assertions; Window-scoped pairing; Closed-set / cardinality; Byte-pinned assertions; Prose-only template; Time-since-X; X-unchanged; Literal paths; Capture-and-feed).
- `## Verification-evidence family` — four clauses (AC verification evidence survives commit boundary; AC-cited test paths are load-bearing; Diff-enumerated lines go stale; Proposal-path enumeration goes stale).
- `## Baseline-aware framing family` — one clause (No-regression framing).

The preamble (`docs/ac-rigor-reference.md:5`) currently reads:

> Today it covers twenty-four clauses across five thematic families; further reviewer-flagged learnings (and others) are expected to land as additional `### ` subsections under the same families or new sibling families.

The parenthetical body is generic ("and others"); only the count word changes from `twenty-four` to `twenty-five`.

The clause source is the `gh-ludics-524` PR #527 round 3 reviewer feedback and the resulting commit `85c24f6`. The relevant code is in `src/slots/index.ts` § `slotRestore` (function starts at line ~788; the coercion-path block runs from ~798 to ~807 at the time of writing — reference by function name, not line numbers, per `feedback_reference_layer_not_inline` discipline). The pinned regression test in `src/slots/index.test.ts` is titled exactly:

> `slotRestore coerces a legacy phantom previousMode to manual instead of hard-failing (gh-ludics-524 PR #527 P1)`

The `PERSISTED_TYPES` allowlist in `scripts/lint-state-migration.ts` (lines around 65–77) currently contains eight entries: `OrchestrationState`, `OrchestrationConfig`, `CleanupEntry`, `InFlightDelivery`, `PreemptStash`, `SessionSweepState`, `SlotData`, `TmuxSlotState`. The lint enforces *field co-change* (touched field → migrator + test) but does NOT enforce *recovery-path naming* — that's the plan-text discipline this new AC clause codifies.

The `task-96d69bf9` sibling clause (commit landed 2026-05-03, `'X unchanged' ACs need structural snapshot, not single-field check`) is the immediate template for shape, placement, commit-message style, and the `### ` heading-separator convention. That commit modified only `docs/ac-rigor-reference.md` and did not update `skills/worker-conventions.md` or any skill file; this task follows the same scope, plus a paired `docs/ac-rigor-reference.shape.test.ts` shape probe (which the sibling clauses pre-dating shape-probe doctrine did not add — this task is the first AC-rigor clause whose AC ledger includes its own shape-probe AC, per the `Vacuous doc/config harness` clause's "pair the two probes" sub-paragraph).

The user's `feedback_reference_layer_not_inline` memory still applies: trust agents over upfront prescription. This proposal pins shape (placement, separator, count, body-content checklist, probe contract) but lets the coder choose paragraph wording within the 5–9 sentence template and shape-test code within the heading/content-fingerprint contract.

User-resolved questions (recorded in `tasks/gh-ludics-534.md` § Notes, 2026-05-19):

- **Q1 (family placement):** Falsifier-shape family. The AC's falsifier — "the merged plan / proposal names a disposition per persisted shape" — is structural and reachable by violation.
- **Q2 (allowlist tie):** Hybrid. Name `PERSISTED_TYPES` as the base scope, admit out-of-allowlist shapes in clause text.
- **Q3 (reviewer hint):** N/A — skipped per scope decision. No `pair-reviewer-plan-review.md` change.
- **Q4 (mechanical lint extension):** Out of scope. Revisit only if a second occurrence justifies a `lint:pre-existing-state-compat` extension.
- **Q5 (retrofit policy):** Forward-looking only. Audits of existing validators (e.g., the `VALID_ASSIGN_ADAPTERS` validator itself, plus other recent validator commits) are out of scope; a follow-up issue if appetite arises.

The user explicitly dropped:

- The plan-merge checklist in `skills/orchestration/pair-coder-plan-merge.md` (filter-vulnerable always-loaded-prompt taxation on a single occurrence).
- The reviewer hint in `skills/orchestration/pair-reviewer-plan-review.md` (same reason).

The AC clause alone is the durable form; the proactive plan-merge layer and the catch-net reviewer-hint layer from the issue's three-layer proposal are dropped per the `feedback_competent_swe_filter` and `feedback_reference_layer_not_inline` disciplines (reviewer stays the catch-net; the AC-rigor doc is reference-layer that workers consult when the AC ledger calls for extra rigor).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The work is doc-only with two touched files (`docs/ac-rigor-reference.md` and a new `docs/ac-rigor-reference.shape.test.ts`). A natural single-commit shape:

1. **Update the preamble** at `docs/ac-rigor-reference.md:5`: replace the literal `twenty-four clauses` with `twenty-five clauses`. The parenthetical body (`(and others)`) does not change.

2. **Insert the new clause** under `## Falsifier-shape family`. The intra-family position is the coder's call (per AC3, anywhere between `## Falsifier-shape family` and `## Verification-evidence family` is acceptable); a thematically natural slot is at the end of the family (after `### Capture-and-feed ACs need a direct mock-driven invariant test, not indirect coverage`) or adjacent to the structural-invariant siblings (`'X unchanged' ACs need structural snapshot` or `Capture-and-feed`). Distil the body to 5–9 sentences covering the five body-content elements from AC4: the rule, the anti-pattern (with the literal `consistent rejection`), the hybrid scope (with `PERSISTED_TYPES`), the worked example (with `gh-ludics-524`, `slotRestore`, `previousMode`, `VALID_ASSIGN_ADAPTERS`, commit `85c24f6`), and the forward-looking-only note. Required literal phrases per AC4: `Pre-existing-state compatibility`, `PERSISTED_TYPES`, `gh-ludics-524`, `previousMode`, `slotRestore`, `VALID_ASSIGN_ADAPTERS`, `85c24f6`, `recovery verb` (or `recovery path`), `coercion`, `migration`, `consistent rejection`.

3. **Add the shape probe** `docs/ac-rigor-reference.shape.test.ts` mirroring `docs/swe-textbook.shape.test.ts` (same `slice` helper for range-scoped slices, same `read` helper for repo-relative reads, same `describe` / `test` structure). Minimum probe content:
   - One heading-anchor test asserting the H3 literal is present in `docs/ac-rigor-reference.md`.
   - One content-fingerprint test slicing from the new H3 to the next `### ` or `## ` heading and asserting `PERSISTED_TYPES`, `gh-ludics-524`, `slotRestore`, `previousMode`, and `consistent rejection` each appear in the slice.
   - A preamble-count test asserting `twenty-five clauses` is present and `twenty-four clauses` is absent (this also protects AC5 from regression).
   - Total-clause-count test asserting `grep -cE '^### '`-equivalent returns 25 (regex over the body content, e.g., `body.match(/^### /gm)!.length === 25`).

4. **Verify before committing:**
   - `grep -cE '^### ' docs/ac-rigor-reference.md` → `25`.
   - `grep -F "### Pre-existing-state compatibility — name the recovery path for each rejectable shape" docs/ac-rigor-reference.md` → match.
   - `grep -F "twenty-five clauses" docs/ac-rigor-reference.md` → match; `grep -F "twenty-four clauses" docs/ac-rigor-reference.md` → no match.
   - The eleven literal phrases from AC4 each return at least one match in the new clause body (slice from new H3 to next heading).
   - `bun test docs/ac-rigor-reference.shape.test.ts` → all tests pass.
   - `git diff --name-only main...HEAD` → exactly `docs/ac-rigor-reference.md`, `docs/ac-rigor-reference.shape.test.ts`, and `docs/proposals/gh-ludics-534-ac-rigor-pre-existing-state-compatibility.md`.

5. **Commit message style** follows the `task-96d69bf9` / Time-since-X precedent. A natural shape:

   > `docs/ac-rigor-reference: add Pre-existing-state-compatibility clause`
   >
   > New clause under Falsifier-shape family covers a structural-invariant shape
   > specific to new validators / migrations: dismissing an edge case as
   > "consistent rejection is acceptable" silently relies on a recovery verb
   > existing for the affected persisted-state shape. The merged plan must name
   > one of (a) explicit migration, (b) documented recovery verb, or (c)
   > read-path coercion per shape — at minimum for shapes in the PERSISTED_TYPES
   > allowlist, plus out-of-allowlist persisted shapes the PR touches. Worked
   > example from gh-ludics-524 PR #527: slotRestore coerces an
   > out-of-VALID_ASSIGN_ADAPTERS previousMode to manual (commit 85c24f6).
   >
   > Bumps the preamble's clause count from twenty-four to twenty-five.
   > Adds docs/ac-rigor-reference.shape.test.ts to pin the clause against drift.
   >
   > Refs: gh-ludics-534 (from gh-ludics-524 PR #527 round 3 retrospective)

Use `git diff main...HEAD -- docs/ac-rigor-reference.md` (post-commit, symmetric) for verification evidence — not bare `git diff`. This proposal is itself an AC-rigor exercise: the ACs above use literal `grep -F` / `grep -cE` falsifiers, per-element decomposition, post-commit-evidence framing, and a paired heading-anchor / content-fingerprint shape probe — the patterns the doc captures.

## Scope

**In scope:**

- Append one new `### ` clause subsection (`### Pre-existing-state compatibility — name the recovery path for each rejectable shape`) to `docs/ac-rigor-reference.md` under `## Falsifier-shape family`. Intra-family position is the coder's call within the bounds set by AC3.
- Update the doc preamble's clause count from `twenty-four` to `twenty-five`.
- Add `docs/ac-rigor-reference.shape.test.ts` with at least the heading-anchor, content-fingerprint, preamble-count, and total-clause-count probes specified in AC6.

**Out of scope:**

- Updating `skills/orchestration/pair-coder-plan-merge.md` with a plan-merge checklist. Dropped per the user's 2026-05-19 scope decision: filter-vulnerable always-loaded-prompt taxation on a single occurrence (memory: `feedback_reference_layer_not_inline.md`).
- Updating `skills/orchestration/pair-reviewer-plan-review.md` with a reviewer hint. Same reason.
- Updating `skills/worker-conventions.md`'s AC-rigor pointer block. Following the `task-96d69bf9` precedent; the cross-link line in the worker-conventions block already points readers to the reference doc, where the new clause is grep-discoverable.
- Extending `scripts/lint-state-migration.ts` (`lint:state-migration`) with a recovery-path-naming check. The lint enforces *field co-change*, not *recovery-path naming*; the new clause is text-side discipline. Revisit only if a second occurrence justifies a `lint:pre-existing-state-compat` extension (Q4 deferred).
- Retrofitting existing validators (e.g., the `VALID_ASSIGN_ADAPTERS` validator itself, or other recent validator commits) to confirm each persisted shape they touch has a recovery path. Forward-looking only per Q5.
- Restructuring family sections, renaming existing clauses, or reflowing the preamble's "five thematic families" wording (still accurate after this round).

**Dependencies:**

- `blocked_by: []` — `task-96d69bf9` (which landed the `'X unchanged'` sibling clause and established the template) merged earlier.
- `relates_to: [gh-ludics-524]` — the precipitating instance (PR #527 round 3) whose retrospective produced this task.
