# Auto-schedule /compact after health-check and briefing

## Goal

Health-check and briefing are natural checkpoint skills that complete a coherent thought without carrying forward in-progress reasoning. They are the highest-value, safest moments to run `/compact` — manual compaction has been the user's habit at exactly these boundaries. Automate the enqueue so context-window hygiene happens without manual intervention.

Tracking task: `task-a00fc0d9` in the harness.

## Acceptance Criteria

- After every queued `health-check` request, a `{ action: "message", content: "/compact" }` request is enqueued so it lands directly behind the health-check in `mag/queue.jsonl`.
- After every queued `briefing` request, the same `/compact` follow-up is enqueued behind it.
- The compact follow-up is enqueued **unconditionally** at enqueue time. It is not gated on `shouldSkipHealthCheck`'s pop-time decision; a no-op `/compact` against a small context is acceptable.
- No new queue action types, no new hook surfaces, no skill-registry changes, no `triggerSkill` changes.
- Feedback-digest and other skills are NOT auto-compacted.
- Existing tests still pass; the queue ordering invariants are preserved.

## Context

The harness already supports queuing arbitrary slash commands as plain "message" entries:

- `src/mag.ts` `triggerSkill(session, cmd)` is content-agnostic — it types whatever string is passed into the Mag tmux pane and submits.
- `resolveQueueRequestCommand` in `src/mag.ts` Tier 3 (`case "message":`) returns `request.content` verbatim when it's set, so a `{ action: "message", content: "/compact" }` queue entry flows through unchanged.
- `magMessage` (`src/mag.ts`) is the existing CLI shim: `ludics mag message "<text>"` → `queueRequest({ action: "message", content: text })`. The user has confirmed this path works empirically (a manual `/compact` enqueue is logged in `journal/events.jsonl` from 2026-04-24).

Enqueue sites for the two target actions:

- `magBriefing` in `src/mag.ts` — the only programmatic enqueue of `{ action: "briefing" }`. Already chains a `tryQueueFeedbackDigest("ludics")` call after the queue request, so it's a precedent for follow-up enqueues at this site.
- The CLI subcommand handler in `src/mag.ts` (the `case "health-check":` branch in the `magCommand` switch) — the only programmatic enqueue of `{ action: "health-check" }`. The launchd / cron trigger does not enqueue directly; it shells out to `ludics mag health-check`, which lands in this same handler.

`queueRequest` lives in `src/queue.ts` and is already imported by `mag.ts`.

The `case "message":` regex matchers (Approve / Launch / Followup / Done / Abandon) do not match strings starting with `/`, so `/compact` is a clean pass-through.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

In `src/mag.ts`, in the two enqueue sites identified above, append a single `queueRequest({ action: "message", content: "/compact" })` call immediately after the existing `queueRequest` for the checkpoint action.

1. **`magBriefing`** (around the `queueRequest({ action: "briefing" })` line): add the compact enqueue right after it (before or after the `tryQueueFeedbackDigest` block — placement is a matter of taste; running compact after feedback-digest is also fine, but the simplest reading of "auto-compact after briefing" puts compact immediately behind the briefing entry).

2. **`case "health-check":`** in the `magCommand` switch (the `queueRequest({ action: "health-check" })` line): add the compact enqueue immediately after, before the `console.log` lines.

A short comment at each site noting *why* (checkpoint compaction; see this proposal / task-a00fc0d9) is welcome but not required.

Optional: a one-line note in `skills/ludics-health-check.md` and `skills/ludics-briefing.md` mentioning that compaction is auto-scheduled externally, so future readers don't try to bake it into the skill body.

## Scope

In scope:
- `src/mag.ts`: two enqueue sites.
- Optional doc note in `skills/ludics-health-check.md` and `skills/ludics-briefing.md`.

Out of scope:
- Auto-compact for other skills (feedback-digest, suggest, learn, etc.).
- Adjacency guarantees against intervening enqueues from other automation. FIFO ordering with possible interleavings is acceptable for this task.
- The "Conversation too long" `/compact` failure mode for orchestrated agents — that's `gh-agent-duo-9`'s territory; Mag is a long-running session where this is not a current concern.
- Gating the compact enqueue on `shouldSkipHealthCheck`'s pop-time decision.

Dependencies: none.
