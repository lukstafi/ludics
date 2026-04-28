# Pattern+count enumeration for bulk migrations

## Goal

Document `pattern+count` enumeration as the primary discipline for proposing
bulk migrations in `docs/orchestration-patterns.md`, with the `replace_all`
opportunity heuristic folded in as the closing tactical paragraph of the same
entry. The new entry replaces the line-range proposal style (e.g. "12 sites in
lines 241–565") which drifts under rebase and is not mechanically verifiable —
a reviewer or worker can re-run `grep -c '<exact-pattern>' <path>` and compare
to the proposal's stated count, but cannot cross-check a stale line range.

Follow-up to retrospective items 2 and 3 from `task-95310454` (the dashboard
console-silence migration). Single combined entry with reciprocal `See also`
back-links from the two existing sibling entries (`### Exhaustive occurrence
search`, `### Post-edit occurrence recheck`).

## Acceptance Criteria

- [ ] A new `### Pattern+count enumeration for bulk migrations` entry exists
  in `docs/orchestration-patterns.md`, structured `**Principle.**` /
  `**Why.**` / `**Recipe.**` / `**Worked example.**` / `**Boundary.**` /
  `See also`. It is a single combined entry — the `replace_all` heuristic
  appears as the closing paragraph (or as part of `**Recipe.**`), not as its
  own `###` heading.
- [ ] The entry is placed under `## Planning`, immediately after
  `### Exhaustive occurrence search`, so the two enumeration entries are
  adjacent (pattern+count is the durable form of enumeration the existing
  entry already advocates).
- [ ] The worked example cites `task-95310454`'s dashboard console-silence
  migration concretely: 12 of 13 sites collapsed in one
  `Edit { replace_all: true }` because the inline pattern was character-
  identical, and the 13th site at the `startDashboardServer` wrapper
  (~line 615) sat outside the originally-proposed line range (241–565)
  but would have been visible at proposal-write time via
  `grep -c '<exact-pattern>' src/dashboard.ts = 13`.
- [ ] The `replace_all` paragraph carries the boundary caveat: only safe when
  the pattern is character-identical (same whitespace, same surrounding
  context); whitespace/indentation drift defeats `replace_all`. Verification
  recipe is "if `grep -c` confirms the count matches the identical-pattern
  hypothesis, `replace_all` is safe; iterate site-by-site on the residue."
- [ ] The entry's `See also` line links back to
  [exhaustive-occurrence-search](#exhaustive-occurrence-search) and
  [post-edit-occurrence-recheck](#post-edit-occurrence-recheck). All three
  slugs resolve mutually within the file.
- [ ] The new heading slug is unique within the file. Slug:
  `#pattern-count-enumeration-for-bulk-migrations` (GitHub-default lowercase
  + hyphen, with `+` collapsed to `-`). Verify on a render before locking;
  if GitHub's slugger drops the `+` rather than substituting `-`, adjust
  the back-links to the actual rendered slug.
- [ ] `### Exhaustive occurrence search` gains a new `See also
  [pattern-count-enumeration-for-bulk-migrations]` line (appended to or
  next to its existing `See also` cross-link).
- [ ] `### Post-edit occurrence recheck` gains a new `See also
  [pattern-count-enumeration-for-bulk-migrations]` line, in addition to
  its existing `See also [exhaustive-occurrence-search]` link.
- [ ] No other entries in `docs/orchestration-patterns.md` are reorganised or
  reworded; no other docs files are touched; no skill-template edits.

## Context

Two coupled disciplines surfaced from the `task-95310454` retrospective:

1. *Pattern+count enumeration* — express the site set of a bulk migration as
   `grep -c '<exact-pattern>' <path> = N`, not as a line range. Pattern+count
   is rebase-stable (line numbers drift the moment any unrelated PR lands;
   exact-string counts don't) and mechanically verifiable (a reviewer can
   re-run the grep and compare to the stated count without a visual scan).
2. *`replace_all` opportunity* — when the exact pattern that drives the
   enumeration is character-identical across all (or most) sites, a single
   `Edit { replace_all: true }` collapses N edits into one operation. The
   residue iterates site-by-site.

The user's elaboration decisions pin the shape:

- **One combined entry**, not two siblings (the `replace_all` heuristic is
  motivationally inseparable from pattern+count — the same exact-pattern grep
  that *enumerates* the sites is the one that *qualifies* them for
  `replace_all`).
- **Reciprocal `See also` back-links** from the two existing sibling entries.
  Adding a one-line cross-link from each costs little and improves
  discoverability for a reader who lands on either of those entries first.

Note: gh-ludics-404 (PR #417) recently landed two new entries under
`## Coding` (`### Pre-assertion harness probe`, `### Harness instantiation`),
so the patterns-doc table-of-contents and surrounding entries have shifted.
This proposal's placement (under `## Planning`, adjacent to
`### Exhaustive occurrence search`) is unaffected by that drift.

## Approach

Concrete since this is a mechanical doc edit.

### Heading and slug

- Heading: `### Pattern+count enumeration for bulk migrations`.
- Expected slug: `#pattern-count-enumeration-for-bulk-migrations`. GitHub's
  default markdown slugger lowercases, replaces spaces with hyphens, and
  drops most punctuation; the `+` typically collapses to a hyphen. Verify on
  a render before locking the back-link anchors. If the rendered slug
  differs (e.g. `+` is dropped entirely producing
  `patterncount-enumeration-for-bulk-migrations`), update the back-links to
  match the actual slug. Fall back to a heading rewrite (e.g. `### Pattern
  and count enumeration for bulk migrations`) only if the slugger produces
  something genuinely unstable.

### Insertion point

Under `## Planning`, immediately after `### Exhaustive occurrence search`
(currently followed by `### Data-shape consumer sweep`). The two enumeration
entries become adjacent, which reads cleanly: exhaustive-occurrence-search
states *enumerate every site*; pattern+count states *how to express that
enumeration durably*.

### Entry body sketch

About 14–20 lines, matching the surrounding `**Principle.**` /
`**Why.**` / `**Recipe.**` / `**Worked example.**` / `**Boundary.**` /
`See also` register.

- **Principle.** When a bulk migration touches more than a handful of
  sites, express the site set as `grep -c '<exact-pattern>' <path> = N` in
  the proposal, not as a line range.

- **Why.** Pattern+count is rebase-stable — exact-string counts survive
  unrelated commits the way line ranges don't — and mechanically
  verifiable: a reviewer or worker can re-run the same grep and compare to
  the proposal's stated count without a visual scan. A line-range
  proposal can match the stated bound and still miss sites that fall
  outside it; pattern+count cannot.

- **Recipe.**
  1. Pick the exact pattern that defines a site (the inline call shape,
     the regex, the string literal — whatever is character-identical
     across the cohort).
  2. Record `grep -c '<pattern>' <path> = N` in the proposal, not a line
     range. If the migration spans multiple files, list one
     `grep -c` per file with its expected count.
  3. At edit time, re-run the grep and confirm the count matches the
     proposal before starting. If it doesn't, the pattern set has drifted
     since the proposal — pause and reconcile.

- **Worked example.** `task-95310454`'s dashboard console-silence migration.
  The original proposal said "12 sites in lines 241–565". The actual count
  was 13: a 13th site at the `startDashboardServer` wrapper (~line 615) sat
  outside the proposed line range and was caught only on a thorough sweep.
  A pattern+count enumeration —
  `grep -c 'originalConsoleX(\.\.\.args)' src/dashboard.ts = 13` — would
  have surfaced the 13th site at proposal-write time, before any edit was
  attempted.

- **`replace_all` opportunity (closing paragraph).** When the exact
  pattern is character-identical across all sites — same whitespace, same
  surrounding context — a single `Edit { replace_all: true }` collapses
  the migration into one operation; iterate site-by-site only on the
  residue. In the dashboard example, 12 of the 13 sites collapsed this
  way. Caveat: `replace_all` is only safe under exact-pattern identity
  verified by `grep -c`. Whitespace or indentation drift defeats the
  match; subtle context differences (a different surrounding helper, an
  alternative cast) usually mean the cohort needs splitting into
  `grep -c` sub-counts before any `replace_all` is attempted.

- **Boundary.** Pattern+count earns its keep on bulk migrations (≥3
  sites). For 1–2 site changes, line refs (or symbol-name references —
  see [symbol-name-references](#symbol-name-references)) are still fine
  and shorter. `replace_all` is only safe under exact-pattern identity
  verified by `grep -c`.

- **See also** [exhaustive-occurrence-search](#exhaustive-occurrence-search),
  [post-edit-occurrence-recheck](#post-edit-occurrence-recheck).

### Reciprocal back-links

Two one-line edits.

- `### Exhaustive occurrence search` currently ends with: `See also
  [post-edit-occurrence-recheck](#post-edit-occurrence-recheck) for running
  the same sweep *after* the edit, and in both directions (forward and
  inverse).` Append (or follow with a second `See also` line):
  `See also [pattern-count-enumeration-for-bulk-migrations](#pattern-count-enumeration-for-bulk-migrations)
  for the durable form of the site enumeration this entry advocates.`

- `### Post-edit occurrence recheck` currently ends with: `See also
  [exhaustive-occurrence-search](#exhaustive-occurrence-search).` Add a
  second line: `See also
  [pattern-count-enumeration-for-bulk-migrations](#pattern-count-enumeration-for-bulk-migrations)
  for the proposal-time enumeration that drives the post-edit recheck.`

Worker picks final wording. The two-line back-links are short and
discoverability-flavoured; the prose only needs to gesture at the relation,
not duplicate the new entry.

## Out of Scope

- Skill-template edits. `skills/worker-conventions.md` is a structural /
  protocol doc (argument parsing, response format, error handling), not the
  right home for tactical migration guidance. The patterns doc is the
  established repository.
- Reorganisation of any other entries in
  `docs/orchestration-patterns.md` — only the two reciprocal `See also`
  lines are touched on existing entries.
- Any code or test changes. This is a doc-only proposal.
- The PR-bundling decision for the workflow-meta cluster
  (task-ff2dc368, task-6a80b0ff, task-b2190ba9, gh-ludics-404/405/406/411,
  this task) — orthogonal to elaboration; the user decides at launch time.

## Verification

- The doc reads coherently end-to-end after the edits — the new entry's
  voice matches the surrounding `**Principle.**`/`**Why.**`/`**Recipe.**`/
  `**Worked example.**`/`**Boundary.**`/`See also` register.
- All three slugs resolve mutually:
  - `#pattern-count-enumeration-for-bulk-migrations` resolves from both
    `### Exhaustive occurrence search` and `### Post-edit occurrence
    recheck`.
  - `#exhaustive-occurrence-search` resolves from the new entry.
  - `#post-edit-occurrence-recheck` resolves from the new entry.
- The `lint:doc-links` check (or equivalent slug-resolution lint, if the
  repo carries one) passes against the edited file. If no automated lint
  exists, the worker spot-checks each `See also` link by clicking through
  on a GitHub render of the file.
- No duplicate `###` headings exist after the edit (a `grep -c '^### '`
  before/after diff confirms exactly one new heading was added).
