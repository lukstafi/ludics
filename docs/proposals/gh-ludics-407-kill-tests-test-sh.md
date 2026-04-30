# Kill `tests/test.sh`, replace with bun-native lint and smoke scripts

## Goal

Resolve [#407](https://github.com/lukstafi/ludics/issues/407): remove
`tests/test.sh` so that `bun test` becomes the unambiguous canonical command
for "tests pass" AC evidence in the ludics repo. The current script silently
fails on macOS system bash (3.2) at the `${var,,}` lowercase expansion on
line 102, which makes it unreliable as evidence and confused a reviewer in
the round-1 retrospective for `task-fc8f0e2b`.

The legitimate coverage that `tests/test.sh` provides today (hook-script
shellcheck, compiled-binary smoke, `contentFingerprint` parity, `queue-hold`
sentinel idempotency) must move to `bun test` / `package.json` scripts so no
coverage is dropped.

## Acceptance Criteria

1. `tests/test.sh` is deleted from the repo.
2. The `tests/` directory is removed if empty after deletion (or kept only
   if a TypeScript suite is later placed there — neither is required by
   this task).
3. `package.json` `scripts` has a new entry `lint:hooks` that runs
   `shellcheck` over `templates/hooks/*.sh` (using the same flags the
   bash script uses today: `-P "$root_dir" -x -S warning`). `lint:hooks`
   gracefully skips with a clear non-error message when `shellcheck` is not
   on `PATH` (matching the current bash behaviour: `skipped` does not
   fail the run).
4. `package.json` `scripts` has a new entry `smoke` that:
   - runs `bun run build` (builds the compiled `bin/ludics` binary), and
   - executes the same three CLI smoke checks that `tests/test.sh` runs
     today: `bin/ludics help` exits 0 and prints `Usage:`, `bin/ludics
     doctor` exits with `Health Check` in output, and `bin/ludics
     this-does-not-exist` exits non-zero.
   The smoke target may be a single shell one-liner in `package.json` or a
   small `scripts/smoke.ts` invoked via `bun run`. Either form is acceptable;
   it must work on macOS system bash (3.2) without `bash 4+` features.
5. `bun test` covers the `contentFingerprint` behaviours that
   `tests/test.sh` covers today (8-char hex format, case-insensitivity,
   whitespace normalization, punctuation stripping, distinct inputs →
   distinct outputs). Since `contentFingerprint` is now a TypeScript
   function in `src/tasks/sync.ts`, these tests live in `src/tasks/sync.test.ts`
   (or a new `src/tasks/fingerprint.test.ts` co-located file).
6. `bun test` covers the `queue-hold` sentinel idempotency behaviours
   currently exercised by the bash script: `mkdirSync({recursive: true})`
   is idempotent against a pre-existing `mag/` and works against a fresh
   harness with no `mag/` dir. These can land near the existing
   queue-hold call sites in `src/dashboard-server.ts`, `src/mag.ts`,
   `src/dashboard.ts`, or `src/index.ts` — wherever the sentinel write/read
   logic lives — in a co-located `*.test.ts`.
7. `AGENTS_STAGING.md:78-81` ("Smoke Test Precondition and Pipefail
   Gotcha") is updated to remove the reference to `tests/test.sh` and
   point at the new `bun run smoke` (and/or `bun run lint:hooks`) targets.
   Preserve the "build first" lesson — the reformulation is "`bun run
   smoke` does the build for you" or equivalent.
8. `CHANGELOG.md:363` (the historical "Test script — Added `tests/test.sh`"
   entry) is left intact (it is history); no need to edit it. A new
   CHANGELOG entry under the current unreleased section describes the
   removal and replacements.
9. After the change, running `grep -rn "tests/test.sh\|bash tests/test"
   --include="*.md" --include="*.ts" --include="*.json" --include="*.sh"`
   over the repo (excluding `node_modules`, `CHANGELOG.md`, and
   `docs/proposals/`) returns no matches. `docs/proposals/` is excluded
   because the proposal file itself is a historical artefact that
   references `tests/test.sh` in its inventory and approach; preserving
   the proposal as provenance (the established repo convention) is
   compatible with removing all *live* references to the bash script.
10. `bun run lint:hooks` and `bun run smoke` both exit 0 on `main` post-merge
    (verified by the implementing PR's evidence section).
11. `bun test` post-merge produces a strictly greater number of expectations
    than before this change (the migrated `contentFingerprint` and
    `queue-hold` tests are net-new TS expectations) and introduces no new
    test failures relative to the `main` baseline at the merge base.
    Pre-existing failures (e.g., the `PROPOSAL_FRESHNESS_WARNING: boundary —
    exactly 10 commits does NOT trigger` test from gh-ludics-311 territory)
    are cited via a same-line cross-check
    (`git show <base>:<file> | sed -n '<lineno>p'`) showing the failing
    line is unchanged on `main`. This avoids the `feedback_state_resilience`
    trap of assuming a clean `bun test` baseline that does not exist.

### Out of scope (explicit non-goals)

- **No changes to `docs/orchestration-patterns.md` or any skill template
  in `skills/orchestration/`.** Per the task elaboration's resolved Q2:
  the orchestration prompts are reused across projects (OCaml `dune test`,
  etc.); encoding `bun test` into them is wrong. The "AC tests pass
  evidence" rule belongs in project-local context if anywhere, not the
  cross-project orchestration layer.
- **No changes to `CLAUDE.md`** to encode "use `bun test` for AC evidence".
  The repo's only `tests/` artefact has been the bash script; once it is
  gone, `bun test` is the only command the codebase ships, which is itself
  the rule.
- **Same-line cross-check pattern** (`git show <base>:<file> | sed -n
  '<lineno>p'` to prove a tool failure is base-line, not PR-introduced):
  per resolved Q3, this pattern is *not* getting a docs entry in this
  task and is not getting a follow-up issue either. If a natural code
  home appears during implementation (e.g., a comment in `lint:hooks`
  or a reviewer-tool script), drop a one-line note there; otherwise drop.
- **No new `tests/` TypeScript directory** is required. Bun discovers
  `*.test.ts` anywhere under `src/`, so co-located tests are the
  established pattern. Don't move existing `*.test.ts` files.

## Context

### What `tests/test.sh` does today (214 lines)

Single file at `tests/test.sh`. Five sections:

1. **Bash version self-check** (lines 38-45): `fail()`s with "Bash 4+
   required; macOS system bash is too old" when `BASH_VERSINFO[0] < 4`.
   Note: `fail()` only increments a counter — it does not `exit`, so
   execution continues and crashes later under `set -euo pipefail` at
   the first bash-4-only construct (line 102, `${text,,}`).
2. **shellcheck on hook templates** (lines 47-66): runs `shellcheck -P
   "$root_dir" -x -S warning` over each script in
   `templates/hooks/*.sh`. Skipped if `shellcheck` is not installed.
3. **CLI smoke** (lines 68-93): three checks against the compiled
   `bin/ludics` binary — `help`, `doctor`, and an unknown-command
   negative test.
4. **`content_fingerprint` smoke** (lines 95-152): inlines the
   fingerprint function and tests format (8-char hex), case-insensitivity,
   whitespace, punctuation-stripping, and distinctness.
5. **`queue-hold` sentinel idempotency** (lines 154-205): exercises
   `mkdir -p mag/ && touch mag/queue-hold` cycles to verify the
   `mkdirSync({recursive: true})` fix works for both pre-existing and
   fresh `mag/` directories.

### Where the replacement coverage lives

- Hook shellcheck → new `package.json` `scripts.lint:hooks`. The
  `templates/hooks/` directory currently contains a single file
  (`ludics-on-stop.sh`) but the lint should glob `templates/hooks/*.sh`
  to stay forward-compatible.
- Compiled-binary smoke → new `package.json` `scripts.smoke`. Reuses the
  three checks 1:1 from the existing script.
- `contentFingerprint` smoke → new TS test against the function in
  `src/tasks/sync.ts:18` (function `contentFingerprint`, exported
  from line 916). The function's behaviour matrix is identical between
  the bash inline and the TS implementation; the test asserts the same
  five properties.
- `queue-hold` idempotency → new TS test near the sentinel write logic.
  Sources: `src/dashboard-server.ts`, `src/mag.ts`, `src/dashboard.ts`,
  `src/index.ts` all reference `queue-hold`. The implementer chooses
  the natural co-location.

### Cross-references

- `AGENTS_STAGING.md:80` is the only non-CHANGELOG reference to
  `tests/test.sh` in the repo (verified via grep over `*.md`, `*.ts`,
  `*.json`, `*.sh` with `node_modules` excluded).
- `package.json` `scripts` block (lines 5-17 of `package.json`): contains
  `build`, `typecheck`, `dev`, `lint`, `lint:fix`, and five `lint:*`
  targets. The new `lint:hooks` and `smoke` entries slot in alongside
  these — keep the existing alphabetical-within-prefix grouping.

### Why not just patch line 102?

The retrospective's round-2 fix already established that `bun test` is the
authoritative gate command. The script's *legitimate* coverage (hook
shellcheck, compiled-binary smoke) is shellcheck and three CLI invocations
— ~20 lines of new bun config plus two TS test files. Removing the
script eliminates a recurring trap (bash-3.2 incompatibility) and the
ambiguity ("which command counts as 'tests pass' evidence") in one move,
without losing coverage. The user explicitly chose option (c) over option
(a) (patch + canonize).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add a TS test for `contentFingerprint` covering the five existing
   bash assertions. Run `bun test` to confirm green.
2. Add a TS test for the `queue-hold` `mkdirSync` idempotency near the
   sentinel write site. Run `bun test` to confirm green.
3. Add `lint:hooks` and `smoke` entries to `package.json` `scripts`.
   Pick whichever form (inline shell vs. `scripts/*.ts`) is more
   readable; both forms exist already in the repo (`lint:no-mock-module`
   is inline; `lint:cli-readme` etc. are TS).
4. Run `bun run lint:hooks` and `bun run smoke` locally to confirm both
   pass.
5. Update `AGENTS_STAGING.md` lines 78-81 to point at the new commands.
6. Add a CHANGELOG entry under the current unreleased section describing
   the removal of `tests/test.sh` and the replacement targets.
7. Delete `tests/test.sh`. Delete `tests/` if it ends up empty.
8. Final verification: full `bun test` run + `bun run lint:hooks` + `bun
   run smoke` + the grep check from AC #9. Cite all four in the PR's AC
   evidence.

## Scope

**In scope:**
- Deletion of `tests/test.sh` and (if empty) `tests/`.
- New `package.json` scripts: `lint:hooks`, `smoke`.
- New TS tests covering `contentFingerprint` and `queue-hold` sentinel
  idempotency.
- Update to `AGENTS_STAGING.md:78-81`.
- New CHANGELOG entry under the current unreleased section.

**Out of scope (per resolved questions):**
- Any change to `docs/orchestration-patterns.md`.
- Any change to `skills/orchestration/*.md`.
- Any change to `CLAUDE.md` to encode the AC-evidence rule.
- A standalone "same-line cross-check" docs entry or follow-up issue.

**Dependencies:** None. This task is independent of the other 2026-04-25
workflow-feedback wave issues (#404, #405, #406, #408, #409, #410, #411).
