# Proposal: Extract tryQueueFeedbackDigest helper

**Task**: task-94eaa76b
**Date**: 2026-04-04

## Goal

Eliminate the duplicated dedup + cooldown + queue pattern for feedback-digest between `magBriefing()` and the CLI `feedback-digest` case in `src/mag.ts` by extracting a single `tryQueueFeedbackDigest(repo)` helper function.

## Acceptance Criteria

1. A new module-private function `tryQueueFeedbackDigest(repo: string)` exists in `src/mag.ts` that encapsulates the three guards (`queueHasPendingFeedbackDigest`, `feedbackDigestCooldownRemaining`, cooldown check) and the `queueRequest` + `markFeedbackDigestQueued` side-effects.
2. The function returns a structured result `{ queued: boolean; reason?: string }` so callers can produce their existing log messages.
3. The `magBriefing()` call-site (~L2991) is replaced with a call to the new helper, logging on success.
4. The CLI `feedback-digest` case (~L3216) is replaced with a call to the new helper, logging success or skip reason.
5. Observable behavior (logging, queueing, cooldown enforcement) is unchanged.
6. Existing tests pass without modification.

## Context

- **File**: `src/mag.ts`
- **Call-site 1** (magBriefing, ~L2991): 4-line inline guard block
- **Call-site 2** (CLI case, ~L3216): 10-line inline guard block with early-break pattern
- **Existing helpers** already compose cleanly: `queueHasPendingFeedbackDigest` (from `queue.ts`), `feedbackDigestCooldownRemaining`, `markFeedbackDigestQueued` (both module-private in `mag.ts`)
- The new helper stays module-private (not exported) since both call-sites are in `mag.ts`

## Approach

1. Add `tryQueueFeedbackDigest` near the existing feedback-digest helpers (~L459, after `markFeedbackDigestQueued`):

```ts
function tryQueueFeedbackDigest(repo: string): { queued: boolean; reason?: string } {
  if (queueHasPendingFeedbackDigest(repo)) {
    return { queued: false, reason: "already pending in queue" };
  }
  const remaining = feedbackDigestCooldownRemaining(repo);
  if (remaining > 0) {
    return { queued: false, reason: `cooldown active (${remaining}s remaining)` };
  }
  queueRequest("feedback-digest", `"repo":"${repo}"`);
  markFeedbackDigestQueued(repo);
  return { queued: true };
}
```

2. Replace magBriefing call-site with:
```ts
const fdResult = tryQueueFeedbackDigest("ludics");
if (fdResult.queued) {
  console.error("ludics: briefing queued feedback-digest for ludics");
}
```

3. Replace CLI feedback-digest case with:
```ts
case "feedback-digest": {
  const fdResult = tryQueueFeedbackDigest("ludics");
  if (fdResult.queued) {
    console.log("Queued feedback-digest request");
  } else {
    console.log(`Skipped feedback-digest: ${fdResult.reason}`);
  }
  break;
}
```
