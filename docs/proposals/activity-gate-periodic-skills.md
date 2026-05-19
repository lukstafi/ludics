# Activity gate for periodic skills

## Goal

Stop wasting Mag context on no-op periodic work. Briefing, feedback-digest,
adopt-sessions, and verify-completion all currently fire on schedule even when
nothing has changed for the user — producing duplicate morning briefings,
empty feedback digests, and verify-completion rounds against tasks that have
not advanced. Generalize today's single-purpose health-check gate into a
per-skill activity gate, applied at the same Tier-1 dispatch point so the
skill worker is never even forked when its signal is unchanged. Also raise
`HEALTH_GATE_THRESHOLD` (50 → 300) so it remains effective after the
keepalive's per-tick event volume increased.

Issue: https://github.com/lukstafi/ludics/issues/538

## Acceptance Criteria

### Generalized gate module

1. `src/health-gate.ts` exports a generalized
   `shouldSkipPeriodic({ gateName, snapshotPath, signal, threshold })` (or an
   equivalent named export — the existing `shouldSkipHealthCheck` may stay as
   a thin wrapper over it) such that:
   - `signal` is a function returning a comparable value (number for counts,
     number for epochs, string for fingerprints).
   - The gate reads a JSON snapshot at `snapshotPath` with shape
     `{ timestamp: <ISO-8601 string>, signal: <value> }`.
   - First-run (no snapshot file) returns `skip: false` (fail open).
   - Snapshot missing the `signal` field returns `skip: false` (fail open).
   - For numeric signals, `delta < 0` returns `skip: false` (fail open;
     mirrors the existing count-shrank arm).
   - For epoch signals, a stored value in the future returns `skip: false`
     (fail open; clock-skew defence).
   - For fingerprint signals, equality to the stored fingerprint returns
     `skip: true`; inequality returns `skip: false`.
   - For threshold-style numeric signals, `delta < threshold` returns
     `skip: true`; `delta >= threshold` returns `skip: false`.
   - The decision object carries the same diagnostic fields the existing
     `HealthGateDecision` exposes (`skip`, `reason`, plus the
     gate-type-appropriate value pair). The exact field names are an
     implementation choice; the dashboard reader (see below) follows
     whatever names the gate emits.

2. `HEALTH_GATE_THRESHOLD` is raised from `50` to `300` in `src/health-gate.ts`.
   `src/health-gate.test.ts` is updated so the existing positive/negative
   test points still bracket the new threshold (one keepalive tick is ~50
   lines × 6 ticks = 300, so idle days still skip).

### Gate wiring — Tier-1 dispatch

3. In `src/mag.ts` `resolveQueueRequestCommand` (the `executeProgrammatic`
   branch), each of the three new gated actions has an arm parallel to the
   existing `health-check` arm:
   - `briefing` — gate signal `lastUserActionEpoch`, threshold = 18h.
     Skip when no qualifying user action has advanced since the prior
     briefing snapshot AND the latest qualifying user action is older
     than `(now - 18h)`. The "no progress since prior snapshot" arm is
     the proposal's core skip case; the 18h staleness arm is the
     slow-decay safeguard so we never permanently suppress a briefing
     on a repo whose user-action clock barely moves.
   - `adopt-sessions` — gate signal `unclassifiedFingerprint`, skip when
     unchanged since the last run.
   - On skip, emit `<gate>_skipped` (`briefing_skipped`,
     `adopt_sessions_skipped`) carrying at minimum the same shape as
     today's `health_check_skipped` (`reason`, the current and prior signal
     values), and return `null` from `resolveQueueRequestCommand` to
     short-circuit the dispatch.
   - On run, the gate's caller is responsible for refreshing the snapshot
     after the skill completes — either at the point of dispatch or after
     the worker result is recorded. Snapshots persist under
     `mag/<gate>-last.json` (e.g. `mag/briefing-last.json`,
     `mag/adopt-sessions-last.json`).

4. The pre-existing `health-check` arm is preserved with its current
   `eventsJsonlLines` signal and threshold semantics. Health is NOT gated
   on user-action — that would silence the deadlines / hung-agents /
   federation-decay alerts the gate exists to produce. (Issue: out of
   scope.) The only health-check change is the threshold bump (AC 2).

### Gate wiring — queue-side for feedback-digest

5. `src/mag.ts` `tryQueueFeedbackDigest` is extended with a feedback-digest
   activity gate: if `feedback/` (top-level) contains zero files, the call
   returns `{ queued: false, reason: "no feedback files" }` and emits a
   `feedback_digest_skipped` event. This is the queue-side gate (not the
   dispatch-side gate) — the worker is never forked when the surface is
   empty, satisfying the issue's "never forked when empty" requirement.
   No snapshot file is needed for this gate; it reads the live
   filesystem signal each call.

### User-action signal computation (briefing gate)

6. The `lastUserActionEpoch` signal is the maximum of:
   - `notify_incoming` event timestamps from `journal/events.jsonl`.
   - Non-Mag-authored commits touching task frontmatter — commits to
     `tasks/*.md` whose author is not the Mag identity (recognized by a
     `Co-Authored-By: Claude` trailer) AND at least one of whose diff hunks
     overlaps the file's YAML frontmatter line range at that commit. A
     body-only edit does not advance the signal. Bounded by a look-back
     window appropriate to the 18h threshold.
   - Queue request entries whose `action` is NOT in `MAG_AUTO_ACTIONS`.

7. `MAG_AUTO_ACTIONS` is a denylist constant covering the known periodic
   and auto-followup actions: at minimum
   `briefing`, `feedback-digest`, `health-check`, `adopt-sessions`,
   plus the auto-`/compact` follow-up (which is enqueued as
   `action: "message"` with content `"/compact"` — the denylist matches
   the `(action, content)` pair for messages, or the action alone for
   the others). The exact set is enumerable in one place
   (`src/mag.ts` or a sibling module) and referenced from the user-action
   signal computation. Adding a new periodic action means adding one
   string to this list — no further audit required.

   Rationale for denylist over a first-class `QueueAction.source` field:
   the ~20 `queueRequest` call-site audit is explicitly out of scope for
   this PR. Promotion to a `source` field remains an option if the
   denylist proves fragile.

### Gate-skip events are not user activity

8. Gate-skip events (`health_check_skipped`, `briefing_skipped`,
   `feedback_digest_skipped`, `adopt_sessions_skipped`) MUST NOT count
   toward any user-action signal. Implementation: all gate-skip events
   carry a `meta: { gateSkip: true }` field (or equivalent — a shared
   marker on the event envelope), and the signal-computation helper
   in `src/health-gate.ts` excludes events with this marker uniformly.
   The existing `GATE_INTERNAL_EVENT_MARKERS` per-event-type allowlist is
   replaced by the unified marker (or kept as a transitional fallback —
   implementation's choice, provided the test in `health-gate.test.ts`
   covering `health_check_skipped` exclusion still passes).

### adopt-sessions fingerprint

9. The adopt-sessions gate reuses `adoptSessionsFingerprintData` in
   `src/mag.ts` and compares against a snapshot at
   `mag/adopt-sessions-last.json` (the standardized envelope shape, distinct
   from the existing `mag/adopt-sessions-unclassified.hash` whose
   purpose — tracking the last *change* — is preserved). If implementation
   finds it cleaner to merge the two files, the proposal does not block
   that, provided the existing fingerprint-unchanged consumers (if any)
   continue to work.

### verify-completion activity

10. The verify-completion gate signal is `taskLastActivityEpoch`, computed
    per target task as the max of:
    - Git HEAD commit time on the task's project worktree (resolved via
      the task's frontmatter `project` field through the standard
      worktree-path resolution Mag already uses elsewhere).
    - `slot_resume` events scoped to the task ID (the existing event
      carries `task` in its payload).
    - Slot assignment events (`slot_assign`) scoped to the task ID
      (existing event also carries `task`).
    Skip the verify-completion request when `taskLastActivityEpoch` has not
    advanced since the previous queued check (per-task snapshot under
    `mag/verify-completion-last/<task-id>.json`).

    `.peer-sync/` mtime is intentionally NOT included in this PR
    (revisit if reviewer-only rounds without a commit get suppressed).

### Manual CLI invocation bypass

11. Manual CLI invocations of any gated skill — `ludics mag briefing`,
    `ludics mag adopt-sessions`, `ludics mag feedback-digest` (where
    applicable), `ludics mag health-check`, `ludics mag verify-completion
    <task>` — bypass the gate. Mechanism: the gate fires only inside
    `resolveQueueRequestCommand`'s `executeProgrammatic` branch / inside
    the queue-side `tryQueueFeedbackDigest` helper. CLI commands that
    enqueue requests still go through the queue (and therefore the gate);
    CLI commands that run the skill directly (the existing `ludics mag
    health-check` / `ludics mag briefing` programmatic paths in
    `src/mag.ts`) MUST NOT pass through the gate. The proposal does not
    require a new exempt-flag; the placement of the gate at the dispatch
    point is itself the bypass mechanism. Add a test asserting that the
    programmatic CLI path runs the skill regardless of the gate snapshot.

### Dashboard "skipped because X" surface

12. `src/dashboard-server.ts` exposes a read-only API endpoint
    (suggested: `GET /api/gate-skips`) returning a JSON aggregation of
    the most recent N gate-skip events from `journal/events.jsonl`,
    grouped by gate name, each entry including `gate`, `timestamp`,
    `reason`, and the signal value pair. The implementation reads
    `events.jsonl` directly — no new persistence surface, no new JSON
    state file. The aggregator stays compact (~50 LOC of read-side code
    plus a small panel hook).

13. The dashboard UI renders a compact "Skipped because X" card listing
    the latest skip per gate. The exact rendering layer (the existing
    dashboard renders from `dashboard/data/*.json`; see
    `src/dashboard.ts`) is the implementer's choice — either the
    aggregator writes into the existing `dashboard/data/health.json`
    alongside the current health surface, or a new sibling file
    `dashboard/data/gate-skips.json` is added (preferred: extend the
    existing health surface so the card sits adjacent to the health
    diagnostics it complements). No new persistent state file is
    introduced beyond the dashboard data artifact.

### Tests

14. `src/health-gate.test.ts` covers the generalized gate:
    - First-run fail-open per signal type (count, epoch, fingerprint).
    - Snapshot missing the signal field → fail open.
    - Numeric `delta < 0` → fail open.
    - Epoch in future → fail open.
    - Fingerprint unchanged → skip; changed → run.
    - Count `delta < threshold` → skip; `delta >= threshold` → run.
    - `meta.gateSkip: true` events excluded from numeric/epoch
      signals (the existing `health_check_skipped` test is preserved
      or migrated to the new marker).
    - `HEALTH_GATE_THRESHOLD = 300` and the existing health-check tests
      still pass against the new threshold.

15. `src/mag.ts` test coverage (new or extended tests):
    - Briefing gate skip-arm emits `briefing_skipped` and returns null
      from `resolveQueueRequestCommand`; run-arm dispatches normally
      and updates the snapshot.
    - `tryQueueFeedbackDigest` skips when `feedback/` is empty and
      emits `feedback_digest_skipped` (existing cooldown + pending
      branches stay green).
    - adopt-sessions gate skips when the fingerprint is unchanged.
    - Manual CLI invocation of `ludics mag briefing` (and one peer)
      runs the skill regardless of the gate snapshot.
    - `MAG_AUTO_ACTIONS` denylist excludes the listed actions from the
      user-action signal; a user-initiated `elaborate` (or any non-listed
      action) does count.

16. Dashboard surface test: `GET /api/gate-skips` (or whatever endpoint
    name lands) returns a JSON document covering at least one skip per
    gate when the events file contains them, and an empty/zeroed
    structure otherwise.

### Event-type stability

17. The five gate-skip event types — `health_check_skipped`,
    `briefing_skipped`, `feedback_digest_skipped`, `adopt_sessions_skipped`,
    and `verify_completion_skipped` — are committed names. Existing
    readers of `health_check_skipped` continue to work unchanged. (The
    unified `meta.gateSkip: true` marker is additive — it sits alongside
    the per-event-type name, not in place of it.)

## Context

### Existing gate surface

- `src/health-gate.ts` — `shouldSkipHealthCheck` is the only gate today.
  Hard-codes `mag/health-last.json`, `journal/events.jsonl` line count,
  and `HEALTH_GATE_THRESHOLD = 50`. `countGateEligibleLines` already
  implements the marker-based exclusion pattern (see
  `GATE_INTERNAL_EVENT_MARKERS`).
- `src/health-gate.test.ts` — covers first-run fail-open, count-shrank
  fail-open, threshold edges, and `health_check_skipped` exclusion. The
  generalized gate must keep all of these green.

### Tier-1 dispatch and skill arms

- `src/mag.ts` `resolveQueueRequestCommand` — three-tier dispatch.
  Tier 1 (pre-hooks) is where `health-check` skip lives today: gate runs
  before the skill command resolves; on skip, an event is emitted and
  `null` is returned so the queue popper treats the request as
  already-resolved. Briefing and adopt-sessions already have pre-hook
  context-precompute calls here (`briefingPrecomputeContext`,
  `adoptSessionsPrecomputeContext`); the gate arms slot in next to them.
- The auto-`/compact` follow-up after health-check (queue-head insertion
  via `queueRequestAtHead`) is preserved unchanged — it's coupled to the
  health-check, not to the gate.

### Queue-side gate for feedback-digest

- `src/mag.ts` `tryQueueFeedbackDigest` — already has the
  `queueHasPendingFeedbackDigest` + `feedbackDigestCooldownRemaining`
  layers. The new file-count check adds a third pre-enqueue arm.
- The denylist `MAG_AUTO_ACTIONS` is exported here (or from a sibling
  helper) so the briefing user-action signal can import it.

### adopt-sessions fingerprint

- `src/mag.ts` `adoptSessionsFingerprintFile` returns
  `mag/adopt-sessions-unclassified.hash` — used today to detect when the
  unclassified-sessions set changes. `adoptSessionsFingerprintData`
  computes the stable hash from `sessions.json`.

### User-action signal anchors

- `src/notify.ts` — `notify_incoming` event emitted on incoming ntfy
  message (canonical user-via-notification anchor). The event is in
  `events.jsonl`, so the signal computation tails events.jsonl rather
  than the raw `notifications.jsonl`.
- Queue requests in `mag/queue.jsonl` (or the events the queue emits —
  `queue_request` carries the `action`). Filtering against
  `MAG_AUTO_ACTIONS` produces the user-initiated subset.
- Task frontmatter edits: `tasks/*.md` mtime + `git log --format="%an %at"`
  on the file gives the recent-non-Mag-author timestamp.

### verify-completion task anchors

- `slot_resume` (`src/slots/index.ts:1403`) — carries `task` field.
- `slot_assign` (`src/slots/index.ts:456`) — carries `task` field.
- `slot_auto_start` (`src/mag.ts:2515`) — carries `task` field.
- Git HEAD commit time on the task's project worktree: resolved via the
  existing project-path resolution Mag uses for worktree management
  (e.g., the same machinery `src/orchestration/worktrees.ts` uses for
  default-branch lookup).

### Dashboard

- `src/dashboard.ts` `generateHealthData` writes
  `dashboard/data/health.json` — the existing health surface the new card
  most naturally extends.
- `src/dashboard-server.ts` serves the dashboard and exposes the existing
  `/api/*` endpoints (cluster, slots, tasks, queue). The aggregator
  endpoint sits among these.

### HEALTH_GATE_THRESHOLD rationale

The original 50 was calibrated against the keepalive's event volume at
the time. Per-tick volume has since drifted upward (federation, settled
detection, orchestration-state events); empirically a quiet keepalive
tick now lands close to 50 lines, defeating the gate. 300 = 50 × 6 ticks
gives an idle day a comfortable margin to still skip.

## Approach (optional)

*Suggested approach — agents may deviate if they find a better path.*

Recommended ordering:

1. Extract the generalized `shouldSkipPeriodic` from `shouldSkipHealthCheck`,
   keep the latter as a thin wrapper. Bump the threshold (one constant +
   the matching test points).
2. Add the unified `meta.gateSkip: true` marker to existing
   `health_check_skipped` emissions and update the events-filter to use
   the marker. Keep the `GATE_INTERNAL_EVENT_MARKERS` string-match as a
   transitional fallback if test compatibility wants it.
3. Wire `tryQueueFeedbackDigest`'s file-count gate. This is the simplest
   gate — landing it first proves the snapshot-less variant works.
4. Introduce `MAG_AUTO_ACTIONS` and the briefing user-action signal
   computation. Add the briefing gate arm in `resolveQueueRequestCommand`.
5. Add the adopt-sessions gate arm (fingerprint signal).
6. Add the verify-completion gate (per-task snapshots — a small
   bookkeeping layer over `shouldSkipPeriodic`).
7. Dashboard aggregator endpoint + card. Lean on the existing
   `dashboard/data/health.json` writer rather than adding a new file.
8. Tests in lockstep with each step.

The cross-cutting concern is the `meta.gateSkip: true` migration — once
in place, signal computation reduces to "events.jsonl lines whose
`meta.gateSkip` is not true".

## Scope

**In scope** (this PR):
- Generalized gate module + threshold bump.
- Briefing, feedback-digest (queue-side), adopt-sessions, verify-completion
  gate wiring.
- `MAG_AUTO_ACTIONS` denylist.
- Unified `meta.gateSkip: true` event marker.
- Dashboard "skipped because X" surface (small aggregator + card).
- Tests for all of the above.

**Out of scope**:
- Removing launchd triggers (the trigger still fires; the gate is the filter).
- Replacing briefing's amend/new (`Status: amend` vs `Status: new`) branching.
- Promoting `MAG_AUTO_ACTIONS` to a first-class `QueueAction.source` field
  (deferred follow-up if the denylist proves fragile).
- Including `.peer-sync/` mtime in verify-completion activity
  (deferred follow-up if reviewer-only rounds without a commit get
  suppressed).
- Auditing the ~20 `queueRequest` call sites in `src/mag.ts` for a
  per-call `source: "auto" | "user"` tag (explicit out of scope per
  resolved question Q1).

**Dependencies**: none. Standalone change against `main`.
