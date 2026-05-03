# PR-comments redispatch broken for codex slots: prUrl capture + dispatch semantics

## Goal

A reviewer posted a real review on PR #482 during slot-2's `pr-comments`
phase, and the coder was never re-dispatched to address it. The user had to
nudge by hand. Two compounding bugs caused the silent drop:

- **(a) `runtime.prUrl` ended up `null`** in `orchestration/slot-2.json`
  even though the PR existed on GitHub. With `prUrl` null,
  `checkAndRedispatchPrComments` cannot poll for new comments and the
  redispatch gate never opens.
- **(b) `prCommentsCoderDispatched` is set to `true` on first dispatch and
  never reset.** The `prCommentsReadyForFinalMerge` shortcut therefore
  fires after review #1 settles and the phase exits before review #2
  arrives. The field name reads as a perfect aspect ("we have dispatched
  at some point") but is used as a present-progressive predicate
  ("currently dispatched"); the rename surfaces the real semantics.

This task ships the comprehensive fix for both layers plus glue and
observability, so the next slot does not silently drop a review.

Related: task-4028c493 (the slot whose review was dropped — its PR is
already merged); task-a670cdbf (substantive-pane-diff stall detection,
sibling); gh-ludics-479 (`lint:state-migration`, currently in slot 2 —
this PR must satisfy that lint by adding a `migrateState()` backfill and a
legacy-fixture test for the rename).

## Acceptance Criteria

### (a) prUrl capture — `resolvePrUrl` fallback helper

1. **A new exported function `resolvePrUrl(state, agent)` exists in
   `src/orchestration/runner.ts`** (or a sibling module imported by
   `runner.ts`). The literal grep `function resolvePrUrl` resolves to
   exactly one declaration. The function:
   - Reads the agent's `.pr` file via `readPrUrl(state.peerSyncDir,
     agent.name)`. If the value is a valid PR URL (matches the existing
     `isPrUrl()` test in `src/orchestration/github.ts`), returns it.
   - Otherwise shells out: `gh pr list --head <branch> --state open
     --json url --jq '.[0].url'`, where `<branch>` is `agent.branch`
     (declared on `AgentConfig` in `state.ts`). Project repo, when
     present, is forwarded as `--repo <repo>` (mirroring
     `validateAndFixPrFile`). The shell-out goes through
     `safeSyncOutput`, not raw `Bun.spawn`, so the existing test
     stub-points carry over.
   - On a non-empty URL result, **writes the URL back to the agent's
     `.pr` file** (so subsequent polls do not re-shell-out) and returns
     it.
   - On any failure path (file missing and `gh pr list` returns empty,
     auth failure, non-zero exit), returns `null` without throwing.

2. **`refreshAgentStatuses` (in `runner.ts`) calls `resolvePrUrl` on every
   poll** for each participating agent, replacing the existing
   `runtime.prUrl = readPrUrl(state.peerSyncDir, agent.name) ??
   runtime.prUrl` line. The literal grep `readPrUrl(state.peerSyncDir,
   agent.name)` should appear inside `resolvePrUrl` only — no other
   site in `runner.ts` reads `.pr` directly for the runtime field. The
   `refreshAgentStatuses` body must call `resolvePrUrl` rather than
   reproducing its logic inline.

3. **Test — blanked `.pr` file recovery** (in
   `src/orchestration/runner.pr-comments.test.ts` or a sibling
   `runner.resolve-pr-url.test.ts`): set up a slot in `pr-comments`
   phase with `runtime.prUrl = null` and the coder's `.pr` file present
   but empty. Stub the `gh pr list` invocation (via the same
   `safeSyncOutput` spy pattern used elsewhere in this file —
   see `mergedSpy`/`commentCountSpy`/`reviewSpy` around line 666) to
   return a real PR URL. Call `refreshAgentStatuses` (or
   `resolvePrUrl` directly). Assert: (i) `runtime.prUrl` is the stubbed
   URL, (ii) the on-disk `.pr` file now contains that URL, (iii) the
   stub was called exactly once. The literal test name should grep on
   `resolvePrUrl` or `pr file blank fallback`.

### (b) `prCommentsCoderDispatched` → `prCommentsCoderActive` rename + predicate flip

4. **Field rename in `src/orchestration/state.ts:185`:**
   `prCommentsCoderDispatched?: boolean` → `prCommentsCoderActive?:
   boolean`. The doc comment is updated to read "True while the coder
   is currently dispatched and not-yet-settled for the latest review;
   false otherwise. Cleared on coder-settle and on fresh `pr-comments`
   phase entry." After the rename, `grep -rn
   "prCommentsCoderDispatched" src/ docs/proposals/<this-proposal>.md`
   returns no hits in `src/`; existing `docs/proposals/task-cb41bc69-*.md`
   and `docs/proposals/task-dcdb4562.md` are historical artefacts and
   stay untouched (they describe the field at the time those proposals
   landed).

5. **Predicate flip in `src/orchestration/phases.ts`:** the two existing
   uses (around lines 490 and 691, both gating
   `prCommentsReadyForFinalMerge` and the in-line dispatcher shortcut)
   change from
   ```
   if (state.prCommentsCoderDispatched && allAgentsDone(state) && state.prCommentsQuietSince && !state.prCodexReviewDeferredSince) {
   ```
   to
   ```
   if (!state.prCommentsCoderActive && allAgentsDone(state) && state.prCommentsQuietSince && !state.prCodexReviewDeferredSince) {
   ```
   *and* require an additional precondition: at least one redispatch
   must have occurred since phase entry, so the shortcut cannot fire
   on first entry before any review has been observed. Express this
   as a new `prCommentsRedispatchCount?: number` on `OrchestrationState`
   (incremented in `redispatchForPrComments`, reset by
   `resetPrCommentsState`); the shortcut requires
   `(state.prCommentsRedispatchCount ?? 0) >= 1`.

6. **Write-site changes in `src/orchestration/runner.ts`:**
   - At `runner.ts:1012` (in `redispatchForPrComments`): rename the
     write to `state.prCommentsCoderActive = true` and increment
     `state.prCommentsRedispatchCount = (state.prCommentsRedispatchCount
     ?? 0) + 1`. The increment is per-poll, not per-agent (one
     redispatch tick may dispatch multiple agents).
   - At `runner.ts:834` (in `resetPrCommentsState`): rename the write
     to `state.prCommentsCoderActive = false`, and add
     `state.prCommentsRedispatchCount = undefined`.
   - **New flip-back site:** when the coder agent settles (lifecycle
     transitions to `settled` or its `status` enters `DONE_STATUSES`)
     during `pr-comments`, set `state.prCommentsCoderActive = false`.
     Wire this through `refreshAgentStatuses` (or a small helper called
     from there), not phase entry. The literal grep
     `prCommentsCoderActive = false` should resolve to two write sites
     in `runner.ts`: the reset and the settle-detector.

7. **Test — sequential reviews flip-flop** (in
   `runner.pr-comments.test.ts`): simulate two sequential reviews on
   the same PR. Assert the flag transitions
   `false → true (after dispatch #1) → false (after settle #1) → true
   (after dispatch #2) → false (after settle #2)` and that
   `prCommentsReadyForFinalMerge(state)` returns `false` at the
   midpoint (between settle #1 and dispatch #2, with `prUrl` non-null
   and a fresh review #2 visible to the next poll). The second poll
   detects the new comment via the existing `fetchNewPrCommentCount`
   stub pattern. The literal test name should grep on
   `sequential reviews` or `coderActive flip-flop`.

### (c) `migrateState` backfill + legacy fixture (gh-ludics-479 discipline)

8. **`migrateState()` in `src/orchestration/state.ts` backfills the
   rename:** if a persisted state file carries the legacy
   `prCommentsCoderDispatched` key (boolean), copy its value to
   `prCommentsCoderActive` and `delete` the legacy key. The grep
   `prCommentsCoderDispatched` after this PR resolves only inside
   `migrateState` (the legacy-key cleanup) and in this proposal /
   historical proposal docs. Mirror the legacy-cleanup pattern at
   `state.ts:419-436` (the `staleBaseLastWarnedRound` /
   `staleBaseLastWarnedCount` precedent).

9. **Snapshot file `scripts/snapshots/state.shape.snapshot.json` is
   updated** to reflect the new field set on `OrchestrationState`
   (`prCommentsCoderActive` replaces `prCommentsCoderDispatched`, plus
   the new `prCommentsRedispatchCount`). `bun run lint:state-migration`
   exits 0 against this PR's tree. (gh-ludics-479 lands the lint; this
   PR is responsible for keeping the snapshot in sync if 479 has
   merged by the time this lands. If 479 has not merged, drop this AC
   and rely on the reviewer paragraph in
   `pair-reviewer-plan-review.md`.)

10. **Legacy fixture test** (in `phases.test.ts` or a sibling
    `state.migrate.test.ts`): construct an `OrchestrationState`-shaped
    object literal with `prCommentsCoderDispatched: true` and **without**
    `prCommentsCoderActive`. Pass it through `migrateState`. Assert:
    (i) `result.prCommentsCoderActive === true`, (ii)
    `'prCommentsCoderDispatched' in result === false`, (iii) JSON
    round-trip (`JSON.parse(JSON.stringify(...))`) preserves the
    backfilled shape and does not re-introduce the legacy key. The
    literal test name should grep on `prCommentsCoderActive` and
    `legacy`.

### (d) Glue + observability

11. **Journal event `pr_comments_redispatch`** is emitted from
    `redispatchForPrComments` (in `runner.ts`) when the coder is
    redispatched. Payload schema (TypeScript-shape, not runtime):
    `{ event_type: "pr_comments_redispatch", source: "orchestration",
    scope: "slot", slot, task: state.taskId, prUrl, newCommentCount,
    dispatchCount }` where `dispatchCount` reads
    `state.prCommentsRedispatchCount` *after* the increment. Emission
    is **idempotent on the false → true edge of
    `prCommentsCoderActive`** — only the poll cycle that flips the
    flag emits; subsequent polls while the flag stays `true` (because
    the coder hasn't settled yet) do not. The literal grep
    `event_type: "pr_comments_redispatch"` resolves to exactly one
    site.

12. **Stuck-phase warning event:** when the runner observes
    `phase === "pr-comments"`, `runtime.prUrl != null` for the coder,
    `state.prCommentsCoderActive === false`, and the most recent
    review timestamp on the PR (queried via the existing
    `fetchNewPrCommentCount` / equivalent path; reuse what's already
    polled, don't add a third GitHub roundtrip per tick) is more than
    `prCommentsStuckThreshold` seconds older than `nowEpoch() - (last
    redispatch at)`, emit one `orchestration_warning` event with
    message `"pr-comments: review observed but no redispatch
    detected"`. The threshold is a new field on `OrchestrationConfig`
    (`prCommentsStuckThreshold: number`, default `600` = 10 minutes),
    backfilled by `migrateState` on legacy state files. Edge-triggered
    dedup: persist a `prCommentsStuckWarnedAt?: number` on
    `OrchestrationState`, set on emission, reset on the next
    successful redispatch *or* on fresh phase entry. Re-emit only
    after the threshold elapses again (i.e. not on every poll while
    the warning condition holds).

### Out of scope

- Replaying `orchestration/slot-2.json` for full root-cause analysis of
  why slot-2's `.pr` file was missing (resolved: defer to follow-up
  only on recurrence; the `resolvePrUrl` fallback covers all three
  hypotheses listed in the task body). The task body's "investigation
  note" AC is intentionally **not** carried forward into this proposal.
- Unifying t3code/tmux orchestration phase tracking beyond what
  `resolvePrUrl` requires (separate parity work; cf. task-a670cdbf
  observation that `agents[].phase` is `null` for codex/tmux).
- Migrating already-stuck slots — manual `ludics nudge` recovery is
  the operator workflow; this PR prevents the next slot from hitting
  the same hole, not the current one.
- Sub-stantive-pane-change stall detection (covered by sibling
  task-a670cdbf).

## Context

### How prUrl capture works today

- Agents write a `.pr` markdown file via peer-sync; both t3code/claude
  and tmux/codex use the same convention. `readPrUrl` in
  `src/orchestration/peer-sync.ts` is a literal `existsSync + readFile +
  trim` — no parsing of agent stdout exists anywhere.
- `validateAgentPrFiles` in `src/orchestration/runner.ts` runs at phase
  boundaries (and eagerly per-poll for malformed-but-existing files):
  it calls `validateAndFixPrFile` (`src/orchestration/github.ts`) to
  either confirm the file content is a URL or auto-create the PR via
  `gh pr create` and rewrite the file with the URL.
- `refreshAgentStatuses` in `runner.ts` reads `.pr` on every poll into
  `runtime.prUrl`.
- **There is no `gh pr view` / `gh pr list` fallback today.** If the
  `.pr` file is missing, empty, or contains markdown that
  `validateAndFixPrFile` cannot turn into a URL (e.g. `gh pr create`
  failed silently because the PR already existed on the same branch),
  `runtime.prUrl` stays `null`. The three hypotheses for slot-2's
  failure (no `.pr` file written, validate-not-invoked on the codex
  branch, `gh pr create` silent fail) all collapse to the same
  symptom; a single `gh pr list --head <branch>` fallback covers them
  all.
- `prUrl` is **per-agent** (`state.agentStates[name].prUrl`,
  `AgentRuntimeState` in `state.ts:79-108`). The original task body's
  `state.prUrl` grep hint was wrong — the runtime field is nested.

### How `prCommentsReadyForFinalMerge` shortcuts today

- `state.ts:185` declares `prCommentsCoderDispatched?: boolean`.
- Set to `true` at `runner.ts:1012` inside
  `redispatchForPrComments()` — fires on the **first** redispatch
  during a `pr-comments` phase entry. **Never reset** to `false`
  mid-phase.
- Reset to `false` only at `runner.ts:834` inside
  `resetPrCommentsState()`, which runs on fresh phase entry, not on
  new review arrival.
- Read at `phases.ts:485-508` (`prCommentsReadyForFinalMerge`) and
  again in the in-line dispatcher around `phases.ts:691`. The
  shortcut treats `prCommentsCoderDispatched && allAgentsDone &&
  prCommentsQuietSince && !prCodexReviewDeferredSince` as
  "ready-for-final-merge", which matches the *first* review's
  intent but exits the phase before review #2 can arrive.

### How review detection works today

- `runner.ts:~1217` calls `fetchNewPrCommentCount(prUrl,
  lastCheckEpoch)` and redispatches when count > 0. There's no
  review-id tracking; the design is "poll → count new comments since
  last poll → redispatch on count > 0." The `prCommentsLastCheckAt`
  field is updated after each poll.

### Known consumers of the renamed field

- `src/orchestration/state.ts:185` — declaration.
- `src/orchestration/phases.ts:490, 691` — read sites
  (`prCommentsReadyForFinalMerge` and dispatcher shortcut).
- `src/orchestration/runner.ts:834` — reset (in `resetPrCommentsState`).
- `src/orchestration/runner.ts:1012` — write (in `redispatchForPrComments`).
- `src/orchestration/phases.test.ts:426, 440, 457, 477, 1103` — tests.
- `src/orchestration/runner.pr-comments.test.ts:603, 610, 741, 749` — tests.

All of these need the rename in this PR. Historical proposal files
under `docs/proposals/task-cb41bc69-*.md` and `task-dcdb4562.md` mention
the legacy name and stay as historical record (do not edit).

### `migrateState` backfill precedent

`src/orchestration/state.ts:419-436` already implements a
legacy-scalar-to-record migration for the gh-ludics-409 case. The
rename in this PR follows the same shape: read the legacy key, copy
to the new name, `delete` the legacy key from the state object so
`persistState` does not write it back out.

### Existing tests

- `src/orchestration/runner.pr-comments.test.ts:735-749` has the
  `resetPrCommentsState` test (asserts the flag is `false` after
  phase reset). **No test today** simulates two sequential reviews
  with no phase re-entry — that's the gap this PR closes.
- `phases.test.ts` covers the `prCommentsReadyForFinalMerge`
  shortcut shape.

### Why the rename and not just a reset

The original tentative design considered "reset
`prCommentsCoderDispatched = false` after each redispatch." That is
mechanically equivalent but leaves the field name actively misleading
("Dispatched" reads as a perfect aspect — "we have dispatched at some
point" — while the new semantics are present-progressive — "currently
dispatched and not-yet-settled"). Q2 resolution chose the rename so
the predicate flip in `phases.ts` reads naturally and so the test that
asserts `false → true → false → true` flip-flop has a name that
matches the semantics being asserted.

### gh-ludics-479 timing

`lint:state-migration` (proposal at
`docs/proposals/gh-ludics-479-lint-state-migration.md`) is currently
being implemented in slot 2. It will require any field-set change to
`OrchestrationState` (and other allowlisted persisted shapes) to ship
together with a `migrateState()` body diff and a legacy-fixture test
diff, enforced via a snapshot file at
`scripts/snapshots/state.shape.snapshot.json`. ACs 8-10 in this
proposal explicitly satisfy that lint discipline regardless of
landing order: if 479 lands first, this PR's snapshot bump satisfies
the lint; if this PR lands first, the migrate + legacy-fixture work
is already in place when 479 ships.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The work is mechanically straightforward: a helper extraction
(`resolvePrUrl`), a rename + predicate flip across ~6 sites, two new
state fields (`prCommentsRedispatchCount`,
`prCommentsStuckWarnedAt`), one new config field
(`prCommentsStuckThreshold`), one journal event, one warning event,
two new tests, one legacy-fixture test, one snapshot bump.

Suggested commit shape:

1. **Rename + predicate flip** (no semantic change yet, except for
   the name). Adds `prCommentsCoderActive`,
   `prCommentsRedispatchCount`, the `migrateState` backfill, and the
   legacy-fixture test. All existing tests updated to use the new
   name. CI must stay green at this commit.
2. **Settle-detector wire-through** in `refreshAgentStatuses` so
   `prCommentsCoderActive` flips back to `false` when the coder
   settles, plus the sequential-reviews test.
3. **`resolvePrUrl` extraction + `gh pr list` fallback,** plus the
   blanked `.pr` file recovery test.
4. **Journal event + stuck-phase warning,** plus
   `prCommentsStuckThreshold` config field and `prCommentsStuckWarnedAt`
   dedup.
5. **Snapshot bump** to satisfy `lint:state-migration` (squash with
   commit 1 if 479 has not merged yet).

The split is convenience; reviewer may collapse if they prefer one
diff. The constraint is that AC 4 (rename) and AC 8 (migrate
backfill) must ship in the same PR — see gh-ludics-479 discipline
above.

## Scope

**In scope (this PR):**

- `src/orchestration/runner.ts` — `resolvePrUrl` extraction,
  `refreshAgentStatuses` rewire, settle-detector flip-back, journal
  event emission, stuck-phase warning emission, write-site renames.
- `src/orchestration/state.ts` — field rename, new fields
  (`prCommentsRedispatchCount`, `prCommentsStuckThreshold`,
  `prCommentsStuckWarnedAt`), `migrateState` backfill.
- `src/orchestration/phases.ts` — predicate flip at lines ~490 and
  ~691, plus the redispatch-count precondition.
- `src/orchestration/runner.pr-comments.test.ts` — sequential-reviews
  test, blanked `.pr` test, rename consequential edits.
- `src/orchestration/phases.test.ts` — rename consequential edits,
  legacy-fixture test (or sibling `state.migrate.test.ts`).
- `scripts/snapshots/state.shape.snapshot.json` — bump if
  `lint:state-migration` has shipped.

**Out of scope (separate tasks):**

- Full RCA on slot-2's `.pr` file (Q3 deferred).
- Adapter parity beyond what `resolvePrUrl` requires (cf.
  task-a670cdbf).
- Substantive-pane-change stall detection (sibling task-a670cdbf).
- Migrating currently-stuck slots — manual `ludics nudge` is the
  operator workflow.

**Dependencies:**

- Coordinate with **gh-ludics-479** (`lint:state-migration` in slot
  2). ACs 8-10 satisfy that lint regardless of landing order; if
  479's snapshot file does not exist yet at merge time, AC 9 is a
  no-op and reviewer paragraph compliance is the gate.
- **task-a670cdbf** (substantive-pane-diff stall detection) is the
  sibling that closes the "coder running but stalled" half of the
  failure mode; this task closes the "coder never dispatched" half.
  Merge order does not matter.
