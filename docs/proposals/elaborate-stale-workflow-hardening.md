# Elaborate/stale workflow hardening: atomic `has_questions` write + new `stale` status

## Goal

Two workflow surfaces in the elaborate / draft-proposal pipeline misbehave under
real load and need to be hardened together. They share the same skill orchestrators,
the same task-frontmatter helpers, and the same skip-list logic, so bundling
prevents the trap where Part 1 lands and the keepalive's auto-queue criterion
needs a second edit weeks later when Part 2 lands.

**Part 1 — `has_questions` race.** The `/ludics-elaborate` orchestrator currently
adds `has_questions: true` to the frontmatter *after* the elaborate worker has
already written the file once (with `elaborated:`, `## Tentative Design`, and
`## Questions`). Two writers per task → "File has been modified since last
read" errors observed on every elaboration during the 2026-04-30 retrospective
session. Worse: between the worker's write and the orchestrator's
post-worker write, the keepalive's `maybeQueueProposals` cycle in `src/mag.ts`
sees an elaborated task with no `has_questions` and no `proposal:` and queues
a draft-proposal *before* `has_questions` lands. Even when the orchestrator's
retry succeeds, the queued draft-proposal is in flight against a task that
should be blocked on user answers.

**Part 2 — re-queueing of stale tasks.** When the draft-proposal worker
returns `status: stale` (e.g. `gh-ocannl-203`, where the anticipated design
already shipped via Affine), the orchestrator writes the result JSON and
leaves the task in `status: ready`. Nothing in the task file records "this
is stale." `gh-ocannl-203` was draft-proposal-invoked **3 times** in a single
session — each run reaches the same conclusion at the same compute cost.

This proposal collapses Part 1 to one writer per task (worker writes
`has_questions: true` atomically with `elaborated:`; orchestrator verifies and
falls back) and introduces a recognised `stale` task status with skip-list
coverage across the keepalive sweeps, a dashboard surface with revival /
abandon actions, a centralised `VALID_STATUSES` constant covering the full
enum, and a new `## Status` lifecycle section in the frontmatter reference doc.

Filed against the harness during the 2026-04-30 retrospective-processing
session.

## Acceptance Criteria

The acceptance criteria below pair cardinality probes (`grep -c`) with presence
loops (per-element `toContain`) per the AC-rigor reference's "vacuous-harness"
and "enumerated-element" families. Every AC names a probe whose negative
outcome is naturally produced by violating the AC, not by editing the
verification narrative.

### Part 1 — atomic `has_questions` write

1. **Worker writes `has_questions: true` atomically when `questions` is
   non-empty.** `skills/ludics-elaborate-worker.md` instructs the worker to
   call `addFrontmatterField(taskFile, "has_questions", "true")` in the same
   "Update task file" step that writes `elaborated:`. The instruction names
   `addFrontmatterField` by name and is contained within the existing
   `### 6. Update task file` section.

   *Probe.* `grep -c '^addFrontmatterField.*has_questions' skills/ludics-elaborate-worker.md`
   returns at least 1; `grep -B2 -A2 'has_questions' skills/ludics-elaborate-worker.md`
   shows the instruction sits inside the section delimited by
   `<!-- section:update-task -->` and the next `<!-- section: -->` boundary.

2. **Orchestrator no longer unconditionally writes `has_questions:`.**
   `skills/ludics-elaborate.md`'s "Questions notification" section step 1
   (`Add has_questions: true to the task frontmatter`) is removed and replaced
   with a verify-and-fallback-write step: read the task file, parse
   frontmatter, and if `questions` was non-empty but `has_questions` is absent,
   emit a `console.error` warning of the form
   `worker omitted has_questions for <task_id> — falling back` and call
   `addFrontmatterField` itself. (Per resolved Q4: option (b),
   verify-and-fallback-write — the failure mode is agentic, not algorithmic,
   so paper over with a loud warning.)

   *Probe.* `grep -c "Add \`has_questions: true\` to the task frontmatter" skills/ludics-elaborate.md`
   returns 0 (the original imperative line is gone). `grep -c "verify\|fallback\|warning" skills/ludics-elaborate.md`
   in the relevant section returns at least 1.

3. **No regression in the `has_questions` race window.** A test in
   `src/orchestration/runner.verification.test.ts` (or a sibling test file
   in `src/skills/` if a worker-shape harness exists) constructs a synthetic
   elaborate-worker output with non-empty `questions`, applies the worker's
   frontmatter writes to a fixture task file, and asserts the file has both
   `elaborated:` AND `has_questions: true` after the *worker* portion runs —
   without invoking the orchestrator. The probe pins atomicity, not just
   eventual consistency.

   *Falsifier.* Removing the `has_questions` write from the worker template
   (the regression Part 1 exists to prevent) makes this test's
   `has_questions: true` assertion fail.

4. **Existing `has_questions` tests still pass.** No regression relative to
   the base branch on `src/orchestration/runner.verification.test.ts`'s
   existing `has_questions` describe block.

   *Framing.* Per the AC-rigor reference's baseline-aware family: this is a
   no-regression-from-base AC, not a "all tests pass" AC. Run
   `git stash && bun test src/orchestration/runner.verification.test.ts && git stash pop`
   to capture the base count if any failures pre-exist; confirm the post-edit
   count does not exceed the base count.

### Part 2 — `stale` status

5. **`stale` is documented in `TaskFrontmatter.status` and surfaced as a
   constant.** `src/tasks/types.ts` line 7 status comment includes `stale`
   in the enumeration. `src/tasks/markdown.ts` (or a sibling module — implementer
   choice) exports a `VALID_STATUSES` array containing the full enum
   (`ready`, `in-progress`, `deferred`, `preempted`, `preempt-queued`, `done`,
   `abandoned`, `merged`, `needs-confirmation`, `blocked`, `stale`) together
   with per-purpose subsets:

   - `TERMINAL_STATUSES` (`done`, `abandoned`, `merged`, `stale`) — terminal
     for queue / unstick / parent-completion purposes.
   - `READY_QUEUE_ELIGIBLE_STATUSES` — currently `["ready"]`; named for
     intent-locality.
   - `BLOCKED_RECONCILE_SKIP_STATUSES` — the existing skip list in
     `tasksReconcileBlockedStatus`, now `terminal ∪ {in-progress, deferred,
     preempt-queued, preempted}`.

   *Probe.* `grep -c "^export const VALID_STATUSES" src/tasks/markdown.ts` (or
   the chosen module) returns 1; `grep -c "stale" <module>` returns at least 1
   inside the `VALID_STATUSES` array literal.

6. **Inline list-membership sites refactored to use the centralised constants
   (per resolved Q3).** All ~6 sites enumerated in the task body switch from
   inline string-array literals to references to the new constants. Per-site
   coverage:

   - `src/mag.ts` `unstickEmptySlots` (`unstickStatus === "done" || ... === "merged"`)
     → `TERMINAL_STATUSES.includes(unstickStatus)`.
   - `src/tasks/sync.ts` `tasksReconcileBlockedStatus` skip list →
     `BLOCKED_RECONCILE_SKIP_STATUSES.includes(status)`.
   - `src/tasks/sync.ts` `containerCompletionSweep` `TERMINAL_FOR_PARENT` set →
     extended to include `stale`.
   - `src/tasks/sync.ts` `tasksMilestoneWarnings` skip list → uses
     `TERMINAL_STATUSES` (or its non-`merged` subset, implementer's choice with
     review).
   - `src/tasks/index.ts` `tasksDuplicates` filter (line 367 region) →
     `TERMINAL_STATUSES.includes(...)`.
   - `src/tasks/index.ts` abandon-path terminal guard (line 624 region) →
     `TERMINAL_STATUSES.includes(currentStatus)`.

   *Probe.* `grep -nE '\["done", "abandoned", "merged"\]' src/` returns 0
   matches in non-test, non-comment lines (test files may legitimately
   enumerate the literal). Each named site in this AC has a corresponding
   `VALID_STATUSES` / `TERMINAL_STATUSES` / `BLOCKED_RECONCILE_SKIP_STATUSES`
   reference in the post-commit tree.

7. **`/ludics-draft-proposal` orchestrator routes `stale` worker results to a
   status flip + Notes append.** `skills/ludics-draft-proposal.md`'s
   "Status routing" section, `stale` row, expands from
   `write result JSON with "status": "stale" and stop` to:

   ```
   - **stale** — call transitionStatus(taskFile, "ready", "stale"); append
     rationale to Notes via appendToSection(...); write result JSON with
     "status": "stale" and stop.
   ```

   *Probe.* `grep -c 'transitionStatus.*"stale"\|appendToSection.*Notes' skills/ludics-draft-proposal.md`
   returns at least 2 (one per helper).

8. **`/ludics-draft-proposal` precondition refuses stale tasks.** A new
   precondition check sibling to the `has_questions` check fires when
   `status: stale`: it writes result JSON
   `{"status": "blocked-stale", "reason": "task previously marked stale"}` and
   does not delegate to the worker.

   *Probe.* `grep -c 'blocked-stale' skills/ludics-draft-proposal.md` returns
   at least 1; the new check is in the
   `<!-- section:precondition-check -->` section.

9. **Keepalive paths exclude `stale` from the proposal queue.** The two
   relevant `mag.ts` skip lists (`unstickEmptySlots` and `maybeQueueProposals`)
   either inherit from the centralised `TERMINAL_STATUSES` (AC 6) or pass
   their existing `status === "ready"` filter through `getSortedReadyCandidates`,
   which already excludes non-ready tasks. The atomic test of this AC is:

   *Test probe.* A unit test in `src/mag.test.ts` (or `src/tasks/sync.test.ts` —
   implementer choice) constructs an in-memory task corpus including one
   `status: stale` task, calls `getSortedReadyCandidates(config)`, and asserts
   the stale task is absent from the result. Removing the
   `status === "ready"` filter would make the test fail by surfacing the stale
   task. (This pins the *invariant* — stale absent — not the
   *implementation* — `=== "ready"`.)

10. **Dashboard surfaces a "Stale" panel with revive + abandon actions
    (per resolved Q1).** Three coordinated changes:

    - `src/dashboard.ts` adds a `staleConfig: FilteredTaskTileConfig` mirroring
      `needsConfirmationConfig` (filter `task.status === "stale"`) and writes
      `stale.json` from the dashboard generator.
    - `templates/dashboard/index.html` adds a `<section class="stale panel">`
      with `<h2>Stale</h2>` and `<ul id="stale-list">`, mirroring the
      Needs-Confirmation panel's structure.
    - `templates/dashboard/dashboard.js` adds a `fetchStale()` function that
      calls `fetchAndRenderTaskList` against `stale.json` / `stale-list`. Each
      list item renders two action buttons:
      - **Revive** → `POST /api/stale-revive?task=<id>` → flips
        `status: stale` → `status: ready` via
        `transitionStatus(taskFile, "stale", "ready")`.
      - **Abandon** → `POST /api/stale-abandon?task=<id>` → delegates to
        `tasksAbandon(taskParam, { source: "dashboard", scope: "task" })`
        (mirroring the existing `/api/task-dismiss` shape).

    *Probe.* `grep -c '"/api/stale-revive"' src/dashboard-server.ts` and
    `grep -c '"/api/stale-abandon"' src/dashboard-server.ts` each return 1.
    `grep -c 'stale-list' templates/dashboard/index.html` returns 1.
    `grep -c 'fetchStale\b' templates/dashboard/dashboard.js` returns at
    least 2 (definition + invocation in the data-refresh loop). One unit
    test in `src/dashboard.test.ts` (or wherever existing dashboard tests
    live) constructs a corpus with a `status: stale` task and asserts
    `stale.json` contains the task; removing the `staleConfig` filter would
    make the test fail.

11. **`docs/task-frontmatter-reference.md` gains a full `## Status`
    lifecycle section (per resolved Q2 — extended scope).** The new section:

    - Lists every status the codebase currently uses with a one-paragraph
      semantic description: `ready`, `in-progress`, `deferred`, `preempted`,
      `preempt-queued`, `done`, `abandoned`, `merged`, `needs-confirmation`,
      `blocked`, plus the new `stale`.
    - Documents transitions: who flips a task to each status (orchestrator,
      worker, user, sync), and what unblocks each transition.
    - Calls out the `stale` semantics specifically: "task work has been
      superseded; the originally-proposed design has already shipped or the
      premise has been invalidated. Resolve by abandoning (auto-closes GH
      issue) or reviving via the dashboard (transitions back to `ready`)."

    *Probe.* `grep -c '^## Status' docs/task-frontmatter-reference.md` returns
    1 (cardinality). A presence loop asserts each of the 11 status names
    appears in a fenced subsection, header, or list item under `## Status`:
    a small test or a `verify` script counts `grep -c "^### \`<status>\`"`
    occurrences and asserts the count matches the expected enumeration.
    The intro paragraph's existing promise (`the status lifecycle (ready →
    in-progress → done / merged / etc.)`) is updated to point at the new
    section rather than describing it as future work.

12. **CLI accepts `stale` for `ludics tasks update --status`.** No central
    enum to update once `VALID_STATUSES` is in place, but a smoke probe
    confirms `ludics tasks update <task_id> --status stale` returns success
    on a fixture task. (If a status validation guard is added as part of AC 5,
    this AC ensures `stale` is accepted by it.)

    *Probe.* Either an integration test in the CLI test suite or a manual
    note in the proposal's verification ledger that the command exits 0 on
    a `status: ready` fixture and the resulting frontmatter has
    `status: stale`.

### No-regression-from-baseline framing

13. **Repo-wide gates do not regress relative to the merge base.** `bun run
    typecheck`, `bun run lint`, and `bun test` show the same number of (or
    fewer) errors / failures than the merge base. Per the AC-rigor reference's
    baseline-aware family, count and compare — do not assert "passes."

## Context

### Race in Part 1

`skills/ludics-elaborate-worker.md` § `### 6. Update task file` instructs the
worker to write `elaborated: <today's date>` and the `## Tentative Design` /
`## Questions` sections, but does NOT mention `has_questions`. The worker
returns its JSON; the orchestrator (`skills/ludics-elaborate.md` § Questions
notification step 1) then writes `has_questions: true` to the frontmatter.

In the same window, `src/mag.ts`'s `maybeQueueProposals` runs on every
keepalive tick. Its filter (per the function body, near the
`if (content.includes("\nhas_questions:")) continue;` line in the slice
quoted by the task body) sees an elaborated task with no `has_questions` and
no `proposal:` and queues a draft-proposal. The race window is the duration
between the worker's commit and the orchestrator's `addFrontmatterField`
write. The race is real and reproducible — observed on every elaboration in
the 2026-04-30 session.

### Helpers (no new code needed)

- `addFrontmatterField(filePath, field, value)` in `src/tasks/markdown.ts` —
  upsert under `atomicWriteFileSync`. Note from existing memory
  `feedback_has_questions_removal.md`: upsert matches the *first* occurrence
  and overwrites in place; subsequent matches fall through and become
  duplicates. The verify-and-fallback-write path in AC 2 must read the
  frontmatter (`parseTaskFrontmatter`) and only call `addFrontmatterField` if
  the field is absent — never blindly re-write.
- `transitionStatus(filePath, expectedFrom, to)` in `src/tasks/markdown.ts`
  — idempotent under retries (returns `false` if the current status doesn't
  match `expectedFrom`).
- `appendToSection(filePath, section, line)` in `src/tasks/markdown.ts` —
  dedupes exact-match lines, so the orchestrator can call unconditionally on
  stop-hook reruns.

### Skip-list sites (Part 2)

The task body's pointer to a "STATUSES enum in `src/tasks/markdown.ts`" was
incorrect — there is no central enum. The status field is a free-form string
in `TaskFrontmatter` (`src/tasks/types.ts:7`). The validity check is
distributed across:

- `src/mag.ts` `getSortedReadyCandidates` — `if (status !== "ready") continue;`
  (already excludes `stale` automatically once `stale` is a recognised
  non-ready status).
- `src/mag.ts` `unstickEmptySlots` — explicit
  `unstickStatus === "done" || ... === "merged"` skip list. Needs `stale`
  added (or refactored to `TERMINAL_STATUSES`).
- `src/mag.ts` `maybeFillEmptySlots` — `if (fm.status !== "ready") continue;`
  (auto-excludes).
- `src/tasks/sync.ts` `tasksReconcileBlockedStatus` — explicit skip list with
  7 entries. Add `stale`.
- `src/tasks/sync.ts` `containerCompletionSweep` `TERMINAL_FOR_PARENT` — add
  `stale`.
- `src/tasks/sync.ts` `tasksMilestoneWarnings` — explicit `done/abandoned/merged`
  skip. Add `stale`.
- `src/tasks/index.ts` two `["done", "abandoned", "merged"].includes(...)`
  sites (`tasksDuplicates`, abandon-path guard). Add `stale`.

### Existing precedent

- `src/slots/index.ts` already exports `VALID_CLEAR_STATUSES` (line 31) used
  by `dashboard-server.ts` `/api/slot-clear`. The new `VALID_STATUSES` /
  `TERMINAL_STATUSES` set follows the same shape.
- `src/dashboard-server.ts` lines 312–364 (`/api/task-confirm`,
  `/api/task-dismiss`) — the API shape for the new
  `/api/stale-revive` and `/api/stale-abandon` endpoints. `transitionStatus`
  guard, status mismatch → 409, lastGenerated reset, return JSON.
- `src/dashboard.ts` `needsConfirmationConfig` (~line 533),
  `unansweredQuestionsConfig` (~539), `deferredLaunchConfig` (~544) — the
  shape for `staleConfig`.
- `templates/dashboard/index.html` `<section class="needs-confirmation panel">`
  (line 113) — the shape for `<section class="stale panel">`.
- `templates/dashboard/dashboard.js` `fetchNeedsConfirmation()` (line 586) —
  the shape for `fetchStale()`. Buttons mirror `confirmTask` / `dismissTask`
  (lines ~687, ~706) for revive / abandon.

### `task-frontmatter-reference.md` extension

The doc's intro paragraph (line 5) already promises future coverage of "the
status lifecycle (`ready` → `in-progress` → `done` / `merged` / etc.)". This
proposal fulfils that promise with a complete `## Status` section per Q2's
resolution to the extended scope. The minimum scope (a paragraph documenting
just `stale`) is acceptable as a fallback if the implementer finds the full
section significantly inflates the task — in that case file a follow-up.

### AC-shape concerns

Per the AC-rigor reference's vacuous-harness and falsifier-shape families:

- The Part 1 atomicity AC (AC 3) is *invariant-shaped*: the assertion is
  "after the worker portion runs, the field is present" — its falsifier is
  the worker forgetting to write the field, which is exactly the regression
  the AC exists to prevent.
- The doc/code-shape ACs (AC 5, 6, 10, 11) pair `grep -c` cardinality probes
  with per-element presence loops, so a missing element fails a specific
  named assertion rather than a composite "the doc mentions stale somewhere"
  check.
- AC 4 and AC 13 use no-regression-from-baseline framing per the
  baseline-aware family — they count errors before and after, not assert
  "all tests pass."

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Suggested ordering

1. **Centralise constants first** (AC 5). `VALID_STATUSES`,
   `TERMINAL_STATUSES`, `BLOCKED_RECONCILE_SKIP_STATUSES`, and
   `READY_QUEUE_ELIGIBLE_STATUSES` in `src/tasks/markdown.ts` (or
   `src/tasks/types.ts` — implementer's call; pick the module already
   imported by the most call sites). Update `TaskFrontmatter.status`
   comment to enumerate `stale`.
2. **Refactor inline skip lists** (AC 6) to consume the constants. One PR
   commit per module if helpful, or all together — `bun run typecheck` will
   catch typos.
3. **Wire `stale` through orchestrators** (ACs 7, 8). `ludics-draft-proposal.md`
   gets the routing change and the precondition check.
4. **Part 1 atomic write** (ACs 1, 2, 3). Smaller surface — only two skill
   files and one test. Self-contained; can be done in parallel with Part 2.
5. **Dashboard panel + endpoints** (AC 10). Follow `needs-confirmation`
   shape end-to-end.
6. **Doc extension** (AC 11). Last because it documents what now exists.
7. **CLI smoke** (AC 12). Verify nothing else needs to change in the CLI
   layer.

### Risks and mitigations

- **`addFrontmatterField` upsert duplication** if both worker and
  orchestrator write `has_questions:`. Mitigated by AC 2's verify-then-write
  shape: the orchestrator reads frontmatter first and only writes if absent.
- **Worker forgetting `has_questions`** (the agentic failure mode). Mitigated
  by AC 2's loud `console.error` warning so the regression surfaces in the
  events log even when the fallback write succeeds.
- **`merged` status semantics for stale-equivalent purposes** —
  `containerCompletionSweep`'s `TERMINAL_FOR_PARENT` includes `merged` but
  `tasksMilestoneWarnings` does not. The proposal preserves the existing
  asymmetry and only adds `stale` where it belongs. If the implementer finds
  the asymmetry incoherent, they should flag in Notes — out of scope to fix
  here.

## Scope

**In scope:**
- Part 1 (atomic `has_questions` write) and Part 2 (`stale` status) bundled.
- Skill orchestrator and worker changes (`ludics-elaborate.md`,
  `ludics-elaborate-worker.md`, `ludics-draft-proposal.md`).
- Centralised `VALID_STATUSES` constant + per-purpose subsets, refactor of
  the ~6 inline list-membership sites.
- Dashboard "Stale" section with revive + abandon buttons + matching server
  endpoints.
- Full `## Status` lifecycle section in `docs/task-frontmatter-reference.md`.
- Tests for the atomicity invariant, the keepalive `stale` exclusion, and the
  dashboard config filter.

**Out of scope:**
- Retroactively flipping all historically-stale tasks (e.g.
  `gh-ocannl-203`) to `status: stale`. Flag candidates in the proposal-phase
  Notes; user decides whether to file a follow-up.
- Generalising the orchestrator/worker file-write race fix to other
  `has_questions`-shaped fields. Part 1 fixes the specific race; the pattern
  can be applied to other fields if they show similar symptoms.
- Other status-enum cleanups (e.g. consolidating `abandoned` and `done`
  semantics, deciding whether `merged` belongs in `tasksMilestoneWarnings`).

**Dependencies:**
- None. Both Parts touch the same task-state surface and the same skill
  files; they can be designed and landed together in one PR.
