# Backfill optional fields at the read boundary, not at every construction site

## Goal

Capture, as a reference-layer pattern, the lesson distilled from PR #399's review
of `OrchestrationState.harnessDir`: when a new optional field is added to a
persisted shape, the cheapest place to populate it is the existing read-boundary
normalizer (e.g. `migrateState`, `parseTaskFrontmatter`) — not every construction
site in production code. Backfilling at read uniformly handles three populations
that construction-site population reaches only one of: (1) production init,
(2) legacy on-disk state predating the field, (3) test-constructed state
literals.

The deliverable is documentation + a one-line plan-review checklist hint. No
runtime lint, no CI check — the principle is too soft to mechanize and the
existing review scaffolding is the right enforcement layer (cf. user
preference: "review scaffolding is sufficient — don't bloat skill templates").

Linked issue: https://github.com/lukstafi/ludics/issues/410.
Catalyst: PR #399 (branch `ludics/task-f60547cd-s6/root`, not yet merged as of
2026-04-25), reviewer comment on AC 5 of `task-f60547cd--workflow-feedback-coder`.

## Acceptance Criteria

1. A new pattern entry under `## Planning` in `docs/orchestration-patterns.md`
   titled "Adding optional fields to persisted state" (or equivalent phrasing
   matching the issue's "Suggested Action"), placed near
   `### Data-shape consumer sweep` since both concern shape evolution.
2. The entry follows the existing entry shape used throughout the file:
   **Principle** / **Why** / **Worked example** / **When not to apply**, with
   GitHub-anchor-friendly slug (lowercase, hyphen-separated).
3. The entry cross-links to the canonical normalize-on-load examples already in
   the codebase by *symbol name* (per
   [symbol-name references](docs/orchestration-patterns.md#symbol-name-references)):
   - `migrateState` in `src/orchestration/state.ts` — the explicit migrator
     post-processor flavor (already does the legacy `feature → taskId`
     backfill; PR #399 extends it with `harnessDir`).
   - `parseTaskFrontmatter` in `src/tasks/markdown.ts` — the implicit
     destructuring-with-`??`-defaults flavor.
4. The entry documents the four edge cases from the elaboration's
   "Edge cases & caveats": (a) the default must be derivable at read time;
   (b) `??=` mutates in place — fine for fresh deserialized objects, hazard
   for cached/shared references; (c) the pattern handles *additions* but
   *renames* need a different shape (`state.new ??= state.old; delete state.old`);
   (d) defense-in-depth at construction sites is cheap and worth keeping.
5. The entry cites PR #399 + `OrchestrationState.harnessDir` as the catalyst /
   worked example.
6. A one-line checklist hint added to
   `skills/orchestration/pair-reviewer-plan-review.md` in the data-shape /
   consumer-sweep neighborhood (currently the paragraph linking to
   `data-shape consumer sweep`), with an inline cross-link to the new pattern
   anchor. The hint says, in effect: *"If the plan adds a new optional field on
   a persisted shape, REQUEST_CHANGES unless it specifies the read-boundary
   backfill location explicitly."* Phrasing matches the surrounding template
   register (one sentence, ends with the doc-anchor link).
7. **No runtime lint and no CI check are added.** The goal is review-time
   guidance, not mechanical enforcement.
8. The change lands as a docs/template-only PR — no code changes, no test
   additions. Composes additively with sibling tasks gh-ludics-404, 405, 411,
   which extend other sections of the same file.

## Context

### The catalyst

PR #399 introduces `OrchestrationState.harnessDir` (an optional persisted
field). The original plan populated it only at the two production init sites:
`persistState` calls in `src/adapters/t3code.ts` and `src/adapters/tmux-adapter.ts`.
The reviewer noted this leaves two populations un-normalized: (a) legacy state
files persisted before the field existed, and (b) test fixtures that build
`OrchestrationState` literals directly. Adding `state.harnessDir ??= harnessDir`
inside `migrateState` covers all three populations uniformly. The fix landed in
PR #399 (not yet merged as of 2026-04-25); construction-site population was
kept as defense-in-depth.

### The asymmetry that justifies the rule

Read functions are **named, finite, and centralized** — there's a small set of
them, and a maintainer can enumerate every read in seconds. Construction sites
are **diffuse**: production init paths, test literal fixtures,
HTTP-deserialized payloads, JSON loaded from disk that pre-dates the field.
Backfilling at read covers all four classes; backfilling at construction covers
only the production init path the author already knows about.

### Two existing flavors of read-boundary normalizer in this codebase

1. **Explicit post-processor** — `migrateState(state, slot)` in
   `src/orchestration/state.ts`, called inside `readOrchestrationState` for both
   the worker-cache and controller-harness branches. It already performs the
   legacy `feature → taskId` field rename and now (PR #399) backfills
   `harnessDir`. This flavor fits when the type is large, defined externally,
   and producers should not be forced to enumerate every field.
2. **Implicit destructuring with `??` defaults** — `parseTaskFrontmatter` in
   `src/tasks/markdown.ts`. Every field in the parsed return shape carries a
   `?? default` (`status` defaults to `"ready"`, `priority` to `"B"`,
   dependency arrays to `[]`, etc.). New optional fields naturally accrete
   here as they are added to the type.

The two flavors are equivalent in effect. The choice is stylistic.

### Edge cases worth surfacing in the doc

- **Derivable defaults.** The pattern works when the read function has access
  to a value to assign — `harnessDir` works because `readOrchestrationState`
  already takes `harnessDir` as a parameter. If the default is computed from
  other state fields, the read site needs that input too, otherwise the
  backfill belongs higher up the call graph.
- **`??=` semantics.** `??=` mutates in place. That's fine when the read
  returns a fresh deserialized object (the case in every current ludics
  reader); it's a hazard if the read returns a shared/cached reference
  callers might already hold. None of the current readers cache, so this is
  documentation-only today.
- **Additions vs renames.** The pattern handles *adding* an optional field.
  *Renaming* (`feature → taskId`) needs `state.new ??= state.old; delete state.old`
  — same migrator function, distinct shape, document them separately.
- **Type expressiveness.** The TS type stays `harnessDir?: string` because
  the type describes the on-disk shape, where it can legitimately be absent
  for legacy files. Consumers that go through `readOrchestrationState` get a
  normalized object the static type can't express. A branded
  `NormalizedOrchestrationState` would fix this, but the cost-benefit is poor
  for a single field — document the convention, don't enforce via types.

### Why no runtime lint

The "this field was added without a backfill" signal is too weak to detect
mechanically. There's no syntactic marker on a type definition that says
"this field is on a persisted shape" — the relationship is between the type
and the existence of a JSON serializer/deserializer pair, which a lint can't
cheaply reason about. Per the user's stated preference for similar
workflow-feedback items (#403 family), review-time guidance beats brittle
tooling here.

## Approach

### Where the doc section lives

`docs/orchestration-patterns.md`, under `## Planning`, placed adjacent to
`### Data-shape consumer sweep` (the existing entry that already addresses
field/shape additions from the consumer side). Suggested heading:

```
### Read-boundary backfill for optional fields
```

Slug: `read-boundary-backfill-for-optional-fields`. Adjust if a shorter slug
flows better with the existing slug style.

The entry follows the existing **Principle / Why / Worked example / When not
to apply** template, with the four edge cases listed in **When not to apply**
or a short **Boundary** subsection (matching how `### Exhaustive occurrence
search` handles its boundary note).

### Where the checklist hint goes

`skills/orchestration/pair-reviewer-plan-review.md`, in the paragraph that
currently begins "For data-shape changes (field extraction, JSON migration,
section restructuring)…" (around line 24 in the current file). Append one
sentence:

> If the plan adds a new optional field on a persisted shape, the plan must
> name the read-boundary backfill location (e.g. `migrateState`,
> `parseTaskFrontmatter`); REQUEST_CHANGES if construction-site population is
> the only mechanism, since legacy and test-constructed instances stay
> non-normalized. See [read-boundary backfill for optional fields](../../docs/orchestration-patterns.md#read-boundary-backfill-for-optional-fields).

The hint sits in the data-shape paragraph rather than its own paragraph
because the concern is a refinement of "data-shape changes need consumer
sweeps" — it's a specific consumer pattern, not an orthogonal concern.

### Cross-references to add

- The new pattern entry references `### Data-shape consumer sweep` ("see also")
  since the two concerns are siblings (one looks downstream, the other looks
  at the read boundary).
- The new pattern entry references `### Symbol-name references` implicitly by
  using symbol names rather than line numbers when pointing at `migrateState`
  and `parseTaskFrontmatter`.

### Coordination with siblings

Tasks gh-ludics-404, 405, 411 plan to extend other sections of the same
`docs/orchestration-patterns.md` file. This change is purely additive (new
entry + one-line append in a template), so it composes with concurrent
additions without merge conflicts beyond ordinary section-anchor adjacency.
The PR can land independently; bundling is a user decision.

## Scope

**In scope:** one new section in `docs/orchestration-patterns.md`; one
appended sentence in `skills/orchestration/pair-reviewer-plan-review.md`; a
PR description that links PR #399 as catalyst and notes "no runtime
enforcement" explicitly so a future reader doesn't expect a lint.

**Out of scope:** any code change to `src/orchestration/state.ts` or
`src/tasks/markdown.ts` (PR #399 already handles `harnessDir`); any
construction-site audit (this proposal is a reference-layer entry, not a
sweep); any new lint, hook, or CI check; any change to the heavier
"persisted-state" surface beyond the one entry. Sibling tasks gh-ludics-404,
405, 411 own their own sections.

**Dependencies:** none blocking. Soft dependency on PR #399 only insofar as
the worked example references its `harnessDir ??= harnessDir` line; the doc
entry is still meaningful even if PR #399 is reverted (the pattern would
then describe the rejected-but-illustrative case).
