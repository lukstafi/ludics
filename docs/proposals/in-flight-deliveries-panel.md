# Replace sentinel+retry delivery confirmation with passive "Unresolved deliveries" panel

## Goal

Supersede the gh-ludics-526 delivery-confirmation machinery (single-file
sentinel, 10-minute timeout, retry-cap loop). Three failure modes have been
observed live (Tier-3 wedge, post-boot delivery race, worker outrunning the
10-min ceiling) and in every case the auto-retry compounded the original
error rather than recovering from it. Replace the auto-recovery with a
**passive `mag/in-flight/` directory** surfaced as an "Unresolved deliveries"
panel on the dashboard. Each in-flight delivery either resolves naturally
(its result JSON appears) or is resolved by the user (Re-fire / Discard).
The gate still serializes deliveries; nothing auto-times-out, nothing
auto-re-queues, nothing auto-drops.

A defense-in-depth **pre-send result-file dedup check** in
`deliverPoppedSkill` makes the rollback-on-send-failure path provably safe
against double-fire and also formalises a manual-bypass pattern (Mag
pre-writes a result with a skip-marker status to suppress a queued request).

Tracks https://github.com/lukstafi/ludics/issues/535. Supersedes
`docs/proposals/queue-delivery-confirmation-sentinel.md` (gh-ludics-526).

## Acceptance Criteria

A1. `deliverPoppedSkill` writes `mag/in-flight/<requestId>.json` (one file
    per outstanding delivery) instead of `mag/last-delivered.json` when
    `popped.expectsResult !== false`. The record carries `requestId`,
    `command`, `line`, and `deliveredAt` (ISO 8601, `Z`-suffixed, no
    milliseconds — same format as today).

A2. `reconcileInFlight` (renamed from `reconcileLastDelivered`) is purely
    passive: for each record in `mag/in-flight/`, delete the record iff
    `mag/results/<requestId>.json` exists. **Never re-queues. Never times
    out. No `.reconciling` atomic-claim file.** Passive deletion is
    idempotent across concurrent callers.

A3. `deliveryGateBlocked()` returns true iff at least one record in
    `mag/in-flight/` has no matching result JSON. No age check. Same
    serialization guarantee as today (only one delivery in flight at a
    time, by gate construction).

A4. The following symbols, configs, and events are removed from
    `src/mag.ts`. The delivery-confirmation test suite drops the describe
    blocks that exercise them.

    Removed from `src/mag.ts`:
    - The constant `DELIVERY_CONFIRM_TIMEOUT_MS` (currently mag.ts:109).
    - The function `requeueWithRetryCap`.
    - The single-file sentinel helpers `lastDeliveredFile`,
      `writeLastDelivered`, `readLastDelivered`, `clearLastDelivered`,
      `parseSentinelFile`, `deliveredAtAgeMs` (replaced by the
      directory-shaped helpers in A1/A2/A3).
    - The `.reconciling` atomic-claim machinery inside the prior
      `reconcileLastDelivered`.
    - Emission of `mag_queue_requeued` and `mag_queue_dropped` events.

    Removed from config:
    - The `mag.max_requeue_retries` key and the
      `DEFAULT_MAX_REQUEUE_RETRIES` constant in `src/mag.ts` (no longer
      consumed).

    Removed from `src/mag-delivery-confirmation.test.ts`:
    - `reconcileLastDelivered — atomic claim guards against double-requeue`
      (entire describe block).
    - `requeueWithRetryCap — shared retry-cap logic (AC 6)` (entire
      describe block).
    - The "past timeout → re-queue" and "drop after cap" cases inside
      `reconcileLastDelivered (AC 2, AC 3)` (the describe is renamed to
      `reconcileInFlight` and retains only the "result exists → clear"
      case).
    - The age-based branch inside `deliveryGateBlocked (AC 4)` (the gate
      becomes purely "record exists with no result").

A5. **Send-failure rollback.** In `deliverPoppedSkill`, when
    `triggerSkill` returns false, the path becomes
    `queueReinsertHead(popped.line)` — the *verbatim* original line, no
    `_retry_count`, no cap, no drop, no event. The queue not draining is
    the user-facing signal (the dashboard's pending queue count grows).

A6. **Pre-send result-file dedup check.** In `deliverPoppedSkill`, after
    `applyQueueFeedPrefix(popped.line, popped.command)` and **before** the
    `send(...)` call, if `popped.expectsResult !== false && existsSync(magResultFile(popped.requestId))`
    is true:

    - Emit
      `{ event_type: "mag_queue_already_resolved", source: "keepalive", scope: "mag", message: "skipped: <delivered>" }`.
    - Return `true` (the pop is consumed; no `send`, no in-flight record
      written).

    For Tier-3 items (`expectsResult === false`) the check is unconditionally
    skipped — there is no result file expected, so no idempotency contract
    to enforce.

A7. **Dashboard "Unresolved deliveries" panel** in
    `templates/dashboard/mag.html`:

    - The panel renders the array returned by the new
      `listInFlightDeliveries()` helper (see A8 for the wire shape), sorted
      by `deliveredAt` ascending (oldest first — predictable when the user
      must choose between Re-fire and Discard).
    - Each row shows the existing record fields (command, `deliveredAt`)
      plus two per-row action buttons: **Re-fire** and **Discard**.
    - Button wiring follows the existing per-row pattern from the Pending
      section (`mag-queue-action promote` / `edit-cancel`): same styling,
      same `escapeHtml` discipline, same `fetch(..., { method: "POST" })`
      shape.
    - A count badge appears near the panel header when the array length is
      `> 0`. Badge only — no audible cue, no desktop notification, no
      threshold-based escalation (per resolved Q1).
    - Empty-state guard at mag.html:113 updates from `!inFlight` to
      `inFlight.length === 0` (the field is now an array, never null).

A8. **Two new POST endpoints** in `src/dashboard-server.ts`, modelled on
    the existing `/api/queue-promote` and `/api/queue-cancel` handlers:

    - `POST /api/in-flight-refire?id=<requestId>`:
      1. Validate `id` against `QUEUE_ID_RE` (the existing regex shared
         with promote/cancel). Reject with `400` on mismatch.
      2. Read the record from `mag/in-flight/<id>.json`. Missing → `404`.
      3. If `mag/results/<id>.json` already exists, delete the in-flight
         record and return `{ status: "already-completed" }` — the result
         landed in the dashboard-read → click window; do not re-queue.
      4. Otherwise: parse the record's `line` (JSON), mint a fresh request
         id (same `req-<epoch>-<counter>` shape as `queue.ts`), set
         `re-fired-from: <original-id>` on the new payload, call
         `queueReinsertHead(<new-line>)`, then `clearInFlight(<original-id>)`,
         then emit `mag_in_flight_refired`. Return
         `{ status: "refired", newId: <fresh-id> }`.

    - `POST /api/in-flight-discard?id=<requestId>`:
      1. Validate `id` against `QUEUE_ID_RE`. Reject with `400` on mismatch.
      2. `clearInFlight(id)` (unlink; ENOENT is a no-op — idempotent).
      3. Emit `mag_in_flight_discarded`. Return `{ status: "discarded" }`.

    The existing `/api/queue` handler swaps `inFlight: readInFlightDelivery()`
    for `inFlight: listInFlightDeliveries()` and updates its JSDoc to cite
    gh-ludics-535. The wire field name stays `inFlight` but its type is now
    `InFlightDelivery[]` (always an array, possibly empty), not the prior
    `InFlightDelivery | null`. Update `src/dashboard.test.ts`
    `describe("dashboard HTTP GET /api/queue — inFlight sentinel (AC 8)")`
    to the array shape, and add two new describes for the new endpoints.

A9. **Briefing-prep orphan absorption.** Extend `briefingPrecomputeContext`
    in `src/mag.ts` (the existing briefing-context generator, currently
    around mag.ts:1844) with a new "Unresolved Deliveries (orphans)"
    section. An in-flight record is an *orphan* iff its `requestId` is no
    longer present in `queue.jsonl` AND `mag/results/<requestId>.json` does
    not exist. For each orphan record, the briefing-prep step:

    1. Appends a stanza into `mag/briefing-context.md` summarising the
       record (requestId, command, line, deliveredAt).
    2. Calls `clearInFlight(requestId)` to remove the in-flight file.

    Non-orphan in-flight records (still in the queue, awaiting delivery)
    are not touched. Multi-day accumulation is tolerated — briefings
    usually fire on <24-h cadence, so the absorption window is in
    practice ≤ 24 h.

A10. **Manual bypass via pre-written result.** Test-only AC documenting the
     convention formalised in this proposal: when Mag (or any operator)
     writes a result file with `"status": "skipped-duplicate"`,
     `"status": "skipped-superseded"`, or `"status": "preempted"` *before*
     the corresponding queue item is popped, the A6 dedup check honors it
     by construction — no special branch in the code. Test seeds such a
     result, runs the deliver path, asserts no `send` was called and the
     pop was consumed. Auditing tools (dashboard recent-results,
     retrospective collection) can distinguish synthetic from real by
     `status` string.

A11. **State-migration triple** (per the project's `lint:state-migration`
     guard at `scripts/lint-state-migration.ts`):

     - **Positive backfill**: a test seeds `mag/last-delivered.json` (the
       old single-file shape) with a valid record and asserts that the
       first read/migration step writes one matching file under
       `mag/in-flight/<requestId>.json` and unlinks the old path.
       Implement the backfill inside the migrator (one-shot on first
       directory read, or at keepalive start — either is acceptable;
       idempotent re-runs are required).
     - **Negative control**: a test seeds no `mag/last-delivered.json` and
       no `mag/in-flight/` directory, runs the migrator, and asserts the
       directory is **not** created and no record is written.
     - **JSON round-trip**: a test writes an `InFlightDelivery` via
       `writeInFlight`, reads it back via `readInFlight`, and asserts
       every field round-trips byte-equal. (Adapts the existing
       `last-delivered sentinel round-trip fidelity` test.)

     `bun run lint:state-migration` passes.

A12. **State-shape snapshot.** Add an `InFlightDelivery` entry to
     `scripts/snapshots/state.shape.snapshot.json` with the keys
     `["command", "deliveredAt", "line", "requestId"]` (alphabetised, per
     the file's existing convention). The allowlist's prior
     orchestration-only scope is extended by this one entry.

A13. **No API-surface change for existing callers.** Zero-arg callers of
     `deliverPoppedSkill` and the gate-blocked direct callers
     (`maybeFeedMagQueue` invocations, the dashboard `Send` button at
     `/api/queue-deliver`, `mag on-stop`) work unchanged. The
     deliver-then-gate flow is preserved; only the on-disk shape changes.

## Context

### Today's machinery (gh-ludics-526, in `src/mag.ts`)

The current delivery-confirmation stack:

- `interface LastDeliveredSentinel { requestId, command, line, deliveredAt }`
  written to a single file `mag/last-delivered.json` (via
  `lastDeliveredFile()`, `writeLastDelivered`, `readLastDelivered`,
  `clearLastDelivered`, `parseSentinelFile`).
- `DELIVERY_CONFIRM_TIMEOUT_MS = 10 * 60_000` — the 10-minute reconcile
  window.
- `requeueWithRetryCap(line, command, reason)` — increments `_retry_count`
  on the JSON line, reinserts at queue head if under the cap (from
  `mag.max_requeue_retries`, default `DEFAULT_MAX_REQUEUE_RETRIES`), and
  drops with `mag_queue_dropped` otherwise. Emits `mag_queue_requeued` on
  the retry path.
- `reconcileLastDelivered(nowMs)` — peeks the sentinel; clears if the
  result file exists; if past the timeout, atomically claims via
  `renameSync` to `<sentinel>.reconciling` and calls `requeueWithRetryCap`.
- `deliveryGateBlocked(nowMs)` — true while the sentinel exists, no result,
  and age < timeout.
- `readInFlightDelivery()` — dashboard helper returning the single
  sentinel record (or null when none / when the result already exists).
- `deliverPoppedSkill(popped, opts)` — calls `send`, writes the sentinel
  on success when `popped.expectsResult !== false`, calls
  `requeueWithRetryCap` on send failure.
- `maybeFeedMagQueue` runs `reconcileLastDelivered()` then checks
  `deliveryGateBlocked()` before any pop.

PR #530 added the `expectsResult` whitelist: only Tier-2 (result-producing)
skills write the sentinel; Tier-3 items (`action: message`, `/compact`)
skip it.

### Observed failure modes (all from the gh-ludics-535 issue body)

1. **Tier-3 wedge** (pre-PR #530): `/compact` ran three times before the
   retry cap dropped it. PR #530's whitelist closed this, but the
   structural fragility motivated this issue.
2. **Post-boot delivery race** (2026-05-15, mac-studio): briefing
   send-keyed ~2:20 after boot; `triggerSkill` returned true, sentinel
   written, but the briefing never reached the Mag conversation. Retry
   ran for 10+ minutes against the same broken state.
3. **Worker outran the 10-min ceiling**: a legitimate feedback-digest
   took ~11 min; reconciliation re-queued while the original worker was
   still finishing, producing a duplicate skill invocation. The
   `mag.ts:107` comment claiming briefing/feedback-digest finish "in
   well under a minute" is stale.

### Target shape

`mag/in-flight/` is a directory. One file per outstanding delivery, named
`<requestId>.json`. The on-disk record is the existing
`LastDeliveredSentinel` shape renamed to `InFlightDelivery` (same fields:
`requestId`, `command`, `line`, `deliveredAt`).

The directory form makes "one record per outstanding delivery" load-bearing
in the filename, and gives each record a stable filesystem identity for
per-row dashboard actions (Re-fire / Discard). The serialization invariant
("≤ 1 in flight at a time") is still enforced by `deliveryGateBlocked()`
— it just becomes "any record present without result" rather than "the
sentinel is present and young."

New helpers in `src/mag.ts` (replacing the single-file helpers — these are
the public surface other modules consume):

- `inFlightDir()` → `join(magStateDir(), "in-flight")`.
- `inFlightFile(requestId)` → `join(inFlightDir(), <requestId> + ".json")`.
- `writeInFlight(record: InFlightDelivery)` — `mkdirSync` the directory
  recursively, then atomic-write the record. If the file already exists
  for that `requestId`, refuse + emit an event (defensive; should not
  happen).
- `readInFlight(requestId)` — parse one file; null on missing/malformed.
- `listInFlight()` / `listInFlightDeliveries()` — return the
  `InFlightDelivery[]` sorted by `deliveredAt` ascending; `[]` on
  ENOENT. The dashboard helper.
- `clearInFlight(requestId)` — unlink; ENOENT is a no-op.
- `reconcileInFlight()` (renamed from `reconcileLastDelivered`) — iterate
  the directory, delete each record whose result JSON exists.

The fresh-id mint inside `/api/in-flight-refire` reuses the existing
request-id generator from `src/queue.ts` (the `req-<epoch>-<counter>`
shape that `QUEUE_ID_RE = /^req-\d+-\d+$/` matches). The new payload sets
`re-fired-from: <original-id>` so the audit trail joins original and
re-fire in `mag/results/`.

### Existing precedents

- `src/dashboard-server.ts` `/api/queue-promote` and `/api/queue-cancel`
  handlers (around dashboard-server.ts:603) demonstrate the
  `QUEUE_ID_RE` validation, the `lastGenerated = 0` cache-bust, and the
  `JSON.stringify({ status }) → 200` response shape — the new endpoints
  mirror them.
- `templates/dashboard/mag.html` `renderQueue` (around mag.html:109)
  shows the per-row action-button pattern for the Pending section; the
  Unresolved-Deliveries rows reuse this.
- `mag/results/` is already a directory of `<requestId>.json` files
  written by `queue.ts`'s `writeResult` (via `writeJsonFileCompact` at
  queue.ts:390); `mag/in-flight/` mirrors its layout.
- The briefing-context generator `briefingPrecomputeContext` already
  assembles a multi-section `briefing-context.md` (slots, sessions, flow,
  needs-elaboration, recent-journal, preempted, upstream-lag); the
  orphan-absorption stanza fits its existing pattern.

### Federation note

Per the project's federation v2 convention (controller-only harness
writes), the two new endpoints write to `mag/in-flight/` and `mag/queue.jsonl`
and therefore must run on the controller. Today's `dashboard-server.ts`
has no explicit leader-forwarding layer; the new endpoints land on the
same process as the existing `/api/queue-promote` and `/api/queue-cancel`
write endpoints. When the federation v2 forwarding layer arrives, the
new endpoints inherit it for free. Out of scope for this task to build
the forwarder.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The change is mostly mechanical translation. A reasonable sequencing:

1. Introduce `InFlightDelivery`, `inFlightDir`, `inFlightFile`,
   `writeInFlight`, `readInFlight`, `listInFlight`, `clearInFlight`, and
   the renamed `reconcileInFlight` alongside the existing single-file
   helpers. Switch `deliverPoppedSkill` and `maybeFeedMagQueue` /
   `deliveryGateBlocked` to use the new helpers. Confirm all delivery-
   confirmation tests still pass against the new shape.
2. Add the pre-send dedup check (A6) and the rollback-on-send-failure
   path (A5) in `deliverPoppedSkill`. Update / replace the relevant
   tests.
3. Implement the one-shot migrator (`mag/last-delivered.json` →
   `mag/in-flight/<id>.json`, unlink old) and the negative-control
   handling. Add the state-migration triple tests.
4. Switch `src/dashboard-server.ts` `inFlight` field to the array shape
   (call `listInFlightDeliveries()`). Add the two new POST endpoints
   following the `/api/queue-promote` / `/api/queue-cancel` template,
   including the "result already exists" → `already-completed` short-circuit
   on Re-fire.
5. Update `templates/dashboard/mag.html` `renderQueue` to render the
   array, add per-row Re-fire / Discard buttons, and add the count
   badge.
6. Extend `briefingPrecomputeContext` with the orphan-absorption stanza
   (A9). Cross-reference `queue.jsonl` (via `queueList()` already in
   scope) with `listInFlight()` to identify orphans.
7. Remove `DELIVERY_CONFIRM_TIMEOUT_MS`, `requeueWithRetryCap`,
   `DEFAULT_MAX_REQUEUE_RETRIES`, the `mag.max_requeue_retries` config
   key, the `.reconciling` claim machinery, the old single-file helpers,
   and the corresponding test describes.
8. Add `InFlightDelivery` to `scripts/snapshots/state.shape.snapshot.json`
   and confirm `bun run lint:state-migration` passes.
9. Supersede `docs/proposals/queue-delivery-confirmation-sentinel.md`
   with a header note pointing here.
10. Update the gh-ludics-526 comment cross-references in `src/mag.ts`
    (e.g. the `maybeFeedMagQueue` comment block around mag.ts:564) to
    also cite gh-ludics-535.

## Scope

**In scope.** Everything under Acceptance Criteria.

**Out of scope.**

- Building the federation v2 leader-forwarding layer in
  `src/dashboard-server.ts`. The new endpoints inherit whatever forward
  the existing `/api/queue-promote` / `/api/queue-cancel` endpoints
  inherit once that layer arrives.
- Auto-discard / archive policy beyond the briefing-context absorption
  in A9. Discard via the dashboard button is a plain `unlinkSync`
  (resolved Q3 — the briefing-context absorption from Q2 already
  retains the trail).
- Audible / desktop notifications for stuck deliveries (resolved Q1 —
  badge-only).
- A retry cap on the send-failure rollback path (resolved Q4 — option
  (a) unconditional reinsert, since the pre-send dedup check in A6
  bounds the worst case).

**Dependencies.** Relates to gh-ludics-526 (the proposal this supersedes).
No upstream blockers; PR #530's `expectsResult` whitelist is already in
`main` and the dedup check in A6 inherits its Tier-2/Tier-3 gating.
