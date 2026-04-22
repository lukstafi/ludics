# Refactor orchestration templates: imperative rules → principles-with-rationale

## Goal

The four workhorse orchestration templates (`pair-coder-plan.md`, `pair-coder-work.md`, `pair-reviewer-plan-review.md`, `pair-reviewer-review.md`) are accreting imperative rules via the feedback-digest → new-issue → template-edit pipeline. Each individual rule is reasonable, but the cumulative effect is drifting toward a checklist-driven style — and that style may be *causing* the failure mode the feedback tracks: agents tick listed boxes, miss everything outside them, and the failure mutates into a new form.

Four in-flight issues (gh-ludics-305 re-scoped, gh-ludics-311, gh-ludics-312, gh-ludics-316) are queued to add 5–10 more imperative lines each to the same four templates. If they land as currently written, density roughly triples on templates that are already ~40% of the way to unreadable.

Refactor the four heavy templates, plus two worker templates that carry similar content, so every instruction either explains *why* it exists or gets demoted to a new `docs/orchestration-patterns.md` reference doc and referenced by category. After this task lands, the four deferred issues become mechanical re-scoping: each adds a one-line principle plus a pointer to the patterns doc, instead of accreting another checklist item.

**The refactor is not "fewer rules" — it is "rules exist because judgment can't replace them, not because we don't trust the agent to use it."** A true principle is judgment-decidable; a rule is mechanically-decidable. Both have their place. The patterns doc is for the mechanically-decidable specifics (CI lint file names, canonical regex examples, round-trip serialization worked example) that give pure prescription without decision support when inlined into a template.

No GitHub issue; triggered by user meta-observation during gh-ludics-328 triage.

## Acceptance Criteria

1. Each of the four heavy templates (`skills/orchestration/pair-coder-plan.md`, `pair-coder-work.md`, `pair-reviewer-plan-review.md`, `pair-reviewer-review.md`) rewritten so every instruction either carries its rationale inline or is replaced by a one-line principle plus a cross-reference to `docs/orchestration-patterns.md`. No existing instruction silently dropped — each must either stay (as principle-with-rationale) or move (to the patterns doc, which the template references).
2. Line count on each of the four templates is roughly unchanged (±20%); the refactor trades checklist density for explanatory prose, not for brevity.
3. `docs/orchestration-patterns.md` created, with at least 10 pattern entries covering the catalogue in Scope below. Styled after `docs/testing-patterns.md` (named-pattern headers, "why" explanation, concrete worked example). Organised by workflow touchpoint (planning / coding / reviewing) rather than alphabetised.
4. Each pattern entry in the new doc states both *what* the pattern is and *why* — enough to support judgment on edge cases the template won't enumerate.
5. Worker templates `skills/ludics-draft-proposal-worker.md` and `skills/ludics-elaborate-worker.md` scanned for the same accretion pattern. Any prescriptive-without-rationale lines found during the scan are converted to principle-with-rationale or moved to the patterns doc. If none found, a brief note in the task Notes confirms the scan result.
6. Lighter templates (`pair-coder-pr-create.md`, `pair-coder-update-docs.md`, `pr-create.md`, `pr-comments.md`, `final-merge.md`, `pair-reviewer-plan.md`) scanned for the same pattern; any prescriptive-without-rationale lines there are either converted in place or referenced in Notes as deferred. Existing patterns like `pair-reviewer-gather.md`'s baseline cross-check ("mismatches usually come from different merge bases") and `pair-coder-plan-merge.md`'s gh-ludics-220 alignment checklist are *not* restructured — they are the stylistic target.
7. Cross-references from templates to the patterns doc use a consistent short form: `` see [<pattern name>](../../docs/orchestration-patterns.md#<slug>) ``. All section anchors are slug-based (`#ci-drift-files`, `#multi-pattern-symbol-extraction`, etc.) so links survive future doc reorganisation as long as headings don't rename.
8. Snapshot tests in `src/orchestration/skills.test.ts` updated to match the new rendered content for the four heavy templates.
9. `bun test` passes (modulo pre-existing failures); `bun run build` succeeds; `bun run lint` succeeds.
10. A non-AI contributor can read each refactored template and explain, for every instruction, *why* it exists. This is the real acceptance criterion; (2) is its quantitative floor.

## Context

### The four heavy templates today

Each is small in bytes but dense in imperative instructions. Key structural features to preserve, with location references by symbol name:

- **`skills/orchestration/pair-coder-plan.md`** (26 lines)
  - Pre-existing-failures baseline paragraph introducing the `## Pre-existing test failures (baseline)` plan section.
  - Regression-tests-in-first-round paragraph with three example triggers (serialization, template rendering, validation).
  - "Use numbered lists; avoid wide markdown tables" — *already principle-with-rationale; stylistic target.*
  - Data-shape consumer sweep paragraph.
  - Exhaustive-occurrence-search paragraph with disposition-list requirement.
  - "Don't implement yet" + status-file printf.

- **`skills/orchestration/pair-coder-work.md`** (37 lines)
  - Batch-size + regression-test-in-same-batch principle.
  - Pre-modify symbol grep (duplicates the plan template — *consolidation target*).
  - "Where drift tends to creep in" bullet list with CI-drift specifics (`templates/config.reference.yaml` + `lint:config-reference`; README CLI Reference + `lint:cli-readme`).
  - Round-trip fidelity test bullet.
  - `{{#IF PROPOSAL_PATH}}` AC-verification block (gh-ludics-316 wants to modify this; the refactor should set the shape gh-ludics-316 then adopts).
  - Bail-out contract.

- **`skills/orchestration/pair-reviewer-plan-review.md`** (36 lines)
  - Code-Proposal Alignment section (from gh-ludics-220, already shipped in principle-with-rationale form).
  - Data-shape downstream-consumer reviewer check.
  - Occurrence-completeness reviewer check.
  - Regression-tests reviewer check.

- **`skills/orchestration/pair-reviewer-review.md`** (23 lines)
  - Config/CLI Reference update check (purely prescriptive; ideal candidate for "one-line principle → patterns doc").
  - Review-format instruction (file path, first-line `APPROVE` / `REQUEST_CHANGES` — this is a mechanical rule the orchestrator actually enforces; keep as-is).
  - Data-shape / round-trip-fidelity consumer check.
  - Pre-existing-failures decision tree (a single four-branch sentence — the clearest candidate for collapse into a principle with worked-examples pointer).
  - Bail-out-confirmation contract.

### Verification landmarks

Checked against `~/ludics/` on 2026-04-22:

- File sizes: `pair-coder-plan.md` 1952 B, `pair-coder-work.md` 1786 B, `pair-reviewer-plan-review.md` 1756 B, `pair-reviewer-review.md` 1768 B.
- `extractMagPathsFromSource` at `scripts/lint-config-helpers.ts` line ~191 — exactly three regex patterns (`\bmag\?\.(\w+)`, `\bmag[A-Z]\w*\?\.(\w+)`, `\.mag\b[^;]*?\)\?\.(\w+)`) unioned. Canonical multi-pattern-extraction example for the new doc.
- Both CI lint scripts are real: `package.json` script `lint:config-reference` → `scripts/lint-config-reference.ts`, `lint:cli-readme` → `scripts/lint-cli-readme.ts`.
- "Project-wide grep for every symbol you plan to touch" is duplicated between `pair-coder-plan.md` (planning phase, disposition list) and `pair-coder-work.md` (pre-modify re-check). Both instances stay — they are different-phase obligations — but the *specifics* (inline-reimplementation regex examples, copy-pasted-logic note) move to the patterns doc and get referenced.

### The stylistic target

`skills/orchestration/pair-coder-plan-merge.md`'s "Code-Proposal Alignment Check" section (landed by gh-ludics-220) is the shape to reach for everywhere:

> **Before merging, spot-check the proposal's code assumptions against the actual codebase in this worktree (grep, search, or type-check). In particular:**
> - APIs/functions mentioned in the proposal exist.
> - Function/module signatures match what the proposal expects.
> - ...
>
> **Minor gaps (e.g., a renamed method with identical behavior) — document and proceed. Substantial gaps (a missing API or module that would cause rework) — reassign to the reviewer with REQUEST_CHANGES.**

Named concern, bulleted concreteness without checkbox-prescription, decision rule about minor-vs-substantial gaps, concrete remediation format. This template stays structurally unchanged; new prose in the four heavy templates mimics it.

`docs/testing-patterns.md` is the stylistic target for the new patterns doc: named pattern, "why X is dangerous" framing, "the safe pattern" concrete example, reference-examples footer.

### Related existing docs

- `docs/orchestration-phase-transitions.md` — technical reference for the runner's snapshot API (different audience — implementation not agent-facing).
- `docs/testing-patterns.md` — agent-facing, pattern-style, narrowly scoped to test-authoring. Extending it to cover orchestration workflow would mix two audiences; create a separate file instead.
- `docs/ARCHITECTURE.md`, `docs/proposal-*.md`, `docs/staging-repo-proposal.md` — design docs, not agent-facing references.

### Tests

`src/orchestration/skills.test.ts` snapshots rendered skill content for specific phase/mode combinations. The four heavy templates' snapshots will need updating. Not a blocker.

### Sequencing

Four deferred issues (gh-ludics-305 re-scoped, gh-ludics-311, gh-ludics-312, gh-ludics-316) currently have proposals written in the old additive style. Each proposes template-text additions, not runtime code changes. After this task lands:

- Each of those four proposals gets mechanically re-scoped: instead of adding a checklist item to each of the four templates, they add a one-line principle plus a patterns-doc cross-reference (and if needed, a new pattern entry in the patterns doc).
- No code dependency; the re-scoping is text-only.
- Task-da8b6dff (solo mode) should also land after this task, so solo's new `solo-<phase>.md` templates (whichever option ships) inherit the refactored style from the start instead of needing a follow-up conversion pass.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Straightforward on mechanics, but the judgment calls about what becomes a principle (in-template) versus a pattern (in the doc) aren't purely mechanical — they warrant duo-mode in case two implementations disagree on the split. However, the decision rule is narrow enough that a single coder-reviewer pair should handle it fine: **a template stays with the principle if an agent needs to act on it in the current phase; the patterns doc carries the worked example for depth-on-demand.**

### Suggested implementation order

1. **Create `docs/orchestration-patterns.md`** first, populated with the pattern catalogue below. This gives the template refactor a target to cross-reference.

2. **Refactor the four heavy templates**, one at a time. For each:
   - Read the current template.
   - Categorise every sentence as (a) principle-with-rationale (keep as-is or lightly rewrite), (b) imperative-without-rationale (either add a `why` clause inline, or collapse to a principle + patterns-doc cross-reference), (c) multi-branch decision tree (collapse to one principle sentence with worked-examples link), (d) mechanical rule the orchestrator enforces (keep as-is — e.g., "first line is `APPROVE` or `REQUEST_CHANGES`" is parsed by runtime code).
   - Rewrite.
   - Verify line count stayed within ±20% and every instruction from the original still has a home (in-template or in patterns doc).

3. **Scan the worker templates** (`ludics-draft-proposal-worker.md`, `ludics-elaborate-worker.md`). Apply the same conversion where needed. Expect light touch — these are already closer to the target style.

4. **Scan the lighter orchestration templates** listed in AC 6. Any conversion is in-place; no new patterns doc entries likely needed.

5. **Update `src/orchestration/skills.test.ts` snapshots** to match the refactored templates.

6. **Run tests + build + lint.** Commit.

### Pattern catalogue for `docs/orchestration-patterns.md`

The doc should have these sections at minimum (≥10, AC 3). Each gets a slug anchor for cross-reference:

1. `#ci-drift-files` — `templates/config.reference.yaml` + `lint:config-reference`; README CLI Reference + `lint:cli-readme`. Why these files drift; how CI catches it; when to update proactively.
2. `#multi-pattern-symbol-extraction` — `extractMagPathsFromSource` as worked example. Why one regex misses inline variants; how to union three patterns; when to stop adding patterns.
3. `#round-trip-serialization-fidelity` — serialize → deserialize → compare key fields. Why silent field omissions are the dominant failure mode; minimal test shape.
4. `#pre-existing-failures-baseline` — `## Pre-existing test failures (baseline)` plan section convention. Why named tests (not summaries); how reviewer uses the baseline; what to do if baseline is missing (older format) or notes planning was skipped.
5. `#data-shape-consumer-sweep` — grep field names, section headers, type references. Why shape changes silently break downstream. What counts as a consumer.
6. `#regression-test-per-behaviour-change` — first implementation round, not deferred. Why deferral drifts to abandonment. Common triggers (serialization, rendering, validation, CLI output).
7. `#exhaustive-occurrence-search` — project-wide grep, disposition list, inline-reimplementation variants. Why canonical-name search alone misses regex patterns, copy-pasted logic, string literals. When a disposition of "skip with reason" is appropriate.
8. `#wide-table-avoidance` — numbered lists over tables. Why wide tables truncate between agents; when a narrow table is still fine.
9. `#scope-declaration-and-salvage` (gh-ludics-305 re-scoped) — declare out-of-scope files in plan/commit; reviewer discretion; salvage into needs-confirmation follow-up. Why scope creep is corrosive to the plan-merge cycle.
10. `#ac-self-check` (gh-ludics-316) — visible AC checklist artifact before done; unconditional on proposal presence. Why AC drift is the long-tail failure mode.
11. `#assumption-drift` (gh-ludics-311) — `[UNVERIFIED]` markers; `ASSUMPTION GAP` escalation; commit-count freshness warning. Why proposals staled in storage are riskier than fresh ones.
12. `#caller-audit-on-signature-change` (gh-ludics-312) — when return type or parameter shape changes, enumerate callers (including destructuring, casts, `any`-typed call sites). Why TypeScript's coverage gaps hide broken callers.
13. `#code-proposal-alignment` (gh-ludics-220, shipped) — ASSUMPTION GAP markers; minor-vs-substantial gap handling. (Doc entry points at `pair-coder-plan-merge.md` as the in-template home.)
14. `#symbol-name-references` (gh-ludics-243, shipped) — function/type/symbol names, not line numbers. Why line numbers drift between elaboration and implementation.
15. `#baseline-cross-check-reviewer` — reviewer's independent `bun test` vs coder's baseline; differences usually indicate different merge bases.
16. `#bail-out-contract` — `bail-out|<ts>|<reason>` on coder side; `bail-out-confirmed` or `REQUEST_CHANGES` on reviewer side. Why bail-out exists as a shape (so obsolete tasks don't waste a round on empty commits). When to use it vs a normal completion.

### Cross-reference format

Template pointer to patterns doc:

```
For symbols you plan to touch, run a project-wide search and note what you found — see
[exhaustive occurrence search](../../docs/orchestration-patterns.md#exhaustive-occurrence-search)
for the disposition-list shape and inline-reimplementation variants to look for.
```

The template carries the *principle* ("for symbols you plan to touch, run a project-wide search and note what you found"); the patterns doc carries the *specifics* (how a disposition list looks, what inline-reimplementation means, when to decide "skip with reason"). Agents who read only the template still have enough to act; agents who hit an edge case follow the link.

### Design decisions the proposal makes (rather than blocking on user)

- **Patterns doc path**: `docs/orchestration-patterns.md` (new file). Parallel naming to `docs/orchestration-phase-transitions.md`. Not extending `docs/testing-patterns.md` — that doc's scope is strictly test-authoring.
- **Anchor convention**: slug-based, lowercase, hyphen-separated (`#ci-drift-files`, `#round-trip-serialization-fidelity`). GitHub's default markdown anchor algorithm. Stable across doc reorganisation as long as headings don't rename.
- **Worker-template scope**: conditional. If the scan finds prescriptive-without-rationale lines, convert in this task. If the scan finds nothing, note the result in task Notes rather than opening follow-up work.

## Scope

**In scope:**
- Refactor `skills/orchestration/pair-coder-plan.md`, `pair-coder-work.md`, `pair-reviewer-plan-review.md`, `pair-reviewer-review.md`.
- Create `docs/orchestration-patterns.md` with ≥10 pattern entries from the catalogue above.
- Scan and conditionally convert `skills/ludics-draft-proposal-worker.md`, `skills/ludics-elaborate-worker.md`.
- Scan the lighter orchestration templates (`pair-coder-pr-create.md`, `pair-coder-update-docs.md`, `pr-create.md`, `pr-comments.md`, `final-merge.md`, `pair-reviewer-plan.md`); in-place conversion if accretion found.
- Update `src/orchestration/skills.test.ts` snapshots.

**Out of scope:**
- Re-scoping gh-ludics-305 / gh-ludics-311 / gh-ludics-312 / gh-ludics-316 proposals. Each of those remains a separate task; after this refactor lands, each re-scope is a mechanical update (one-line principle + patterns-doc cross-reference instead of a four-template text accretion). The refactor doesn't cancel those issues — their concerns are real workflow-feedback patterns.
- Changing `pair-coder-plan-merge.md`. It already carries the target style and is cited as the stylistic exemplar.
- Changing `pair-reviewer-gather.md`'s baseline cross-check paragraph. Also already in target style; cited as an exemplar.
- Updating the `mergeExecute` / `mergeReview` / `mergeDebate` / `mergeAmend` / `mergeVote` templates. Out of the main pair flow; small, tight, already mechanical.
- Updating `pr-conflict-resolve.md`, `forward-pr.md`, `upstream-final-merge.md`. Mostly mechanical shell; tangential to the accretion pattern.
- Automated verification that the refactor reduced rote-compliance failure modes. No automated signal exists; the observation channel is retrospective data over several rounds after the refactor lands. Flag in task Notes post-merge so feedback-digest later can look for the signal.
- Updating solo-mode templates. Task-da8b6dff handles those; it should land after this task so it inherits the refactored style from the start.
- CLAUDE.md, other top-level docs. None of them carry the accretion pattern.

**Dependencies / sequencing:**
- This task should land *before* gh-ludics-305 (re-scoped), gh-ludics-311, gh-ludics-312, gh-ludics-316, and task-da8b6dff. No hard code dependency; all are text-only changes that will be trivially re-scoped once the patterns doc exists.
- No blocking predecessors.

**Tests / verification story:**
- Mechanical: `bun test` (with updated snapshots), `bun run build`, `bun run lint` all pass.
- Semantic: the "non-AI contributor can read and understand why" criterion (AC 10). Verify by reading each refactored template end-to-end.
- Long-tail: whether the refactor actually reduced rote-compliance failure modes is observable only over several rounds of subsequent task runs via retrospective data. Not a merge gate.
