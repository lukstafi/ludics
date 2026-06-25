# Re-check condition-gated enqueues at delivery time

## Goal

A condition-gated request can be correct *when enqueued* yet stale *when
delivered*. The keepalive auto-fill queues `elaborate <task>` because the task
had no `elaborated:` field at queue time; the field lands before the pop; the
stale pop is then delivered to Mag and returns a no-op "already-elaborated"
round-trip. This actually happened twice for `gh-ludics-609` on 2026-06-25 (an
overnight elaboration was killed by a 401 outage, the field landed at ~07:40,
and two already-queued `elaborate` requests popped at 07:44/07:45 against a
now-elaborated task).

Re-evaluate the predicate that motivated an **autonomously** enqueued,
condition-gated request **at pop/delivery time**, just before sending the skill
to Mag. When the condition no longer holds, consume the pop without sending —
write a durable skip-marker result and emit an observability event — and surface
recently-dropped requests on the Mag dashboard tab. User-/event-driven requests
are never re-checked and always deliver.

Relates to `gh-ludics-609` (same session, sibling "queue/worker
state-consistency" class, different code path: that task is worker *content*
correctness, this one is controller-side *queue-entry staleness*).

## Acceptance Criteria

1. **`enqueueSource` provenance is recorded on autonomous enqueues.** A new
   optional `enqueueSource` field (`"keepalive" | "sync" | "retrospective"`) is
   added to `QueueRequestExtras` in `src/queue.ts` and persisted onto the queue
   record by `queueRequest`/`queueRequestAtHead` exactly as `bypassGate` /
   `triggeredBy` already are (set-when-present, omitted otherwise). Every
   autonomous, condition-gated enqueue site listed under Context tags its call
   with the correct `enqueueSource`. No user-/CLI-initiated enqueue site sets
   the field.
   - *Verify:* `grep -n "enqueueSource" src/queue.ts` shows the interface field
     plus the two persistence blocks; the tagged-site set matches the Context
     table.

2. **Delivery-time re-check drops stale autonomous requests.** In
   `deliverPoppedSkill` (`src/mag.ts`), beside the existing A6 result-file
   dedup, the raw `popped.line` is re-parsed and, when the record carries an
   `enqueueSource` and a registered staleness predicate reports the request no
   longer applies, the pop is consumed without sending (returns `true`, no
   `send`, no `writeInFlight`). A record **without** `enqueueSource` is never
   dropped on this path.

3. **A per-action `stillApplicable` registry drives the re-check.** A
   `Record`/`Map` keyed by action holds a synchronous, file-read-only predicate
   per gated action returning `true` (deliver) / `false` (stale → drop). An
   unregistered action defaults to "always applicable" (deliver). Adding a new
   gated action is a single registry entry. The registered predicates cover at
   minimum `elaborate` and `draft-proposal` (the incident actions); the other
   gated actions in the Context table are covered too where their predicate is a
   cheap synchronous read.

4. **The `elaborate` staleness predicate reproduces the incident fix.** For
   `elaborate <task>`, the predicate drops when the task file is gone, the task
   is not `status: ready`, the task is non-leaf (`leaf: false`), or the content
   is already elaborated (`isElaborated`). Replaying the `gh-ludics-609`
   scenario (queue `elaborate gh-ludics-609` while the file is already
   elaborated, then deliver) consumes the pop without a send.

5. **On stale-drop, a durable trail is written.** For Tier-2 requests
   (`expectsResult !== false`) a skip-marker result file
   `mag/results/<requestId>.json` is written with `status: "skipped-stale"`
   plus `action`, `task`, a `reason` string (why stale), and a timestamp
   (A10 skip-marker shape). For Tier-3 requests (`expectsResult === false`) no
   result file is written. In **both** cases a `mag_queue_skipped_stale` event
   is emitted (modeled on `mag_queue_already_resolved`). `writeInFlight` is
   **never** called on a drop.

6. **Recently-dropped requests are visible on the Mag tab.** The Mag dashboard
   tab shows the most recent stale-drops (newest first, bounded ~5–10 items)
   with `action`, `task`, `reason`, and `timestamp`. It is a read-only
   observability list, not an actionable queue. Any status coloring is
   theme-aware and does not lean on blue as the load-bearing contrast on dark
   themes (per project memory `feedback_blue_low_luminosity`).

7. **In-skill precondition guards are untouched.** The skills' own guards
   (draft-proposal's `has_questions` block, process-suggestions' processed
   marker, the elaborate worker's already-elaborated short-circuit) remain as
   the safety net; the delivery re-check only avoids the wasted round-trip and
   is not relied on for correctness.

8. **Tests cover the gate.** New tests exercise: (a) a stale autonomous
   `elaborate` record is dropped (no send, skip-marker written, event emitted,
   no in-flight record); (b) a non-stale autonomous record delivers normally;
   (c) a record lacking `enqueueSource` always delivers even when its predicate
   would report stale; (d) a Tier-3 drop writes no result file but still emits
   the event.

## Context

How the queue → delivery path works now:

- **`queueRequest` / `queueRequestAtHead` (`src/queue.ts`)** build a
  `baseRecord` from the `QueueAction` union and conditionally append
  `QueueRequestExtras` fields. `QueueRequestExtras` is currently
  `{ bypassGate?, triggeredBy? }`. `bypassGate` is the exact precedent for a
  side-band provenance field set at enqueue and read at dispatch. `queueRequest`
  early-returns `""` in worker context, so the new field only ever lands on
  controller-written records (correct — workers never gate-recheck).

- **`deliverPoppedSkill` (`src/mag.ts`, ~line 535)** receives
  `{ requestId, command, line, expectsResult }`. `line` is the raw JSONL
  record, so the full record (action, task, `enqueueSource`) is re-parsable
  here without a signature change. The A6 block —
  `if (popped.expectsResult !== false && existsSync(magResultFile(...)))` —
  emits `mag_queue_already_resolved` and `return true`s; the new gate is the
  same consume-without-send shape, driven by a predicate read.

- **Predicate helpers already exist (reuse, don't reinvent):**
  - `isElaborated(content)` — `src/tasks/elaboration.ts` — the actual incident
    predicate.
  - Frontmatter parse via `src/tasks/markdown.ts` (`parseFrontmatter` family;
    `leaf`, `status`, `proposal`, `has_questions` reads).
  - `draftProposalAlreadyPendingOrInFlight(taskId)` (`src/mag.ts`) — already
    used at the `draft-proposal` enqueue site; reuse for that action.
  - `queueHasPendingActionForTask`, `listInFlightDeliveries` (`src/queue.ts` /
    `src/mag.ts`) for pending/in-flight checks.
  - Task-file existence:
    `existsSync(join(harnessDir(), "tasks", \`${taskId}.md\`))`.

- **`emitEvent` (`src/events.ts`)** — emit `mag_queue_skipped_stale` on drop,
  modeled on the `mag_queue_already_resolved` payload (`source: "keepalive"`,
  `scope: "mag"`, message carrying the dropped line + reason).

- **`writeResult` (`src/queue.ts`, ~line 496)** already writes
  `mag/results/<requestId>.json` with `{ id, status, timestamp, ...extra }`;
  the skip-marker reuses it with `status: "skipped-stale"` and the
  `action`/`task`/`reason` extras.

**Autonomous, condition-gated enqueue sites to tag with `enqueueSource`** (verified present):

| Action | Enqueue site(s) | Source | Stale-if (drop when true) |
|---|---|---|---|
| `elaborate` | `src/mag.ts` (auto-fill `~3010`, `~3473`); `src/tasks/sync.ts` (`~914`) | keepalive / sync | file gone, not `status: ready`, `leaf:false`, or already `isElaborated` |
| `draft-proposal` | `src/mag.ts` (`~3022`, `~3068`, `~3497`) | keepalive | proposal now exists, `has_questions:` now set, not `ready`, or already pending/in-flight |
| `preempt` | `src/tasks/sync.ts` (`~1001`) | sync | not `status: ready`/`preempt-queued` (sync already flips to `preempt-queued` immediately) |
| `verify-container-completion` | `src/mag.ts` (`~4932` is CLI — exempt); `src/tasks/sync.ts` (`~797`) | sync | children no longer all-terminal, or container already terminal |
| `process-suggestions` | `src/retrospective.ts` (`~428`) | retrospective | retrospective already processed |

The CLI/user-initiated sites stay **untagged** and therefore always deliver:
`src/mag.ts` `~4746` (elaborate), `~4885` (draft-proposal), `~4919`
(split-task), `~4932` (verify-container-completion), `~4982` (adopt-sessions),
`~4988` (process-suggestions), plus all `briefing`/`suggest`/`health-check`/
`sync-learnings`/`feedback-digest`/`revise-proposal`/`message`/
`adapter-followup`/`complete-task` sites (these carry user/event intent and are
out of scope per the boundary below).

**Dashboard surface.** The Mag tab (`templates/dashboard/mag.html`) already
fetches `/api/queue` (`src/dashboard-server.ts`, ~line 693), which returns
`{ pending, results, inFlight }`. `results` comes from `recentResults(20)`
(`src/queue.ts`) reading `mag/results/*.json` newest-first — so the
`skipped-stale` markers from AC 5 **already flow into** the existing "Recent"
section of the Mag queue panel. The dashboard work is therefore: make
`skipped-stale` items render distinctly (a labelled "dropped (stale)" entry
showing `action`/`task`/`reason`/`timestamp`) rather than building a separate
data pipeline. `mag.json` (`generateMag` in `src/dashboard.ts`) is the
terminal/queue-status snapshot and does not need a new field unless the
elaboration prefers a dedicated `dropped-requests.json` slice; reusing the
existing result-file → `/api/queue` path is the lighter route.

**Scope boundary (load-bearing).** Re-check applies ONLY to autonomously
enqueued, condition-gated actions (`enqueueSource` ∈ {keepalive, sync,
retrospective}). Absence of `enqueueSource` is the unconditional-deliver signal,
which makes every current record and every user-/event-driven item
(`message`, `briefing`, `health-check`, `suggest`, `sync-learnings`,
`feedback-digest`, `revise-proposal`, `adapter-followup`, `complete-task`)
deliver unchanged. This is the safe default — dropping a user-intent item on a
state re-read would lose work.

## Approach

*Suggested approach — agents may deviate if they find a better path. (The home
and the on-drop behavior are user-resolved, recorded 2026-06-25.)*

1. **`enqueueSource` field.** Add `enqueueSource?: "keepalive" | "sync" |
   "retrospective"` to `QueueRequestExtras` (`src/queue.ts`); persist it in both
   `queueRequest` and `queueRequestAtHead` with the same set-when-present idiom
   as `bypassGate`. Tag the autonomous enqueue sites from the Context table.

2. **`stillApplicable` registry.** Define a `Record<string, (record) => boolean>`
   (action → predicate; `true` = still applies/deliver, `false` = stale/drop)
   near `deliverPoppedSkill` in `src/mag.ts`. Each predicate is synchronous and
   file-read-only, reusing the helpers above. On read error, choose
   conservatively per action (for `elaborate`, an unreadable/missing file =
   gone = drop; given local controller files + atomic writes this is low-risk).

3. **Gate in `deliverPoppedSkill`.** Beside A6: re-parse `popped.line`; if it
   has an `enqueueSource` and a registered predicate returns `false`, write the
   skip-marker result (Tier-2 only), emit `mag_queue_skipped_stale`, and
   `return true` without sending and without `writeInFlight`. Otherwise fall
   through to the existing send path unchanged.

4. **Dashboard.** In `templates/dashboard/mag.html`'s "Recent" rendering, give
   `status === "skipped-stale"` items a distinct, theme-aware label/style
   showing `action`/`task`/`reason`/`timestamp`. Keep it read-only and bounded
   by the existing `recentResults` limit.

## Scope

In scope: the `enqueueSource` field + tagging, the delivery-time re-check
registry and gate, the skip-marker + event trail, and the Mag-tab visibility of
dropped requests. Out of scope: any change to the skills' own precondition
guards (they stay as-is), any re-check of user-/event-driven actions, and any
locking beyond the existing queue lock (the re-check is best-effort
optimization, not a correctness barrier — the in-skill guards remain the
backstop against the read-then-deliver race). No dependency on other tasks;
relates to `gh-ludics-609`.
