# `lint:state-migration` — co-change check for persisted-state shape evolution

## Goal

Two recent PRs (gh-ludics-409, task-3a29f3fb) hit the same failure mode at
review time: a persisted JSON state field changed shape (rename,
scalar→record, additive boolean) without a paired `migrateState()` backfill
or a legacy-fixture test. In-memory `undefined`-tolerance hides the failure
for fields-absent reads but breaks for legacy-on-disk-with-old-shape reads
— in-flight slots upgrading across the PR cold-start their dedup memo or
silently disable a feature flag. The reviewer paragraph in
`skills/orchestration/pair-reviewer-plan-review.md` already gates this case,
but it fires on the second iteration; a CI lint catches it on round one
without per-round prompt-bloat.

This proposal operationalises actions (2) and (3) from
[lukstafi/ludics#479](https://github.com/lukstafi/ludics/issues/479). Action
(1) — coder-side plan template hint — is **abandoned** per user resolution
2026-05-02 (recorded in the task file): extending core skill prompts adds
cognitive load on every round to save a single round-trip; the existing
reviewer-side paragraph plus a mechanical lint plus a memory note already
cover the failure mode.

## Acceptance Criteria

The deliverables split across two repositories. Action (2) lands in
`lukstafi/ludics`; Action (3) is a doc artifact in the harness repo
(`/Users/lukstafi/self-improve/harness/`) and therefore lives outside this
project's PR. The Action (3) AC is verifiable but is **not** part of this
PR's diff — the verifier checks the harness repo path.

### Action (2): `scripts/lint-state-migration.ts` (this PR)

A new lint script and a checked-in shape snapshot enforce that any change
to the field set of an allowlisted persisted-shape type is accompanied by
both a `migrateState()` body diff and a legacy-fixture test diff.

1. **Script lives at `scripts/lint-state-migration.ts`** and mirrors the
   shape of `scripts/lint-vendor-sync.ts`: a `PERSISTED_TYPES` allowlist
   constant, pure check function exported for tests, CLI entry guarded by
   `import.meta.main`, optional positional repo-root arg for tests, named
   `Violation` records with `kind` and `hint`. The literal grep
   `lint-state-migration.ts` resolves to a real file under `scripts/`.
2. **Script is wired up:** `package.json` has a `"lint:state-migration":
   "bun run scripts/lint-state-migration.ts"` entry. `bun run
   lint:state-migration` exits 0 on a clean tree.
3. **`PERSISTED_TYPES` allowlist** is a hard-coded constant naming exactly
   these type/source-file pairs (broad day-one scope per user 2026-05-02 Q4):
   - `OrchestrationState` — `src/orchestration/state.ts`
   - `OrchestrationConfig` — `src/orchestration/state.ts`
   - `SlotData` — `src/slots/types.ts` *(NB: declaration is in
     `types.ts`, not `json.ts`; the task file's "in `src/slots/json.ts`"
     phrasing reflects the consumer file, not the declaration site)*
   - `TmuxSlotState` — `src/adapters/tmux-adapter.ts`
   - `SessionSweepState` — `src/sessions/sweep-state.ts` (mag/session-sweeper-state.json)
   - `CleanupEntry` — `src/orchestration/deferred-cleanup.ts` (mag/cleanup-pending.json)
   - `PreemptStash` — `src/slots/preempt.ts` (mag/preempted/slot-N.json)
   The literal allowlist constant `PERSISTED_TYPES` is grep-able as a
   single declaration; each entry names a `typeName` and a `sourcePath`.
4. **Snapshot file is `scripts/snapshots/state.shape.snapshot.json`** —
   single file, keyed by `typeName`, value an alphabetically-sorted
   `string[]` of declared field names. (Single-file form chosen over
   per-type for two reasons: one diff hunk per shape-change PR mirrors
   `lint:cli-readme`'s single-source pairing, and `git diff` of the
   snapshot is the human-readable contract document. Cost: a touch on any
   one type re-renders the whole file; this is acceptable since field
   touches are rare.)
5. **Field extraction** is regex-over-source against the type declaration
   in the named source file, mirroring `extractUsageBlock` /
   `extractUsageCommands` in `scripts/lint-cli-readme.ts`. Pattern:
   match `export interface <TypeName> {` (or `interface <TypeName> {` for
   non-exported) up to the matching closing brace, then a per-line regex
   pulls field names (`/^\s+(\w+)\??\s*[:?]/` with comment-line skip).
   Inherited / extended types are out of scope (none of the allowlisted
   types use `extends`); an explicit `// SILENT-DRIFT WARNING` comment
   block in the script (mirroring `lint-cli-readme.ts:25-46`) names the
   recognised pattern and the failure mode if a refactor switches to
   `Pick<>`/`Omit<>`/composition.
6. **Trigger is broad: any field touch** (per user 2026-05-02 Q3). The
   check compares the live extracted field set per type against the
   snapshot's recorded set. A `Violation` is emitted when:
   - Snapshot has a field the source lacks (`kind: "field-removed"`).
   - Source has a field the snapshot lacks (`kind: "field-added"`).
   - The named type is missing from the source file
     (`kind: "type-missing"`).
   The "shape-change" case (e.g. scalar→record) is not detectable from
   field-name set alone — the lint trips only on the rename axis (old
   removed + new added) and on add/remove. This is acceptable because
   shape-changes typically rename or add (the gh-ludics-409 fix renamed
   `staleBaseLastWarnedRound`/`Count` → `staleBaseLastWarned`); pure
   in-place type-narrowing without a name change escapes both this lint
   and the reviewer paragraph, and falls back on test coverage.
7. **Co-change requirements** when any violation fires (mirroring the
   "broad scope, mechanical" decision):
   - `git diff` (vs the merge-base, or the working-tree diff in
     `--working-tree` mode) must show a textual modification inside the
     `migrateState` function body in `src/orchestration/state.ts` *or*
     inside the named type-specific migrator (e.g.
     `readTmuxSlotState`, `loadDeferredCleanups`, `readStash` — for
     allowlisted types where `migrateState` is not the canonical
     normalizer, a `MIGRATORS` map entry pairs the type name with its
     normalizer function name).
   - `git diff` must show at least one modified or new file matching
     `**/*.migrate*.test.ts` *or* `**/state*.test.ts` *or* a test file
     under the same directory as the type that imports the named
     migrator and constructs a literal carrying the legacy shape (file
     path match is sufficient — the lint does not parse test bodies).
   - **No-op convention** for purely-additive new fields: a one-line
     migrator touch (`// gh-ludics-XXX: <field> is new, no legacy on-disk
     shape` or equivalent) plus a positive-presence test counts as
     paired. The lint enforces the touch, not the semantic correctness;
     reviewer-side guidance handles the latter.
8. **Snapshot-update workflow:** running
   `bun scripts/lint-state-migration.ts --update` (or `--write`) rewrites
   `scripts/snapshots/state.shape.snapshot.json` to match the current
   source. The flag is not present in CI invocation; CI uses the no-flag
   form, which exits non-zero on drift. The literal grep `--update`
   resolves to a recognised CLI flag in the script.
9. **Symmetric exit codes** mirror `lint:cli-readme`:
   - `0` — every allowlisted type's field set matches its snapshot, OR a
     mismatch is paired with the required migrator-and-test touches.
   - `1` — any unpaired violation in either direction (added/changed
     field with no migrator change, OR migrator change with no test
     fixture, OR snapshot drift with no co-changes at all).
10. **CI integration:** `.github/workflows/ci.yml` gains a step `Lint —
    state migration` running `bun run lint:state-migration`, placed
    immediately after `Lint — vendor sync` (line 56). The literal grep
    `lint:state-migration` resolves to one entry in `package.json` and
    one step in the CI workflow.
11. **Tests:** `scripts/lint-state-migration.test.ts` exists and
    exercises (a) clean-tree green path against the real repo root, (b)
    each `Violation` `kind` produces a non-zero exit and a named-field
    error message via the temp-fixture root override (mirroring
    `lint-vendor-sync.test.ts`'s argv-root pattern), (c) the
    `--update` flag rewrites the snapshot file in a tmp fixture and
    leaves the live snapshot untouched. The literal grep
    `lint-state-migration.test.ts` resolves to a real file under
    `scripts/`.
12. **Documentation:** `docs/orchestration-patterns.md` § Read-boundary
    backfill for optional fields gains a closing paragraph naming the
    new lint and the snapshot-update workflow. The literal grep
    `lint:state-migration` appears in `docs/orchestration-patterns.md`.
    Item 5 of the "When not to apply" list (currently asserts "no
    runtime lint enforces this") is updated to reflect the new
    enforcement layer — explicitly, that the lint covers the
    add/rename/remove axis on the allowlisted types and reviewer
    guidance remains the catch-all for everything else (in-place shape
    changes without rename, persisted shapes outside the allowlist).
13. **Initial snapshot is checked in:** the first commit of the lint
    includes a `scripts/snapshots/state.shape.snapshot.json` that lists
    the current field sets of every allowlisted type. The lint passes
    against this initial snapshot on the same commit (so CI on the PR
    that introduces the lint is green).

### Action (3): test-triple memory note (harness repo, not this PR)

This deliverable lives in the **harness repo**
(`/Users/lukstafi/self-improve/harness/`), not in `lukstafi/ludics`. The
verifier checks the harness path. AC text:

14. **`mag/memory/feedback_state_migration_test_triple.md`** exists in
    the harness repo and names the three-test pattern: positive
    backfill, negative control (legacy keys absent → no-op), JSON
    round-trip fidelity. The note cites the gh-ludics-409 fix as the
    worked example (PR #399 / staleBaseLastWarned rename). Length: one
    short paragraph per pattern, plus a one-line "see also" pointing at
    the new lint.
15. **MEMORY.md links the new note** under the "Conventions" or
    "Operational Notes" section using the project-standard
    `[short title](feedback_state_migration_test_triple.md)` form. The
    literal grep `feedback_state_migration_test_triple` matches in
    `MEMORY.md`.

## Context

### Reference shapes

- **`scripts/lint-vendor-sync.ts`** — hard-coded `PAIRS` array, pure
  `checkPairs(root, pairs)` function exported for tests, named
  `Violation` records with `kind` and `hint`, optional argv root
  override (`process.argv[2]`), CLI guarded by `import.meta.main`. The
  state-migration lint copies this skeleton structurally:
  `PERSISTED_TYPES` plays the role of `PAIRS`, `checkShapes(root,
  types)` plays the role of `checkPairs`.
- **`scripts/lint-cli-readme.ts`** — symmetric exit-code contract
  (drift in either direction → non-zero), regex-over-source
  extraction with explicit `SILENT-DRIFT WARNING` documenting the
  failure mode if construction shape changes (`commands.map(...)`
  collapse). The state-migration lint inherits both: symmetric exit
  on any field-set asymmetry, plus a SILENT-DRIFT block flagging
  the "type uses `extends`/`Pick<>`" refactor case.

### Read-boundary normalizers (per-type)

- `OrchestrationState` / `OrchestrationConfig` → `migrateState` in
  `src/orchestration/state.ts` (called from `readOrchestrationState`).
  This is the canonical normalizer the issue body names.
- `SlotData` → no single read-boundary normalizer; the type is
  consumed across `src/slots/json.ts` (read/write helpers,
  `normalizeTaskId`), markdown migration, and frontmatter parsing.
  For the lint's purposes, a `migrateState`-style function is
  required only for `OrchestrationState`/`OrchestrationConfig`; for
  `SlotData` and the others, the `MIGRATORS` map names the
  type-specific reader (e.g. `readSlotJson` if/when one is added —
  current code uses inline normalisation in `readJsonFile<SlotData>`
  callsites). Day-one approach: `SlotData` migrator name in the
  `MIGRATORS` map points at `normalizeTaskId` (the closest existing
  centralised normalizer); a follow-up may introduce a proper
  `migrateSlotData` if shape evolution makes that worthwhile.
- `TmuxSlotState` → `readTmuxSlotState` in
  `src/adapters/tmux-adapter.ts:92-104` is the read-boundary; it
  currently does no migration but is the natural location.
- `SessionSweepState` → loaders in
  `src/sessions/sweep-state.ts` (around `sweepStatePath` /
  `loadSweepState`).
- `CleanupEntry` → `loadDeferredCleanups` in
  `src/orchestration/deferred-cleanup.ts:30-40`.
- `PreemptStash` → `readStash` in `src/slots/preempt.ts:33-41`.

### Why the snapshot is single-file (not per-type)

The lint's contract is "any field touch on an allowlisted type
requires migrator + test co-change". A single
`state.shape.snapshot.json` keyed by type name produces one diff hunk
per shape-changing PR — same pattern as a `package.json` dependency
bump, easy to read in review. Per-type snapshots would scatter the
contract across seven files; the cost of one file re-rendering when
any type moves is negligible (the file is small, JSON-pretty-printed,
deterministic).

### Where the harness-repo deliverable lives

The Mag memory directory is at
`/Users/lukstafi/self-improve/harness/mag/memory/`. The new note path
is `mag/memory/feedback_state_migration_test_triple.md` (relative to
harness root). `MEMORY.md` is at
`/Users/lukstafi/.claude/projects/-Users-lukstafi-self-improve/memory/MEMORY.md`,
which is symlinked to `/Users/lukstafi/self-improve/harness/claude-memory/MEMORY.md`
(per the "Claude Code memories are git-synced" note in MEMORY.md
itself). The link from MEMORY.md uses the existing convention —
relative path to `feedback_*.md` siblings.

### Edge cases

- **Brand-new persisted types.** When a *new* type is added to the
  allowlist (not just a new field on an existing type), the snapshot
  initially lacks the type entry. The lint treats "type-missing-from-
  snapshot" as a normal `field-added`-equivalent violation — the
  developer runs `--update` and lands a no-op migrator + positive-
  presence test alongside the type addition.
- **Field deletion.** Removed fields trip the `field-removed` kind.
  The migrator co-change for a deletion is typically `delete
  state.oldField`; the test fixture asserts the legacy literal still
  parses without throwing. No special-case handling — same paired-
  touch rule applies.
- **Lint false positives on experiment branches.** A refactor that
  renames a field on a worktree that never persisted state with the
  old name still trips the lint. Acceptable cost — the test-fixture
  write is cheap (ten lines) and documents intent. This is the same
  cost-benefit tradeoff as `lint:vendor-sync`'s false-positive on a
  vendor-only refactor.
- **Persisted shapes outside the allowlist.** A new persisted JSON
  shape (e.g. a future `mag/foo.json`) that ships without being added
  to `PERSISTED_TYPES` is silently uncovered. Reviewer-side guidance
  catches this; the lint is best-effort coverage of the highest-
  traffic surface (the closing paragraph in
  `docs/orchestration-patterns.md` should call this out explicitly so
  reviewers know the lint's scope).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Implementation order (recommended)

1. **Script and snapshot first, no CI wire-up.** Land
   `scripts/lint-state-migration.ts`, the initial
   `scripts/snapshots/state.shape.snapshot.json`, and
   `scripts/lint-state-migration.test.ts`. Run `bun run
   lint:state-migration` locally; confirm clean exit. This isolates
   the regex-extraction and snapshot-comparison logic from the diff-
   parsing logic (which has more failure modes).
2. **Diff-parsing logic next.** The "co-change" check needs to inspect
   `git diff` output. Use `git diff --name-only <base>..HEAD` and
   `git diff <base>..HEAD -- src/orchestration/state.ts` to detect
   migrator-body touches. Mirror `lint-vendor-sync`'s pattern of an
   exported pure function that takes pre-fetched diff strings as
   arguments — this keeps the test surface mockable. Base resolution
   uses the same `git symbolic-ref refs/remotes/origin/HEAD` /
   `merge-base` pattern as the runner-side stale-base detection
   documented in `docs/orchestration-patterns.md` § Scope declaration
   and salvage.
3. **Working-tree mode for local development.** When run outside CI
   (no PR base context), default to `git diff HEAD` (working-tree vs
   index) so a developer iterating locally sees the lint fire as soon
   as they touch a type without a migrator update. CI passes the
   merge-base explicitly via env var or argv.
4. **CI wire-up last.** Once the script is green on the lint's own PR,
   add the workflow step. The initial snapshot will be the field set
   at the moment the lint lands; subsequent PRs that touch any
   allowlisted type will need to either run `--update` and explain the
   diff, or pair the change with migrator+test (the desired state).
5. **Doc update concurrent with CI wire-up.** The
   `docs/orchestration-patterns.md` paragraph and the item-5 update
   are part of the same commit that wires up CI, since the doc
   reflects the live enforcement layer.

### What to skip in implementation

- **AST-based extraction.** The regex approach is sufficient for the
  allowlisted types (none use `extends`, generics, or `Pick<>`); a
  TypeScript Compiler API extractor would be ~3x the LOC for a
  marginal correctness gain on a closed allowlist. The SILENT-DRIFT
  warning block documents the regression mode if a refactor breaks
  the assumption.
- **Per-field shape recording.** The snapshot records field names
  only, not types. Recording types would catch in-place shape
  changes (scalar→record) but doubles the snapshot's diff surface
  and re-introduces TypeScript-parsing complexity. The reviewer
  paragraph remains the catch for in-place shape changes.

## Scope

### In scope (this PR, project repo)

- `scripts/lint-state-migration.ts`
- `scripts/lint-state-migration.test.ts`
- `scripts/snapshots/state.shape.snapshot.json`
- `package.json` — new `lint:state-migration` script entry
- `.github/workflows/ci.yml` — new step
- `docs/orchestration-patterns.md` — closing paragraph + item-5 update

### In scope (this task, harness repo — separate change)

- `/Users/lukstafi/self-improve/harness/mag/memory/feedback_state_migration_test_triple.md`
- `MEMORY.md` link (resolved via symlink to harness)

The harness-repo deliverable does not block the project-repo PR;
verification of AC #14 and #15 is performed against the harness path
explicitly. The verifier's evidence transcript should cite both
repository roots so the split is auditable.

### Out of scope (per user 2026-05-02 resolution)

- Action (1) — coder-side plan template hint in
  `pair-coder-plan.md` / `pair-coder-plan-merge.md` /
  `ludics-draft-proposal-worker.md`. Abandoned: extending core
  coder/reviewer skill prompts adds cognitive load on every round.
  The existing reviewer paragraph in
  `pair-reviewer-plan-review.md` is the enforcement layer; the new
  lint (Action 2) is mechanical reinforcement; the memory note
  (Action 3) is consultable reference.

### Dependencies

None. This task is independent of the related-issue chain (#410, #303,
#311) — those resolved separately. No worktrees or upstream-task
ordering.

### Effort

Medium per task frontmatter. Realistic split:
- Lint script + snapshot + tests: ~250-350 LOC
- CI wire-up + doc paragraph: ~30 LOC
- Harness-repo memory note + MEMORY.md link: ~30 LOC, separate commit
