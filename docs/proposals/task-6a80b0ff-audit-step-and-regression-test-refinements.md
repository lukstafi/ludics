# Refine audit-step and regression-test guidance

## Goal

Promote three workflow lessons from `task-1f04f963`'s retrospective
(`suggestRefactorSummary` items 1, 3, 4) into `docs/orchestration-patterns.md`
so they survive beyond a single retrospective:

1. A single grep can serve as both target list and scope-boundary citation.
2. `export { ... }` re-export blocks are invisible to leading-`^export` greps.
3. The "regression test per behaviour change" rule needs an explicit
   refactor-shape exemption that still leaves a citable artifact.

This is docs-only refinement; no code is touched.

## Acceptance Criteria

1. `### Exhaustive occurrence search` (currently anchored at `## Planning`,
   line ~43) gains a paragraph describing the
   single-grep-double-duty workflow: the same `grep -n <token> <files>` that
   enumerates targets also catalogs nearby out-of-scope hits, and the
   disposition list in the plan is the natural place to record the boundary
   decision so it answers "why didn't you also touch line N?" without a
   separate audit pass.
2. The same section gains a `**Boundary.**`-style paragraph (or a short
   adjacent sub-section) explaining that `^export function` /
   `^export const` greps miss `export { ... }` re-export blocks. The
   broader pattern (`export[[:space:]]*\{` or equivalent) is required when
   verifying public exposure of a symbol. The paragraph cites
   `src/adapters/tmux-adapter.ts`'s tail-of-file `export { ... }` block as
   the worked example (it re-exports `readTmuxSlotState`,
   `writeTmuxSlotState`, `agentPortRole`, `removeTmuxSlotState` alongside
   the adapter object's members) and links to gh-ludics-406 as the
   sibling regex-shape limitation tracked elsewhere.
3. `### Regression test per behaviour change` (currently anchored at
   `## Coding`, line ~101) has its `**When not to apply.**` paragraph
   (line ~114) sharpened: a pure refactor still owes the plan one citation
   — the name of the existing test that already covers the touched call
   sites — so the no-new-test decision leaves a load-bearing artifact
   reviewers can point to.
4. New material follows the doc's existing voice and template:
   imperative-with-justification, `**Principle.** / **Why.** /
   (optional worked example) / **Boundary.** or **When not to apply.**`,
   no second-person "you should." `See also` links are added where the
   linkage is natural (item 2 → gh-ludics-406; item 3 stays scoped to
   the existing `negative-case-regression-testing` pointer).
5. The doc remains structurally coherent: net growth is bounded
   (ballpark ≤40 lines), section ordering and existing anchors are
   preserved, and the new material does not relitigate
   `### Symbol-name references` (which addresses how to cite symbols,
   not how to enumerate them).

## Context

- **Target document.** `docs/orchestration-patterns.md` (545 lines as of
  this proposal). Section template is consistent across the file: a
  `**Principle.**` paragraph, `**Why.**` paragraph, an optional worked
  example, and a `**Boundary.**` or `**When not to apply.**` paragraph,
  optionally followed by `See also` links.
- **Item 1 + 2 placement target.** `### Exhaustive occurrence search`
  under `## Planning`. Its existing `**Boundary.**` paragraph already
  notes that primitive-name collisions break the sweep; the new material
  extends the same theme — first by reading the same grep output for two
  purposes (target list and scope justification), then by surfacing a
  failure mode in the grep itself (re-export blocks invisible to
  `^export` patterns).
- **Item 3 placement target.** `### Regression test per behaviour change`
  under `## Coding`. Its existing `**When not to apply.**` paragraph
  already states that pure refactors don't need a new regression test;
  item 3 sharpens it with the missing load-bearing artifact ("name the
  existing test that already covers the call sites").
- **Concrete evidence for item 2.** `src/adapters/tmux-adapter.ts`'s
  final two non-blank lines:

  ```
  const adapter = { readState, start, stop, lastActivity } satisfies Adapter;

  export { readState, start, stop, lastActivity, readTmuxSlotState, writeTmuxSlotState, removeTmuxSlotState, agentPortRole };
  ```

  A `^export function readTmuxSlotState` grep returns nothing here even
  though the symbol is publicly exported; a broader `export[[:space:]]*\{`
  grep is required.
- **Cross-reference family.** gh-ludics-406 ("lint scripts that
  regex-extract symbol references break silently on DRY refactors") is
  the same family of regex-shape blind-spot failure but on the
  consumer side; cite it as `See also` from item 2.
- **Source retrospective.** `task-1f04f963`'s
  `suggestRefactorSummary` items 1 (single-grep-for-targets-and-scope),
  4 (export-block visibility), and 3 (refactor-shape exemption). Items 2,
  5, 6 from the same retrospective were classified informational/
  no-action and are out of scope.
- **Sibling polish proposals already drafted.** `task-3a29f3fb`
  (defense-in-depth recovery), `task-bf451303` (`buildHandlers` factory),
  `task-41b91ca3` (util shadows + lint) — these touch code, this
  proposal does not, so there is no overlap.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The following layout keeps the doc's section count flat (no new
top-level sub-sections) while still giving each item the room its
worked example deserves.

1. **Item 1 — single-grep-double-duty.** Append one paragraph to
   `### Exhaustive occurrence search`, immediately after the existing
   `**When `skip with reason` is appropriate.**` paragraph, with a
   header marker like `**Single grep, double duty.**`. Keep it tight
   (3–5 sentences): one sentence stating the workflow, one explaining
   why the disposition list already captures it, one noting it
   pre-empts the "why didn't you touch line N?" review question. No
   worked example needed — the existing
   `## Occurrence sweep — extractMagPaths` block already demonstrates
   the disposition list shape.

2. **Item 2 — re-export visibility.** Insert a new paragraph
   immediately after `**Boundary.**` (line ~62), with a header marker
   like `**The grep itself can lie.**`. Structure:
   - Failure mode in one sentence: `^export function` /
     `^export const` patterns miss `export { ... }` re-export blocks.
   - Worked-example sentence pointing to
     `src/adapters/tmux-adapter.ts`'s trailing `export { ... }` line
     (cite by file + "trailing `export {...}` block", not by line
     number — line numbers drift).
   - Remediation: use `export[[:space:]]*\{` (or the ripgrep
     equivalent) in addition to leading-`export` patterns when
     verifying that a symbol is publicly exposed.
   - Closing `See also` line: link to gh-ludics-406 as the sibling
     regex-shape failure on the consumer side.

3. **Item 3 — refactor-shape exemption.** In-place edit of the
   existing `**When not to apply.**` paragraph in
   `### Regression test per behaviour change`. Append one sentence:
   the no-new-test decision still owes the plan a citation — the name
   of the existing test (or test file) that already covers the
   touched call sites — so the refactor case leaves a reviewable
   artifact instead of a silent skip. No new section, no extra
   `See also`.

4. **Voice and surface budget.** Keep imperative-with-justification.
   Use existing punctuation conventions (em-dashes, backticks for
   code identifiers, `**Bold.**` paragraph markers). Net growth
   target: roughly 25–35 lines across the three edits.

5. **Verification.** Run a `bun run build` to confirm nothing in the
   doc-link checking pipeline trips on the new anchors / cross-refs
   (the doc itself is plain markdown but the harness lints anchor
   references in some skill files).

## Scope

- **In scope.** Edits to `docs/orchestration-patterns.md` only.
- **Out of scope.** Code changes; touching gh-ludics-406's lint
  scripts; revisiting the items 2/5/6 of `task-1f04f963`'s
  retrospective that the elaboration classified as no-action;
  reorganizing existing sub-sections beyond the targeted insertions.
- **Dependencies.** None. The sibling proposals (`task-3a29f3fb`,
  `task-bf451303`, `task-41b91ca3`) are independent — this proposal
  can land before, after, or interleaved with them without conflict.
