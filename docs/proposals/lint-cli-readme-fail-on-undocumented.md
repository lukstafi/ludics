# Make `lint:cli-readme` fail on undocumented USAGE entries

## Goal

The `lint:cli-readme` script in this repository checks documentation drift in
*both* directions — README's `## CLI Reference` vs. USAGE in
`src/index.ts` — but it only **fails** in the "stale" direction (README cites a
command that USAGE doesn't have). The reverse direction ("undocumented" — USAGE
has a command that README doesn't list) currently logs a warning and exits
zero. This is a one-directional CI gate masquerading as bidirectional.

The asymmetry just bit task-2db5eca6 / PR #467: a new `ludics tasks priority`
subcommand landed in USAGE without the matching README entry; the lint passed
green; the reviewer caught it manually in round 2. The retrospective suggests
elevating the additive-direction warning to a hard failure so CI catches this
class of drift on the first round.

This proposal makes the script fail with a non-zero exit code when USAGE
contains a top-level subcommand absent from README's `## CLI Reference`,
bringing the additive direction up to the same bar as the stale direction.

Related: derived from retrospective of task-2db5eca6 (PR #467); orthogonal to
task-4101f0d5 (PR #468), whose argv-root override and `spawnSync` test
infrastructure this task reuses.

## Acceptance Criteria

**AC1 — additive direction now fails (the change):**
`bun run scripts/lint-cli-readme.ts <root>` exits with a status code distinct
from zero when `<root>/src/index.ts` USAGE contains a top-level command
absent from `<root>/README.md`'s `## CLI Reference` section.

*Falsifier:* tmp fixture where `src/index.ts` USAGE lists `alpha` and `beta`
but README's `## CLI Reference` lists only `alpha` ⇒ `spawnSync` must observe
`exitCode !== 0`. (Per Clause 4 of the AC verification rigor reference: assert
exit code is *not* zero, not that it equals 1.)

**AC2 — happy path preserved:**
A tmp fixture where `src/index.ts` USAGE and `README.md` `## CLI Reference`
list the same set of top-level subcommands continues to exit 0. The existing
"exits 0 against a tmp fixture where USAGE and README are in sync" test
(`scripts/lint-cli-readme.test.ts`) stays green without modification.

**AC3 — stale direction preserved:**
The existing "exits non-zero when README cites a command not in USAGE" test
stays green without modification. The "stale" detection logic is unchanged.

**AC4 — real repo green at HEAD:**
`bun run lint:cli-readme` against this repo at HEAD exits 0. Because this is a
breaking-semantic change to a CI gate that other PRs depend on, real-repo
greenness is part of acceptance, not a side concern.

## Context

### How the lint works today

`scripts/lint-cli-readme.ts` exposes a pure helper `lintCliReadme(indexSrc,
readmeSrc)` that returns `{ stale, undocumented }`. The CLI entry point
guarded by `if (import.meta.main)` then logs and exits.

**The asymmetric exit branch (the direct target of this change):**

```ts
if (undocumented.length > 0) {
  console.warn(`\n⚠️   USAGE commands not documented in README (undocumented — warnings only):`);
  for (const cmd of undocumented) {
    console.warn(`     - ${cmd}`);
  }
}

if (stale.length === 0 && undocumented.length === 0) {
  console.log("✅  CLI Reference is in sync with USAGE.");
} else if (stale.length === 0) {
  console.log("✅  No stale docs found (some commands are undocumented — see warnings above).");
}

process.exit(stale.length > 0 ? 1 : 0);
```

Three things about this block need to change in lockstep:

1. The `console.warn` for the `undocumented` branch becomes `console.error`
   with a wording that no longer disclaims itself as "warnings only".
2. The dual-success-message branch (the `else if (stale.length === 0)` arm
   that prints `✅ No stale docs found …`) becomes unreachable once
   `undocumented.length > 0` exits non-zero, and should be removed so the
   script doesn't carry dead messaging code.
3. The `process.exit` predicate must include `undocumented.length > 0`.

The file's header docstring (lines 8–11 today) advertises the asymmetric
contract:

```
 * Exit code:
 *   0 — no stale-doc errors (warnings about undocumented commands are non-fatal)
 *   1 — one or more README commands not found in USAGE (documentation drift)
```

This needs to be rewritten to describe the symmetric contract.

The pure function `lintCliReadme` already returns both directions. **No
extractor or diff-computation logic changes** — the change is entirely in the
CLI exit-code wrapper and one log-level swap.

### Test infrastructure already in place

`scripts/lint-cli-readme.test.ts` already has everything needed for the new
AC test:

- `makeFixture(files)` (around the bottom of the file) builds a tmp dir with
  arbitrary `src/index.ts` and `README.md` contents and returns
  `{ root, cleanup }`.
- `FIXTURE_INDEX_SYNCED` and `FIXTURE_README_SYNCED` constants are the synced
  baseline used by the happy-path CLI test.
- The `argv[2]`-as-root override on `lint-cli-readme.ts` (added by
  task-4101f0d5 / PR #468) lets tests drive the real CLI exit-code path:
  `spawnSync(["bun", "run", join(import.meta.dir, "lint-cli-readme.ts"), root])`.
- The existing "exits non-zero when README cites a command not in USAGE
  (drives `import.meta.main`)" test is the exact symmetric template for the
  new test — copy its shape, swap the fixture so README is missing `beta`
  rather than carrying a ghost `ghost`, and assert `exitCode !== 0`.

The unit-level test "reports nothing stale when README ⊆ USAGE" already
asserts `undocumented: ["beta"]` against `lintCliReadme` directly. That test
stays valid because the pure function's return shape doesn't change.

### Real-repo state today (relevant to AC4)

`bun run lint:cli-readme` against the current main today **prints 13
undocumented warnings** and exits 0. Listed: `dashboard`, `t3code`, `tmux`,
`sessions`, `sync`, `state`, `journal`, `events`, `network`, `cluster`,
`queue`, `config`, `quote`. All thirteen are top-level subcommand groups
present in USAGE in `src/index.ts` (lines ~192–257) but missing from
`README.md`'s `## CLI Reference` section.

This means **AC4 cannot be satisfied by the lint-script change alone** —
elevating the warning to a fatal error against the current README would turn
this lint into a CI failure on the first run. The README must gain entries
for these 13 subcommand groups in the same change (or earlier).

The `## CLI Reference` section in `README.md` today documents (in order) Task
management, Flow engine, Slot management, Orchestration, Notifications, Mag,
"Using skills directly" prose, and "Overview and setup". The 13 missing
groups need a home — likely as new subsections (e.g. "Dashboard", "t3code
adapter", "tmux adapter", "Sessions", "State sync", "Journal & events",
"Cluster & network", "Queue control", "Configuration", "Misc").

The lint only cares that the *top-level* subcommand name appears at the start
of a `ludics ` line within the `## CLI Reference` section — it does not check
that every USAGE sub-subcommand is documented. So a single representative
line like `ludics dashboard generate` is enough to silence the lint for the
`dashboard` group, even if other dashboard subcommands aren't repeated.

### Out of scope (don't widen)

- The orthogonal scope question was **answered** by the user during
  elaboration: keep the current contract surface — only the `## CLI
  Reference` section in `README.md` counts. Prose mentions of `ludics <sub>`
  elsewhere (Quick Start, examples, release notes) remain commentary and are
  ignored by `extractCliReferenceSection`. **Do not** change the parser to
  count prose mentions, do not introduce a "loose mode", do not consolidate
  with other lint rules, and do not refactor the regex extractors.
- Documenting every sub-subcommand (e.g. `dashboard generate`, `dashboard
  serve`, `dashboard stop`, `dashboard restart`, `dashboard install`
  individually) is not required by the lint — only the top-level `dashboard`
  needs to appear once. The proposal author's judgement is welcome on how
  exhaustive to make the new sections, but the AC bar is *lint passes*, not
  *every USAGE line is mirrored*.
- task-4101f0d5's broader argv/spawnSync test surface for *other* lint
  scripts is a separate task already merged — don't try to expand that here.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Three concrete, mostly-mechanical changes:

1. **`scripts/lint-cli-readme.ts`** — in the `if (import.meta.main)` block:
   - Change the `undocumented` branch's `console.warn` calls to
     `console.error`, and rewrite the prefix message to no longer say
     "warnings only" (e.g. `❌ USAGE commands not documented in README ## CLI
     Reference:`).
   - Delete the `else if (stale.length === 0) { console.log("✅  No stale
     docs found …") }` arm — it becomes dead code once `undocumented.length
     > 0` exits non-zero.
   - Change `process.exit(stale.length > 0 ? 1 : 0)` to
     `process.exit(stale.length > 0 || undocumented.length > 0 ? 1 : 0)`.
   - Update the file header docstring (lines 8–11) to describe the symmetric
     contract: exit 0 iff USAGE and README's `## CLI Reference` list the same
     set of top-level subcommands; exit non-zero on drift in either
     direction.

2. **`scripts/lint-cli-readme.test.ts`** — in the `describe("CLI integration",
   ...)` block, add one new test that mirrors the existing "exits non-zero
   when README cites a command not in USAGE" test. The fixture has
   `FIXTURE_INDEX_SYNCED` (which lists `alpha` + `beta`) for `src/index.ts`
   but a README CLI Reference section that lists only `alpha`. Assert
   `result.exitCode !== 0` (per Clause 4 — not `=== 1`). The existing
   `FIXTURE_README_SYNCED` is unsuitable; introduce a new fixture constant
   (e.g. `FIXTURE_README_MISSING`) or build it inline like the
   `FIXTURE_README_DRIFT` constant in the existing stale-direction test.

3. **`README.md`** — extend the `## CLI Reference` section with subsections
   covering the 13 currently-undocumented top-level subcommand groups:
   `dashboard`, `t3code`, `tmux`, `sessions`, `sync`, `state`, `journal`,
   `events`, `network`, `cluster`, `queue`, `config`, `quote`. Each
   subsection needs *at least one* `ludics <group> ...` line in a code
   fence to satisfy the lint's `^ludics\s+([a-z][\w-]*)\b` pattern within
   the sliced `## CLI Reference` section. Use the USAGE entries in
   `src/index.ts` (lines ~192–257) as the source of truth for what each
   subcommand does. Keep the documentation factual and concise — match the
   tone of the existing Task management / Flow engine / Slot management
   subsections. Verify by running `bun run lint:cli-readme` locally; it must
   exit 0 with the message `✅  CLI Reference is in sync with USAGE.`

Validation order during implementation:
- Make change (1) first; the existing CLI integration test should now fail
  (real repo has 13 undocumented entries → `bun run lint:cli-readme`
  non-zero), but the unit tests still pass.
- Make change (3) — README updates — until `bun run lint:cli-readme` exits 0.
- Make change (2) — add the new CLI integration test — and run
  `bun test scripts/lint-cli-readme.test.ts` to confirm all four CLI
  integration assertions hold.
- Final gate: `bun test` (full suite) green; `bun run lint:cli-readme` exits
  0 with the all-clean success message.

## Scope

**In scope:**
- Modifications to `scripts/lint-cli-readme.ts` (CLI exit-code branch + header
  docstring).
- A new test in `scripts/lint-cli-readme.test.ts` covering the
  undocumented-direction non-zero exit.
- README.md additions to document the 13 currently-undocumented top-level
  subcommand groups under `## CLI Reference`.

**Out of scope:**
- Any change to the pure function `lintCliReadme` or the extractors
  (`extractUsageBlock`, `extractUsageCommands`, `extractCliReferenceSection`,
  `extractReadmeCommands`).
- Widening the lint's surface to count prose mentions outside `## CLI
  Reference` (user answered: keep current scope).
- Consolidating with other lint rules (`lint-config-reference`,
  `lint-skill-cli-refs`, `lint-template-safety`, etc.).
- Documenting every USAGE sub-subcommand exhaustively in README — only
  enough to satisfy the lint. The proposal author may choose richer
  documentation if they wish, but it's not required by the ACs.
- Unrelated parser improvements (e.g. switching from regex extraction to a
  TypeScript AST walker) — that's gh-ludics-406 territory.

**Dependencies:**
- task-4101f0d5 / PR #468 (already merged) provided the argv-root override
  and `spawnSync` integration test scaffolding this task reuses. No further
  ordering constraints.

**No follow-up tasks expected** unless the README documentation of the 13
new subsections surfaces information drift (e.g. a USAGE entry whose
description is no longer accurate). That's a content concern, not a lint
concern.
