# Queue feedback-digest daily via briefing trigger

## Goal

The `feedback-digest` skill processes workflow feedback files to identify patterns and file improvement issues. It is currently only manually invokable via `ludics mag feedback-digest`. It should be automatically queued once daily as part of the briefing flow, so feedback accumulates and gets processed without manual intervention.

## Acceptance Criteria

1. **Auto-queue on briefing**: When `magBriefing()` queues a briefing request, it also queues a `feedback-digest` request (immediately after, in the same function).

2. **Dedup-safe**: The auto-queue uses the existing `queueHasPendingFeedbackDigest()` and `feedbackDigestCooldownRemaining()` guards, so redundant runs are impossible. If a feedback-digest is already pending or on cooldown, the queue attempt is silently skipped.

3. **No new triggers or config**: No new launchd/systemd trigger is needed. The briefing trigger (morning or manual) is the sole entry point. No new config keys are required.

## Approach

### Single change site: `magBriefing()` in `src/mag.ts`

After the existing `queueRequest("briefing")` call (line ~2851), add a feedback-digest queue block that mirrors the logic in the `case "feedback-digest"` CLI handler (lines 3073-3088):

```typescript
// Also queue feedback-digest (dedup/cooldown-safe)
if (!queueHasPendingFeedbackDigest("ludics")) {
  const remainingCooldown = feedbackDigestCooldownRemaining("ludics");
  if (remainingCooldown <= 0) {
    queueRequest("feedback-digest");
    markFeedbackDigestQueued("ludics");
    console.log("Queued feedback-digest request (via briefing)");
  }
}
```

This reuses the three existing helper functions (`queueHasPendingFeedbackDigest`, `feedbackDigestCooldownRemaining`, `markFeedbackDigestQueued`) that already handle all dedup and cooldown logic. The 120-second cooldown constant (`FEEDBACK_DIGEST_COOLDOWN_SECONDS`) is sufficient to prevent double-queuing from rapid briefing invocations.

### Why `magBriefing()` and not the briefing skill or pre-hook

- **`magBriefing()`** is the CLI entry point called by triggers and manual `ludics mag briefing`. Placing the queue call here means the feedback-digest is queued as a separate request in the queue, processed independently by Mag after the briefing completes.
- The **briefing pre-hook** (`briefingPrecomputeContext`) runs at pop time inside the Mag session -- queuing there would be too late (the request would be processed in a future cycle rather than the current batch).
- The **briefing skill** runs inside the Mag agent and shouldn't make direct queue mutations.

### Files changed

| File | Change |
|------|--------|
| `src/mag.ts` | Add ~7 lines in `magBriefing()` after `queueRequest("briefing")` |

No test changes needed -- the dedup/cooldown logic is already tested via the existing CLI path. The new call site uses identical logic.
