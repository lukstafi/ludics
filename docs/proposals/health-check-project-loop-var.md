# Green lint:skill-shell — bind `$project` in the ludics-health-check annotation block

## Goal

`bun run lint:skill-shell` exits 1 on the live corpus because of a single
undefined shell-variable reference: `skills/ludics-health-check.md:169` uses
`$project` inside the `outbound-cause-remedy` annotation block, but the loop
that conceptually binds `project` lives only in the step's prose, not inside
any fenced shell body. The linter (correctly) scans fenced shell bodies for
references that resolve to in-file assignments or `HARNESS_INHERITED` names,
finds `$project` unbound, and flags it.

This non-zero exit fails two pinned live-corpus tests in
`scripts/lint-skill-shell.test.ts`:

- `live corpus > running the lint over the live in-scope files yields zero violations`
- `CLI exit code > happy path: spawning the script against the real corpus exits 0`

The fix is a presentational/structural edit to the documented bash so the
reference is self-contained; the health-check skill's runtime behaviour is
unchanged. The linter itself is behaving correctly and needs no change.

## Acceptance Criteria

- [ ] `bun run lint:skill-shell` exits 0 against the live `ludics` corpus
      (zero violations) — verified by running the full lint, not a grep.
- [ ] `bun test scripts/lint-skill-shell.test.ts` is fully green, including
      the two previously-failing pinned tests
      (`live corpus > … yields zero violations` and
      `CLI exit code > happy path: … exits 0`).
- [ ] `$project` in the `outbound-cause-remedy` annotation block of
      `skills/ludics-health-check.md` (step `check-outbound-staging-ff`) is
      resolvable within a fenced shell body — i.e. bound by a `for project in
      …; do … done` loop (or otherwise assigned) inside the fence where it is
      referenced, per the linter's `FOR_RE` / per-file assignment-pooling
      rules.
- [ ] `scripts/lint-skill-shell.ts` is **not** modified — the linter correctly
      flags a genuinely-unbound reference, and `project` is a skill-local loop
      index, not a harness-provided name (so it does not belong in
      `HARNESS_INHERITED`).
- [ ] The health-check skill's documented runtime behaviour is unchanged: the
      annotation still invokes `ludics mag outbound-cause-remedy "$project"`
      per opted-in project and folds the `auth` / `no-attempts` /
      `blocked-worktree` cause-remedy text into `finding_text`; only the
      structural framing changes.
- [ ] The rendered Markdown remains valid: the fenced block stays a
      well-formed ` ```bash ` block with consistent `do … done` indentation
      under its list item, and the step reads unambiguously (no implication of
      two distinct project lookups — see Scope).

## Context

How things work now:

- **`skills/ludics-health-check.md`**, step `check-outbound-staging-ff`
  (marker `<!-- section:check-outbound-staging-ff -->`, labelled "3b"). The
  step's prose says "For each project in `config.yaml` with
  `outbound_sync_enabled: true`…", which introduces the loop variable
  conceptually. The **annotation** fenced block (opening with
  `annotation=$(ludics mag outbound-cause-remedy "$project" 2>/dev/null || echo
  '{"kind":"unknown"}')` and closing after the `if … elif … fi` cascade)
  references `$project`, but nothing inside the fence binds it. `$kind`,
  `$cause`, `$remedy`, `$finding_text`, and `$annotation` are all assigned
  inside the same block, so `$project` is the only unbound reference.
- A **separate** "Example yq lookup" fenced block at the end of the same step
  shows the actual opted-in-project enumeration:
  `yq eval '.projects[] | select(.outbound_sync_enabled == true) | .name'
  "$LUDICS_STATE_PATH/config.yaml"`. This is the loop source the prose
  describes, sitting below the annotation block rather than wrapping it.
- **`scripts/lint-skill-shell.ts`** — the linter. `extractAssignmentsFromLine`
  collects bound names per line via `BARE_ASSIGN_RE`, `FOR_RE`
  (`/\bfor\s+(NAME)\b\s+in\b/`), `READ_RE`, and `PARAM_ASSIGN_RE`;
  `extractAssignments` unions these across **all** fenced shell lines in the
  file (per-file assignment pool). A reference is a violation only if its bare
  name is neither in that pool nor in `HARNESS_INHERITED` (a
  `ReadonlySet<string>` whose entries each carry a comment naming the harness
  path that sets them).
- **`scripts/lint-skill-shell.test.ts`** — pins the two failing live-corpus
  tests (`describe("live corpus", …)` and the `happy path` CLI-exit-code
  smoke).

Reproduced on `ludics` main (HEAD `889dd79`): `bun run lint:skill-shell` exits
1 with exactly one violation — `skills/ludics-health-check.md:169 $project`.
No other prose/fence-boundary variable leaks.

This is distinct from `docs/proposals/lint-skill-shell-vars.md`, which proposed
*creating* the `lint:skill-shell` script. This task fixes the one live-corpus
violation that script now surfaces.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Wrap the annotation snippet in the `for project in …; do … done` loop the prose
already describes, sourcing the project list from the same `yq` expression the
"Example yq lookup" block uses:

```bash
for project in $(yq eval '.projects[] | select(.outbound_sync_enabled == true) | .name' "$LUDICS_STATE_PATH/config.yaml"); do
  annotation=$(ludics mag outbound-cause-remedy "$project" 2>/dev/null || echo '{"kind":"unknown"}')
  # … existing kind / cause / remedy / finding_text cascade, unchanged …
done
```

Because `FOR_RE` binds the loop variable and `extractAssignments` pools names
across the whole file, the `for project in` token drives the violation count to
zero. This is also the most faithful rendering of how the step actually runs
(the annotation is genuinely per-project).

Since the loop now contains the `yq` lookup, fold or relabel the now-redundant
standalone "Example yq lookup" block so the step does not imply two different
project enumerations. After the edit, re-run the **full** lint and
`bun test scripts/lint-skill-shell.test.ts` to confirm both go green.

## Scope

In scope:

- `skills/ludics-health-check.md` — the structural edit to the
  `check-outbound-staging-ff` annotation block (and folding/relabelling the
  redundant standalone yq-lookup example).

Out of scope:

- Any change to `scripts/lint-skill-shell.ts` — the linter is correct;
  `project` is a loop-local index, not a harness-inherited name, and must not
  be added to `HARNESS_INHERITED`.
- Any change to the health-check skill's runtime behaviour or to the
  `outbound-cause-remedy` subcommand.
- The `scripts/lint-skill-shell.test.ts` pins themselves — they already assert
  the desired green state; no new test cases are required for this fix beyond
  confirming the existing two go green.

Dependencies: none blocking. Relates to `task-cabf6402` (the source
retrospective) and to the prior `lint-skill-shell-vars.md` proposal that
introduced the linter, but does not depend on any unmerged work.
