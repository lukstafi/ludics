# Reorder briefing's auto-queue: feedback-digest before /compact

## Goal

In `magBriefing()`, swap the order of the auto-queued `/compact` and the
`tryQueueFeedbackDigest("ludics")` call so the on-disk queue order
becomes `briefing → feedback-digest → /compact`. The current order
(`briefing → /compact → feedback-digest`) means `/compact` wipes the
briefing's in-flight context before feedback-digest runs, leaving digest
without the patterns Mag noticed during the briefing pass. Putting
`/compact` last lets digest consume the briefing context, then the next
session starts fresh.

## Acceptance Criteria

- [ ] In `src/mag.ts` `magBriefing()`, calling the function in a
      synthetic clean-state harness (no pending digest, no cooldown)
      writes queue entries in this order to `mag/queue.jsonl`:
      `briefing`, `feedback-digest`, `/compact`. The
      `tryQueueFeedbackDigest("ludics")` call appears before the
      `queueRequest({ action: "message", content: "/compact" })` call in
      source order. Falsifier: any other ordering, or `/compact` queued
      conditionally on `fdResult.queued`.
- [ ] Negative control — when feedback-digest is gated (cooldown active
      or duplicate pending), the queue order is `briefing`, `/compact`
      (length 2). `/compact` still lands last in this branch.
      Falsifier: `/compact` missing, or queue length differs from 2 in
      the gated branch.
- [ ] The test in `src/mag-auto-compact.test.ts` (currently named
      "enqueues /compact directly behind the briefing entry") is
      renamed to reflect the new invariant (e.g. "enqueues /compact as
      the final item, with feedback-digest between briefing and
      /compact"), and asserts:
      `items[items.length - 1].action === "message" &&
       items[items.length - 1].content === "/compact"` AND, when digest
      is not gated in the synthetic harness, `items[1].action ===
      "feedback-digest"` (or whichever action key
      `tryQueueFeedbackDigest` uses) with `items[0].action ===
      "briefing"`. Falsifier: assertion still expects `items[1]` to be
      `/compact`.
- [ ] The comment block above the `/compact` enqueue no longer contains
      the substrings "directly behind" or "before any later automated
      enqueues". The new comment cites the actual reason — `/compact`
      runs LAST so the next session starts fresh, after feedback-digest
      has consumed the briefing's in-flight context. The reference to
      task-a00fc0d9 / `docs/proposals/auto-compact-after-checkpoints.md`
      is preserved (auto-compact contract is unchanged).
      Falsifier: either disallowed substring still present, or the
      task-a00fc0d9 reference removed.
- [ ] No source change to `magHealthCheck`'s `/compact` enqueue around
      `src/mag.ts:3485`. The health-check test
      ("enqueues /compact directly behind the health-check entry")
      continues to assert `items.length === 2` with
      `items[1].content === "/compact"`. Falsifier: that test fails or
      its assertions are modified.

## Context

`magBriefing()` queues three follow-up requests after the briefing
trigger fires (current order, `src/mag.ts:3309-3326`):

1. `briefing` request
2. `/compact` (line 3320) — comment claims "Enqueued directly behind the
   briefing so it lands before any later automated enqueues"
3. `feedback-digest` via `tryQueueFeedbackDigest("ludics")` (line 3323)

The bug: `/compact` clears the conversation state before
feedback-digest runs, so digest can't draw on the briefing's analysis.
The auto-compact-after-checkpoints contract (task-a00fc0d9 /
`docs/proposals/auto-compact-after-checkpoints.md`) is unchanged — only
the rationale comment that motivated the placement is wrong. Briefing
must still always co-queue `/compact`; it just needs to land last.

`tryQueueFeedbackDigest` is conditional (gated on cooldown +
duplicate-pending), so the queued sequence is either three items
(`briefing`, `feedback-digest`, `/compact`) or two
(`briefing`, `/compact`) depending on digest state. `/compact` must be
unconditionally enqueued after the digest call — never gated on
`fdResult.queued`.

## Approach

Swap the two calls in `magBriefing()`: move the
`tryQueueFeedbackDigest("ludics")` block (and its `if (fdResult.queued)`
log) above the `queueRequest({ action: "message", content: "/compact" })`
line. Rewrite the comment block above the `/compact` line to drop the
"directly behind" / "before any later automated enqueues" claim and
explain the new rationale (compact lands last → fresh next session).
Keep the task-a00fc0d9 cite.

In `src/mag-auto-compact.test.ts`, rename the test "enqueues /compact
directly behind the briefing entry" to reflect that `/compact` is now
the final item, and flip its assertions to check the LAST queue entry
for `/compact` plus the middle entry for `feedback-digest` (when
ungated). Update the inline `// Must be at least…` comment accordingly.

No other tests reference this ordering; grep for `magBriefing` in the
test corpus only hits this file.

## Out of Scope

- `magHealthCheck`'s `/compact` enqueue at ~`src/mag.ts:3485` — that
  path has no co-queued feedback-digest, so the ordering bug doesn't
  apply. The "runMag health-check auto-compact follow-up" test stays
  unchanged.
- Any change to the auto-compact-after-checkpoints contract itself
  (task-a00fc0d9). `/compact` still always fires after a briefing.
- `tryQueueFeedbackDigest`'s gating logic (cooldown / duplicate guard).
