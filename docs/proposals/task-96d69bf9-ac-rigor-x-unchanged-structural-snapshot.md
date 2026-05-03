# AC verification rigor: 'X unchanged' ACs need structural snapshot, not single-field check

## Goal

Append one new clause to `docs/ac-rigor-reference.md` § **Falsifier-shape family**, sibling to the existing **Time-since-X ACs need two boundary fixtures** clause (landed 2026-05-02 by `task-01647adf`) and the **Byte-pinned assertions on rendered or normalised output** clause. The new clause captures a durable learning from `task-ad39a394` round 2 review: when an AC says "Y is unchanged", a single-field assertion (`expect(readSlotJson(1).task).toBe(...)`) leaves every other field of the same record unprotected, so a regression that mutates `process`, `liveness`, or `session` while preserving `task` passes silently. The corrected harness snapshots the raw bytes of the slot JSON file before the operation and asserts byte-identity afterwards, with non-default values populated for the unnamed fields so the byte-identity check is non-vacuous.

This is doc-only; no code changes to ludics. The clause source is the `task-ad39a394` round 2 commit (`53a8bbf`, "test(dashboard): assert byte-identity of slot JSON in slotted-409 tests") and the surrounding reviewer feedback.

Refs: `task-ad39a394` (the source retrospective), `task-01647adf` (the Time-since-X sibling that landed first and established the placement), `gh-ludics-478` (related). `gh-ludics-481` ("AC tokens are contract") was abandoned 2026-05-02 — the consolidation question collapses to "sibling clauses under the existing Falsifier-shape family is the right shape", matching how `task-01647adf` landed.

## Acceptance Criteria

The verifier checks every AC below by literal-string `grep -F` or `grep -cE` against the post-commit tree (cite `git diff main...HEAD -- <paths>` or line-numbered direct reads, not bare `git diff`).

### AC1 — Clause cardinality is exactly 15, paired with per-clause presence of the new title

After the change, `grep -cE '^### ' docs/ac-rigor-reference.md` returns the integer `15`. In addition, `grep -F` against the new H3 literal returns at least one match:

- `### 'X unchanged' ACs need structural snapshot, not single-field check`

**Falsifier (count):** `grep -cE '^### ' docs/ac-rigor-reference.md` returns any value other than `15`.

**Falsifier (presence):** `grep -F "### 'X unchanged' ACs need structural snapshot, not single-field check" docs/ac-rigor-reference.md` returns no match.

### AC2 — Heading-separator convention matches the dominant em-dash / comma style

The new H3 title uses a `,` separator between the short and long parts (`'X unchanged' ACs need structural snapshot, not single-field check`), not a `:` colon between the short and long parts. The comma shape mirrors the existing **Per-element assertions for enumerated-element ACs** and **Self-contradicting AC literal probe — revise the AC, not the verification narrative** clauses (the latter combining em-dash and comma); the colon shape is reserved for the proposal/task-file title block.

**Falsifier:** `grep -nE "^### 'X unchanged' ACs.*: " docs/ac-rigor-reference.md` shows the new clause line with a colon separating the short and long parts.

### AC3 — Thematic placement: under Falsifier-shape family, between Time-since-X and Literal paths

The new clause is inserted under `## Falsifier-shape family`, immediately after the existing `### Time-since-X ACs need two boundary fixtures` and before the existing `### Literal paths in ACs are literal — don't substitute the platform abstraction`. Reading order in that family becomes: Literal-grep → Per-element → Byte-pinned → Prose-only → Time-since-X → X-unchanged → Literal-paths.

**Falsifier (relative-position):** Run `grep -nE '^(##|###) ' docs/ac-rigor-reference.md`. The line number of the new H3 must satisfy:

- Strictly greater than the line of `### Time-since-X ACs need two boundary fixtures`.
- Strictly less than the line of `### Literal paths in ACs are literal — don't substitute the platform abstraction`.
- Strictly less than the line of `## Verification-evidence family`.

If any of the relative-position checks fails, the AC is falsified.

### AC4 — Body content: rule, failure mode, worked example, sub-rule, and three caveats

The new clause body (prose between the new H3 and the next `### ` or `## ` heading) covers all of:

1. **The rule.** When an AC asserts "Y is unchanged" on a structured record (slot JSON, config file, persisted state), assert byte-identity of the whole record, not equality on a single field.
2. **The failure mode.** A single-field assertion leaves sibling fields unprotected — a regression that mutates the unnamed fields while preserving the named one passes silently.
3. **The worked example.** The `task-ad39a394` round 2 slot-JSON harness: snapshot `readFileSync(slotFile, "utf-8")` before the operation, assert `.toBe(slotBefore)` after.
4. **The "populate non-default values" sub-rule.** The harness must seed non-default values for the sibling fields (e.g., `process`, `liveness`, `session` in the slot-JSON example) so the byte-identity check bites; a snapshot of a default/empty record is vacuous on its non-named fields by coincidence.
5. **The compatibility-not-contradiction note vs. *Byte-pinned assertions on rendered or normalised output*.** Byte-identity is the *right* assertion for persisted state files where the contract is *no field changed*; the byte-pinned warning targets *rendered output* whose format migrations and library bumps will violate. Different artifacts, different invariants, both clauses simultaneously hold.
6. **The JSON-key-ordering / mutable-field caveats.** Byte-identity is sensitive to serialiser key-order changes — round-trip through a canonical `JSON.stringify` if the artifact's writer doesn't pin order. If a field is *expected* to update (a `lastModified` timestamp, a monotonic counter), exclude it from the snapshot via a normalised projection or freeze it before the operation.

The body is between 4 and 7 sentences inclusive (matching the doc's existing template; the Time-since-X sibling clause is 5 sentences). Sentence count is reviewer-checked.

**Falsifier (per-element literal presence):** `grep -F` for any of the seven literal phrases below against `docs/ac-rigor-reference.md` returns no match:

- `task-ad39a394` (worked-example anchor — names the round 2 source).
- `slot JSON` (worked-example artifact).
- `readFileSync` (the harness call shape).
- `byte-identity` (the rule's name).
- `populate` or `non-default` (the sub-rule's name; either alternative satisfies).
- `rendered output` (the compatibility-not-contradiction note vs. the byte-pinned clause).
- `key order` or `key-order` or `key ordering` (the JSON-key-ordering caveat; any spelling satisfies).

### AC5 — Preamble count update: "fourteen clauses" replaced by "fifteen clauses"

The preamble's clause-count assertion at `docs/ac-rigor-reference.md:5` (currently `"fourteen clauses across five thematic families"`) is updated from `"fourteen"` to `"fifteen"`. The literal must change, not be left alongside the new one.

**Falsifier (count present):** `grep -F "fifteen clauses" docs/ac-rigor-reference.md` returns no match.

**Falsifier (count absent):** `grep -F "fourteen clauses" docs/ac-rigor-reference.md` still returns a match. (The literal `"fourteen"` must be replaced, not left alongside.)

### AC6 — No code changes to ludics; no skill-template touch

This is doctrine-only: the change is confined to `docs/ac-rigor-reference.md`. Per harness convention (memory: `feedback_reference_layer_not_inline.md`), no skill-template change. Specifically, `skills/worker-conventions.md` is *not* updated by this task — the existing pointer block is preserved as-is. Following the precedent of `task-01647adf`, which also did not update `worker-conventions.md` when it landed the Time-since-X sibling clause.

**Falsifier:** `git diff --name-only main...HEAD` returns any path other than `docs/ac-rigor-reference.md` (and the proposal file under `docs/proposals/`).

## Context

The reference doc as merged on `origin/main` (verified at HEAD before this task starts) contains 14 `### ` clauses across 5 `## ` family sections. Heading inventory (line numbers will drift; reference by named-section boundaries):

- `## Vacuous-harness family` (line 13) — three clauses: Vacuous test harness; Vacuous doc/config harness; Probe before cleanup.
- `## Proposal-as-canonical family` (line 29) — two clauses: Proposal beats task file; Self-contradicting AC literal probe.
- `## Falsifier-shape family` (line 41) — six clauses: Literal-grep AC; Per-element assertions; Byte-pinned assertions; Prose-only template; Time-since-X (landed by `task-01647adf` 2026-05-02); Literal paths in ACs.
- `## Verification-evidence family` (line 69) — two clauses: AC verification evidence must survive the commit boundary; Diff-enumerated verification lines go stale.
- `## Baseline-aware framing family` (line 81) — one clause: No-regression framing.

The preamble (`docs/ac-rigor-reference.md:5`) currently reads:

> Today it covers fourteen clauses across five thematic families; further reviewer-flagged learnings (closed-set / cardinality probes, stash-prod mutation tests, and others) are expected to land as additional `### ` subsections under the same families or new sibling families.

The parenthetical names *future-anticipated* clauses (closed-set / cardinality probes, stash-prod mutation tests); it does not name the X-unchanged clause this task lands, so the parenthetical body does not need pruning — only the count word changes from `fourteen` to `fifteen`.

The clause source is the `task-ad39a394` round 2 retrospective and commit `53a8bbf` (`test(dashboard): assert byte-identity of slot JSON in slotted-409 tests`, dated 2026-05-01). The before/after of that diff shows the exact pattern the new clause prescribes:

```ts
// before (single-field, vacuous on sibling fields):
expect(readSlotJson(1).task).toBe("task-slotted-stale");

// after (byte-identity, non-vacuous):
const slotBefore = readFileSync(slotFile, "utf-8");
// ... operation ...
expect(readFileSync(slotFile, "utf-8")).toBe(slotBefore);
```

The harness was also updated to seed non-default values (`process: "tmux:s1"`, `liveness: "alive"`, `session: "sess-..."`) so the byte-identity check would actually fail under any sibling-field mutation — this is the "populate non-default values" sub-rule.

The Time-since-X sibling clause (commit `86f9f2d`, `task-01647adf`, 2026-05-02) is the immediate template for shape, placement, and commit message style. That commit modified only `docs/ac-rigor-reference.md` and did not update `skills/worker-conventions.md`; this task follows the same scope.

The user's `feedback_reference_layer_not_inline` memory still applies: trust agents over upfront prescription. This proposal pins shape (placement, separator, count, body content checklist) but lets the coder choose paragraph wording within the 4–7 sentence template.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The work is doc-only with one touched file. A natural single-commit shape:

1. Open `docs/ac-rigor-reference.md`. Update the preamble at line 5: replace the literal `fourteen clauses` with `fifteen clauses`. The parenthetical body (`closed-set / cardinality probes, stash-prod mutation tests, and others`) does not change — it names future-anticipated clauses, not the one being landed.

2. Insert the new clause under `## Falsifier-shape family`, between the existing `### Time-since-X ACs need two boundary fixtures` and `### Literal paths in ACs are literal — don't substitute the platform abstraction`. Distil the body to 4–7 sentences covering the six body-content elements from AC4: the rule, the failure mode, the worked example (`task-ad39a394` slot-JSON byte-identity), the populate-non-default sub-rule, the compatibility-not-contradiction note vs. the byte-pinned-rendered-output clause, and the JSON-key-ordering / mutable-field caveats. Required literal phrases (per AC4): `task-ad39a394`, `slot JSON`, `readFileSync`, `byte-identity`, one of `populate` / `non-default`, `rendered output`, one of `key order` / `key-order` / `key ordering`.

3. Verify before committing:
   - `grep -cE '^### ' docs/ac-rigor-reference.md` → `15`.
   - `grep -F "### 'X unchanged' ACs need structural snapshot, not single-field check" docs/ac-rigor-reference.md` → match.
   - `grep -F "fifteen clauses" docs/ac-rigor-reference.md` → match; `grep -F "fourteen clauses" docs/ac-rigor-reference.md` → no match.
   - The seven literal phrases from AC4 each return at least one match in the new clause body.
   - `git diff --name-only main...HEAD` → exactly `docs/ac-rigor-reference.md` (plus the proposal file under `docs/proposals/`, already committed by the orchestrator's worker step).

4. Commit message style follows the Time-since-X precedent (`86f9f2d`):

   > `docs/ac-rigor-reference: add 'X unchanged' structural-snapshot clause`
   >
   > New clause under Falsifier-shape family covers a vacuous-harness shape
   > specific to "Y is unchanged" ACs: a single-field assertion leaves the
   > record's sibling fields unprotected, so a regression that mutates them
   > while preserving the named field passes silently. Worked example from
   > task-ad39a394's round 2 slot-JSON byte-identity harness.
   >
   > Bumps the preamble's clause count from fourteen to fifteen.
   >
   > Refs: task-96d69bf9 (from task-ad39a394 round 2 retrospective)

Use `git diff main...HEAD -- docs/ac-rigor-reference.md` (post-commit, symmetric) for verification evidence — not bare `git diff`. This proposal is itself an AC-rigor exercise: the ACs above use literal `grep -F` / `grep -cE` falsifiers, per-element decomposition, and post-commit-evidence framing — the patterns the doc captures.

## Scope

**In scope:**

- Append one new `### ` clause subsection (`'X unchanged' ACs need structural snapshot, not single-field check`) to `docs/ac-rigor-reference.md` under `## Falsifier-shape family`, between the existing `### Time-since-X ACs need two boundary fixtures` and `### Literal paths in ACs are literal — don't substitute the platform abstraction`.
- Update the doc preamble's clause count from `fourteen` to `fifteen`.

**Out of scope:**

- Updating `skills/worker-conventions.md`'s AC-rigor pointer block. Following the `task-01647adf` precedent, the title list in `worker-conventions.md` is not updated by this task; the cross-link line in the worker-conventions block already points readers to the reference doc, where the new clause is grep-discoverable.
- Consolidating the two falsifier-shape sibling clauses (Time-since-X + X-unchanged) under a new "ACs naming structural invariants" umbrella section. Dropped per the elaboration: with `gh-ludics-481` abandoned 2026-05-02, only two sibling clauses remain — an umbrella for two is over-structure. Sibling clauses under the existing Falsifier-shape family is the right shape.
- Extending `pair-coder-work.md` / `pair-reviewer-review.md` checklists with an `unchanged` / `preserved` / `untouched` verb-trigger. Dropped per the user's 2026-05-02 stance (memory: `feedback_reference_layer_not_inline.md`): extending skill prompts with general SWE knowledge adds cognitive load on every round to save one review round-trip — the math doesn't work. Reference-layer doc is sufficient.
- Restructuring family sections, renaming existing clauses, or reflowing the preamble's "five thematic families" wording (still accurate after this round).
- Clauses for closed-set / cardinality probes and stash-prod mutation tests (still future-anticipated; named in the preamble parenthetical).

**Dependencies:**

- `blocked_by: []` — `task-01647adf` (which landed the Time-since-X sibling and established the placement and commit-message template) merged 2026-05-02.
- Blocks `gh-ludics-485`.
- Relates to `task-ad39a394` (the round-2 source of the worked example), `task-01647adf` (the Time-since-X sibling that landed first), and `gh-ludics-478`.
