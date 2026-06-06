# Dedup draft-proposal enqueues: guard the manual CLI handler and close the in-flight (popped-but-unresolved) window

## Goal

A draft-proposal request can be enqueued redundantly through two gaps:

1. The **manual** `ludics mag draft-proposal <task>` handler enqueues
   unconditionally — unlike every keepalive enqueue path, which guards first.
2. All existing dedup guards read only `mag/queue.jsonl`. Once a request is
   *popped* (delivered to the skill) but before the worker stamps `proposal:`
   into the task frontmatter / writes its result JSON, the task is invisible to
   the queue-only guards, so a keepalive tick or a manual call can enqueue a
   second draft-proposal during that in-flight window.

A real duplicate on 2026-06-06 (task-c48b7beb) exercised gap 1: keepalive
auto-queued a draft-proposal at `14:10:33Z`, and a manual
`ludics mag draft-proposal task-c48b7beb` enqueued a second 10s later. It was
harmless — downstream idempotency short-circuited the second delivery to
`already-exists` and no second slot started — but the redundant skill-fire is
avoidable waste. Gap 2 is the same bug class one layer deeper; it didn't bite
in this incident (both requests were in-queue together) but will recur.

This task closes both gaps and routes every enqueue decision through one shared
predicate so the manual and keepalive paths cannot drift apart again.

## Acceptance Criteria

- A manual `ludics mag draft-proposal <task>` issued while a draft-proposal for
  that task is already **pending in the queue** does NOT enqueue a second
  request. It skips and prints an informative message naming the task. (Covers
  the demonstrated 2026-06-06 case.)
- A draft-proposal enqueue attempted during the **in-flight window** — request
  already popped (an `mag/in-flight/<requestId>.json` record exists for a
  draft-proposal of that task) and not yet resolved (no
  `mag/results/<requestId>.json`, and the task not yet `proposal:`-stamped) — is
  also deduped: no redundant request, from BOTH the manual handler AND the
  keepalive auto-queue paths.
- The dedup decision flows through a **single shared predicate** (one exported
  function answering "is a draft-proposal already pending OR in-flight for this
  task"). The manual handler and all keepalive draft-proposal enqueue sites call
  it, so they cannot drift apart.
- The shared predicate's in-flight arm matches a record to a task by parsing the
  record's stored queue `line` (which carries `action` and `task`) — not by
  string-substring heuristics on the command — and treats a record as
  in-flight only while its result JSON is absent. A record whose result JSON has
  landed (i.e. resolved/reconciled) does NOT count as in-flight.
- Tests:
  - (a) manual-handler skip when a draft-proposal for the task is already
    pending in the queue (the request count does not increase, and the skip
    message is emitted);
  - (b) in-flight dedup (popped-but-unresolved record present, queue empty) for
    BOTH entry points — manual handler and the keepalive auto-queue path —
    blocks a second enqueue;
  - (c) negative control: a genuinely-absent draft-proposal (no pending queue
    entry, no in-flight record) still enqueues normally from both paths;
  - (d) negative control on the in-flight arm: an in-flight record whose result
    JSON exists is NOT treated as pending (so a re-enqueue after genuine
    completion-with-no-proposal is not wrongly blocked — though in practice the
    proposal field check covers the common case).
- No regression: a legitimate first draft-proposal still queues, and the
  existing A6 / dashboard / delivery-confirmation queue tests stay green.

## Context

All paths live in `src/mag.ts`, `src/queue.ts`, and (for the in-flight record
machinery) the gh-ludics-535 in-flight section of `src/mag.ts`.

**Existing queue-only dedup.** `queueHasPendingActionForTask(action, taskId)`
in `src/queue.ts` parses `mag/queue.jsonl` and matches `req.action === action &&
String(req.task) === taskId`. This is the right queue-side check and is already
called by two of the three keepalive sites.

**The three keepalive enqueue sites in `src/mag.ts`:**
- Stuck-slot re-queue (near the `slot_unstick` emit) — guards with
  `!autoProposalDebounced(taskId) && !queueHasPendingActionForTask("draft-proposal", taskId)`.
- `maybeQueueProposals` — guards with a *coarse global* check
  `qContent.includes('"draft-proposal"')` (returns if ANY draft-proposal is
  queued, not per-task). One-per-cycle; stamps `markAutoProposalQueued`.
- Top-candidate re-queue (near `top candidate ... needs proposal`) — guards with
  `!autoProposalDebounced(topTask.id) && !queueHasPendingActionForTask("draft-proposal", topTask.id)`.

**The manual handler** (the `["draft-proposal", (args) => { ... }]` entry in the
mag subcommand table) calls `queueRequest({ action: "draft-proposal", task: taskId })`
unconditionally — no guard.

**In-flight infrastructure already exists (gh-ludics-535).** This is the
"in-flight sentinel" mechanism from the task's Tentative Design option B —
already built, so no new lifecycle is needed:
- `writeInFlight(record)` writes `mag/in-flight/<requestId>.json` with shape
  `InFlightDelivery = { requestId, command, line, deliveredAt }`. Called by
  `deliverPoppedSkill` on a successful Tier-2 send.
- `listInFlight()` enumerates valid records; `listInFlightDeliveries()` filters
  to those whose `magResultFile(requestId)` does not yet exist (the unresolved
  set).
- `reconcileInFlight()` deletes a record once its result JSON lands; the result
  file is the authoritative "resolved" signal.
- Crucially, the record's `line` field is the **verbatim queue JSON line** that
  was popped — it contains `action` and `task`. So an in-flight draft-proposal
  for a given task is detectable by parsing `record.line` (reuse the queue
  module's line parser) and matching `action === "draft-proposal" && task ===
  taskId`, gated on `magResultFile(record.requestId)` being absent.

**A6 pre-send result-file dedup** (`deliverPoppedSkill`) already consumes a pop
without sending when `mag/results/<requestId>.json` exists. That guards the
*delivery* side; this task guards the *enqueue* side. They compose: the new
predicate prevents the redundant request from being queued at all.

**Result-file path:** `magResultFile(requestId)` →
`mag/results/<requestId>.json`. The same file `reconcileInFlight` and A6 key on.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The mechanism is forced by the existing infrastructure (queue.jsonl +
gh-ludics-535 in-flight records), so the design space is narrow — this is
mechanism "B" (in-flight sentinel) already built, blended with the existing
queue guard. Concretely:

1. **Shared predicate.** Add one exported function — e.g.
   `draftProposalAlreadyEnqueued(taskId): boolean` — that returns true when
   EITHER:
   - `queueHasPendingActionForTask("draft-proposal", taskId)` (queue arm), OR
   - an unresolved in-flight record matches: some record from `listInFlight()`
     (or `listInFlightDeliveries()`) whose parsed `line` has `action ===
     "draft-proposal"` and `task === taskId`, and whose `magResultFile` does not
     exist (the in-flight arm).

   Place it where both `mag.ts` enqueue sites and the manual handler can call
   it. Parsing the in-flight `line` should reuse the queue module's existing
   JSON-line parser rather than a hand-rolled `JSON.parse`, so the match logic
   stays consistent with how the queue itself reads records. If a small helper
   "does this in-flight record target (action, task)?" reads cleanly, factor it
   out, but don't over-generalize to other actions (out of scope).

2. **Manual handler.** Guard the `["draft-proposal", ...]` handler with the new
   predicate; on hit, print an informative skip message (naming the task and
   that a draft-proposal is already pending/in-flight) and return without
   enqueuing.

3. **Keepalive sites.** Replace the per-task `queueHasPendingActionForTask(
   "draft-proposal", ...)` calls at the stuck-slot and top-candidate sites with
   the new predicate (preserving the existing `autoProposalDebounced` checks).
   For `maybeQueueProposals`, the coarse global
   `qContent.includes('"draft-proposal"')` early-return may stay as a cheap
   fast-path, but the per-task in-flight check must additionally apply to the
   selected candidate before `queueRequest` — so an in-flight (but not in-queue)
   draft-proposal for that candidate is not re-enqueued. Choose the minimal
   change that makes the in-flight arm authoritative for the candidate actually
   being queued.

4. **Tests.** Mirror the existing A6 / delivery-confirmation test patterns
   (the in-flight write/read/reconcile helpers are already exported and used in
   the delivery-confirmation test file). Cover: manual skip on pending-queue;
   in-flight dedup from both entry points; negative control (absent →
   enqueues); negative control (resolved in-flight record with result JSON
   present → not treated as pending). Use the exported in-flight helpers to set
   up records rather than reaching into files by hand where possible.

## Scope

In scope:
- A single shared "already pending or in-flight" predicate for draft-proposal.
- Guarding the manual `draft-proposal` CLI handler with it.
- Routing the keepalive draft-proposal enqueue sites through it (stuck-slot,
  top-candidate, and the per-candidate check in `maybeQueueProposals`).
- Tests for both entry points across the queue arm, the in-flight arm, and the
  two negative controls.

Out of scope:
- Other actions' enqueue dedup (elaborate, feedback-digest, etc.). The shared
  predicate could generalize, but keep this task to draft-proposal unless a
  generic helper falls out naturally without extra surface.
- Changing the keepalive cadence, the `autoProposalDebounce` mechanism, or the
  gh-ludics-535 in-flight lifecycle (reconciliation, orphan handling, the
  delivery gate). This task only *reads* in-flight records for the enqueue
  guard; it does not alter how they are written, reconciled, or cleared.

Dependencies: relates to task-c48b7beb (the precipitating incident); no blocking
dependencies.
