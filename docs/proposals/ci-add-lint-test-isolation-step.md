# Add `lint:test-isolation` step to `.github/workflows/ci.yml`

## Goal

Wire the existing `lint:test-isolation` package script into the GitHub Actions
CI workflow so test-harness-isolation regressions (the gh-ludics-306 class of
bug) actually gate merges to `main`. Today the linter is implemented and
exposed as a `package.json` script but is never invoked by CI — same orphan
`lint:*` rationale that motivated AC9 of parent task `task-41b91ca3`
(see `docs/proposals/lint-test-isolation.md` AC1.18 noting the integration
test ensures the lint passes the day it lands; this proposal closes the loop
by adding the CI gate).

## Acceptance Criteria

1. **Step exists.** `.github/workflows/ci.yml` contains exactly one step
   whose `run:` line is `bun run lint:test-isolation`. A literal
   `grep -c 'bun run lint:test-isolation' .github/workflows/ci.yml` returns
   `1`.

2. **Adjacent placement.** The new step appears immediately after the
   `lint:no-shadow-util` step. Asserted structurally (per
   `docs/proposals/ac-rigor-reference-doc.md` Clauses 4 + 12 — per-element
   structural assertion, not byte-pinned diff equality):
   - The `run: bun run lint:test-isolation` line appears *after* the
     `run: bun run lint:no-shadow-util` line.
   - It appears *before* the `run: bun run lint:vendor-sync` line (which is
     currently the next sibling step).
   - No other `run: bun run lint:*` line lies between
     `lint:no-shadow-util` and `lint:test-isolation`.

3. **Step shape matches sibling cohort.** The new step has both a `name:`
   and a `run:` key, with the `run:` value `bun run lint:test-isolation` and
   a `name:` value following the dominant em-dash convention used by recent
   sibling steps (`Lint — no util.ts function shadows`, `Lint — vendor sync`,
   `Lint — eslint`). Suggested name: `Lint — test isolation`. Asserted by
   parsing the YAML and checking that the step is a dict with the two keys
   above; exact `name:` wording is not byte-pinned.

4. **Lint passes on current `main`.** `bun run lint:test-isolation`
   completes with exit code `0` on a clean checkout of the branch the PR
   merges into. (Verified by the proposer on 2026-04-30: 20 rule-3
   warnings, 0 errors, exit 0 — warnings do not fail CI per the linter's
   `exitCode === 1 iff errorCount > 0` contract.)

## Context

- **Workflow file:** `.github/workflows/ci.yml` — single `build` job on
  `ubuntu-latest`. The relevant region is the contiguous block of `lint:*`
  steps after `Type check` / `Build binary`, currently:
  `lint:cli-readme`, `lint:cli-subcommands`, `lint:skill-cli-refs`,
  `lint:config-reference`, `lint:template-safety`, `lint:no-mock-module`,
  `lint:contracts`, `lint:no-shadow-util`, `lint:vendor-sync`, then the
  aggregate `lint` (eslint).
- **Anchor step (`lint:no-shadow-util`):**

  ```yaml
  - name: Lint — no util.ts function shadows
    run: bun run lint:no-shadow-util
  ```

  Followed directly by the `lint:vendor-sync` step. The new step inserts
  between these two.
- **Script entry:** `package.json` already exposes
  `"lint:test-isolation": "bun run scripts/lint-test-isolation.ts"` as a
  sibling of the other `lint:*` scripts. No package or script changes are
  needed.
- **Sibling step naming convention:** the most recent additions
  (`lint:no-mock-module`, `lint:no-shadow-util`, `lint:vendor-sync`,
  `lint`) use the em-dash form `Lint — <topic>`; matching that style.
- **No matrix, caching, or `if:` conditionals** are used by any existing
  lint step, so the new step needs none either.
- **Local verification (2026-04-30):** `bun run lint:test-isolation` on
  current `main` exits 0 with 20 warnings (all rule-3 transitive-import
  warnings). Adding the step to CI will not turn the build red.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Insert the following stanza into `.github/workflows/ci.yml` immediately
after the `lint:no-shadow-util` step (currently between the
`run: bun run lint:no-shadow-util` line and the
`- name: Lint — vendor sync` line):

```yaml
      - name: Lint — test isolation
        run: bun run lint:test-isolation
```

Indentation matches the sibling steps (six leading spaces for the `-`,
eight for the keys). No other edits to the workflow file or to
`package.json` are required.

## Scope

**In scope:**

- A single new step in `.github/workflows/ci.yml` invoking
  `bun run lint:test-isolation`, placed adjacent to `lint:no-shadow-util`.

**Out of scope:**

- Reordering, renaming, or refactoring any existing lint step.
- Introducing matrices, caches, conditional triggers, or job-level changes
  to the workflow.
- Fixing any lint warnings that the script currently emits (warnings do
  not fail CI; rule-3 warnings on `main` are accepted by design — see
  `docs/proposals/lint-test-isolation.md` § "Severity: warning").
- Changes to `package.json`, `scripts/lint-test-isolation.ts`, or any
  other file outside `.github/workflows/ci.yml`.

### Dependencies

None. Parent task `task-41b91ca3` (PR #459) already shipped the
`lint:no-shadow-util` step that serves as the placement anchor and the
template for this addition.
