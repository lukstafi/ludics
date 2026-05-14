# Queue delivery-confirmation sentinel — stop silently dropping skill items delivered right before auto-compaction

## Goal

Queue items delivered into the Mag pane immediately before an auto-compaction
(or a crash mid-turn, or a dropped tmux input) are silently lost: the keystrokes
land in the pane buffer, `maybeFeedMagQueue` considers the item done, but the
skill never executes and no result JSON is ever written. On 2026-05-14 the
morning daily briefing was lost this way — `req-1778738655-2571000001` was
delivered at `08:06:28`, the session auto-compacted before the skill started,
and the next delivery (`/ludics-feedback-digest`) silently consumed the slot.

`maybeFeedMagQueue()` is fire-and-forget: `triggerSkill` returns truthy when
keystrokes *land in the pane*, not when Mag *processes the skill and writes a
result*. The existing `_retry_count` / `queueReinsertHead` requeue branch only
covers `triggerSkill` **send failure** (tmux unreachable) — not "delivered but
never executed."

Resolves https://github.com/lukstafi/ludics/issues/526.

## Acceptance Criteria

1. **Delivery sentinel written.** On the `sent` success path of
   `maybeFeedMagQueue()`, a `mag/last-delivered.json` sentinel is written
   containing at least `{ requestId, command, line, deliveredAt }`. `requestId`
   is the id `queuePopSkill` already writes to `mag/current-request-id`.

2. **Reconciliation pass confirms or re-queues.** A reconciliation step runs
   each keepalive tick (in the same block as `clearStaleSettled()` /
   `maybeFeedMagQueue()`):
   - If `mag/last-delivered.json` exists **and** `mag/results/<requestId>.json`
     exists → delivery confirmed; the sentinel is cleared.
   - Else if the sentinel's `deliveredAt` is older than the threshold → the
     delivery is treated as lost: `line` is re-queued through the **existing**
     `queueReinsertHead` + `_retry_count` increment/cap path (honoring
     `mag.max_requeue_retries` / `DEFAULT_MAX_REQUEUE_RETRIES`), the sentinel is
     cleared, and a `mag_queue_requeued` event (or `mag_queue_dropped` when the
     retry cap is hit) is emitted.
   - Else (sentinel present, no result, under threshold) → left untouched for
     the next tick.

3. **Result-existence is checked before re-queue.** The "delivery confirmed"
   branch runs first; a skill that completed late (within the threshold window)
   is cleared as confirmed and never double-queued.

4. **Delivery is gated on the sentinel.** `maybeFeedMagQueue()` does **not**
   deliver the next skill item while `mag/last-delivered.json` is unresolved
   (no matching result JSON) and under threshold. The guard is placed after the
   `isMagSettled() || isMagReady()` and `queuePending()` checks and before
   `queuePopSkill()`. Delivery resumes once the sentinel is cleared (by
   confirmation or by reconciliation re-queue).

5. **Threshold is a hard-coded constant.** A `DELIVERY_CONFIRM_TIMEOUT_MS`
   constant in `src/mag.ts` (~8–10 min), alongside `DEFAULT_MAX_REQUEUE_RETRIES`
   — **not** a `mag` config key (user decision, 2026-05-14).

6. **Requeue-with-retry-cap logic is shared**, not duplicated, between the
   existing send-failure branch of `maybeFeedMagQueue` and the new
   reconciliation pass.

7. **`queuePopSkill` exposes the requestId.** Its return type (currently
   `{ command, line }`) is extended so the caller can capture `requestId` into
   the sentinel at delivery time — it must not be re-read from
   `mag/current-request-id` later, since the next `queuePopSkill` overwrites
   that file.

8. **Dashboard shows in-flight items.** The `/api/queue` GET handler in
   `src/dashboard-server.ts` additionally reads `mag/last-delivered.json` and,
   when it is present *and* has no matching `mag/results/<requestId>.json`,
   includes it in the response (e.g. an `inFlight` field). `renderQueue()` in
   `templates/dashboard/mag.html` renders it as an **"In flight"** section
   between **Pending** and **Recent**, showing the delivered `command` and
   `deliveredAt`. The section disappears once the sentinel is cleared.

9. **Existing behaviour preserved.** The send-failure requeue branch, the
   `mag_queue_feed` event emit, the programmatic-queue drain, and the
   settled-sentinel atomic claim all continue to work as before.

10. **Tests cover the new paths.** Unit/integration tests for: sentinel written
    on delivery; reconciliation confirms when result exists; reconciliation
    re-queues past threshold and respects the retry cap; delivery gated while
    sentinel unresolved under threshold; delivery resumes after sentinel
    cleared.

## Context

How things work now (all in `~/ludics`, verified against HEAD):

- **`src/mag.ts` — `maybeFeedMagQueue()`**: after the
  `isMagSettled()/isMagReady()` and `queuePending()` guards and the
  settled-sentinel atomic claim, it calls `queuePopSkill()`, builds the
  delivered line via `applyQueueFeedPrefix()`, and calls
  `triggerSkill(MAG_SESSION_NAME, delivered)`. On `sent` truthy → emits
  `mag_queue_feed` and returns. The `else` arm is the existing send-failure
  requeue: parses `_retry_count`, reads `mag.max_requeue_retries` (default
  `DEFAULT_MAX_REQUEUE_RETRIES = 3`), and either drops
  (`mag_queue_dropped`) or `queueReinsertHead`s with an incremented
  `_retry_count` (`mag_queue_requeued`). This `else` arm is the retry-cap logic
  to factor out and share.

- **`src/mag.ts` — `queuePopSkill()`**: calls `queuePopExpected()`, writes
  `request.id` to `mag/current-request-id`, resolves the command via
  `resolveQueueRequestCommand(request, true)`, and returns `{ command, line }`.
  `resolveQueueRequestCommand` returns `null` for programmatic-only actions
  (`message`, `adapter-followup`, `complete-task`), so `queuePopSkill` only ever
  returns skill commands — the sentinel is skill-only by construction. Confirm
  this when implementing rather than assuming.

- **`src/mag.ts` — keepalive main tick** (around line 2908–2918): runs
  `drainProgrammaticQueueHead()` → `clearStaleSettled()` →
  `maybeFeedMagQueue()` → `maybeNudgeStalledMag()`. The new reconciliation pass
  slots into this block.

- **`src/mag.ts` — `applyQueueFeedPrefix()` / `drainProgrammaticQueueHead()`**:
  programmatic entries are drained earlier in the tick and never reach
  `maybeFeedMagQueue`'s pop — context for why the sentinel is skill-only.

- **`src/queue.ts`**: `queueReinsertHead(line)` reinserts at the front of
  `queue.jsonl`; `recentResults(limit)` reads `mag/results/*.json` sorted by
  mtime; `writeResult(requestId, ...)` writes `mag/results/<requestId>.json`
  (the naming the reconciliation pass must match).

- **`src/dashboard-server.ts` — `pathname === "/api/queue"` GET handler**:
  returns `{ pending: queueList(), results: recentResults(20) (output
  stripped) }`. A popped-but-not-completed request is in neither list.

- **`templates/dashboard/mag.html`**: `renderQueue(pending, results)` (called
  from the `fetch('/api/queue')` handler) renders **Pending** then **Recent**
  sections. Signature and caller extend to pass the in-flight payload.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The design is laid out in detail in the task file's Tentative Design (verified
against HEAD) and reflects two resolved user decisions: the threshold is a
hard-coded `DELIVERY_CONFIRM_TIMEOUT_MS` constant, and delivery is gated on the
sentinel. One mechanism — the single-valued `mag/last-delivered.json` sentinel
— covers both the retry gap and the dashboard-visibility gap.

The gating (AC 4) is what makes the single-valued sentinel correct by
construction: because `maybeFeedMagQueue` will not deliver a second skill while
the sentinel is unresolved and under threshold, at most one delivery is ever in
flight, so the sentinel is never overwritten before it is reconciled. This is
the substantive half of the fix — Mag is single-threaded, so delivering item B
while A is in flight adds no parallelism; B just lands in the lossy pane buffer
behind A. Gating keeps B in the durable `queue.jsonl`.

Re-queue (full re-run) rather than a nudge: the dominant failure mode is "never
executed," so there is no partial work to flush, and a nudge cannot survive a
compaction or crash. Re-queue is safe because the orchestrator skills are
re-entrant — their duplicate/idempotency routing means a re-queued skill that
*had* completed detects that and writes the result cheaply.

Worst-case bound to call out in the PR: a skill that truly hangs (never writes a
result, never crashes) blocks the next item for one threshold interval, gets
re-queued, and after `mag.max_requeue_retries` is dropped with
`mag_queue_dropped`.

Edge cases to handle (all enumerated in the task file): result appearing after
re-queue (check result-existence before re-queuing, clear sentinel the moment a
result is seen); sentinel-write vs result-write ordering (write sentinel on the
`sent` path, reconciliation reads result-existence first); stale sentinel from a
crashed keepalive process (age-based reconciliation handles it identically);
`current-request-id` overwrite (capture requestId into the sentinel at delivery
time); dashboard staleness (an in-flight row that disappears between polls needs
no special handling).

The issue's rejected alternative — reconciling from `events.jsonl`
`mag_queue_feed` lines — is not pursued: the sentinel is simpler and avoids
re-parsing the event log every tick.

## Scope

In scope: `src/mag.ts` (`maybeFeedMagQueue`, `queuePopSkill`, keepalive tick,
new constant + reconciliation + shared requeue helper), `src/dashboard-server.ts`
(`/api/queue` handler), `templates/dashboard/mag.html` (`renderQueue` + caller),
and tests.

Out of scope: a heartbeat mechanism for genuinely long-running skills (none
exist today; the threshold is safe for current skills — briefing /
feedback-digest finish in well under a minute). Reconciling from the event log.
Making the threshold configurable.

No dependencies on other tasks.
