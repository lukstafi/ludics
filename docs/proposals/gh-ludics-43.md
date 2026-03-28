# Proposal: Route incoming ntfy messages — t3code launcher + fall-through to Mag

**GitHub issue:** lukstafi/ludics#43
**Task file:** `tasks/gh-ludics-43.md`
**Primary file to modify:** `src/notify.ts`
**Secondary file to modify:** `src/mag.ts`

---

## Problem Summary

Two gaps in the incoming ntfy subscriber (`subscribeIncoming()` in `src/notify.ts`):

1. **Launch messages are swallowed by pending-revise.** When the user taps a "Launch t3code" action button (or types "Launch t3code for gh-ludics-40 in project gh-ludics"), the message reaches the subscriber's `else` branch (line 1220). If a `pending-revise-*` flag file exists from a previous "Revise proposal" tap, `consumeAllPendingRevises()` returns non-empty and the Launch message is consumed as revision feedback text — it never reaches the queue as a launch intent. If no pending-revise flag exists, the message is queued as `action:"message"`, which is correct — Mag's `queuePopToSkill()` (in `src/mag.ts` line 1038) pattern-matches Launch messages inside the `"message"` case and calls `launchSessionFromNotification()`. So the bug is specifically the pending-revise consumption path.

2. **Missing explicit Launch pattern in subscriber.** The subscriber has explicit patterns for "Revise proposal", "Revise followup", "Followup", and "Done task", but Launch messages fall through to the generic else branch. This works when no pending-revise is armed, but is fragile — any future spring-loaded handler could intercept Launch messages again.

### Root cause

The subscriber's dispatch chain in `subscribeIncoming()` (lines 1202-1239) has this structure:

```
if (reviseProposalMatch)        -> arm pending-revise
else if (followupReviseMatch)   -> arm pending-followup-revise
else if (followupMatch)         -> queue adapter-followup
else if (doneMatch)             -> queue complete-task
else {
  // Check pending-revise flags first (CONSUMES any message as feedback)
  // Only if no pending flags -> queue as "message"
}
```

A Launch message hits the `else` block. If pending-revise flags exist, it is treated as feedback text rather than recognized as a Launch command.

## Proposed Changes

### Change 1: Add explicit Launch pattern to subscriber dispatch chain

**File:** `src/notify.ts`, inside `subscribeIncoming()` (around line 1206)

Add a Launch pattern match before the pending-revise consumption block. This ensures Launch messages are never consumed as revision feedback.

```typescript
// After existing patterns (line 1206):
const doneMatch = msg.match(/^Done task ([\w.-]+)$/);
// NEW:
const launchMatch = msg.match(/^Launch ([\w-]+) for ([\w.-]+) in project (.+)$/);
const abandonMatch = msg.match(/^Abandon task ([\w.-]+)$/);
```

Then add cases to the dispatch chain, inserted between `doneMatch` and the `else` block:

```typescript
} else if (doneMatch) {
  queueRequest("complete-task", `"task":"${doneMatch[1]!}"`);
} else if (launchMatch) {
  // Queue as "message" — Mag's queuePopToSkill handles the actual launch
  const escaped = JSON.stringify(msg);
  queueRequest("message", `"content":${escaped}`);
} else if (abandonMatch) {
  const escaped = JSON.stringify(msg);
  queueRequest("message", `"content":${escaped}`);
} else {
  // Pending-revise consumption + generic fall-through (unchanged)
  ...
}
```

Launch and Abandon messages are queued as `action:"message"` with the full text, because Mag's `queuePopToSkill()` already pattern-matches them inside the `"message"` case (lines 1038-1054 in `src/mag.ts`) and dispatches to `launchSessionFromNotification()` or `abandonTaskFromNotification()` respectively. The point of the explicit match is to prevent the pending-revise consumption block from swallowing them.

**Why not queue a dedicated `"launch-session"` action?** The Mag-side dispatch in `queuePopToSkill()` already handles Launch messages via the `"message"` action's pattern matching. Adding a separate action type would require adding a new case in `queuePopToSkill()` and duplicating the launch logic. The simpler fix is to route these messages past the pending-revise trap.

### Change 2: Remove agent-duo, pair-claude, pair-codex from proposal action buttons

**File:** `src/notify.ts`, function `buildProposalNotificationActions()` (lines 124-133)

Remove the three discontinued adapter buttons. This is scoped to gh-ludics-41 but is included here because the Launch routing fix is meaningless for adapters that no longer exist.

Before:
```typescript
return [
  action("agent-duo", `Launch agent-duo for ${taskId} in project ${project}`),
  action("pair-claude", `Launch agent-pair-claude for ${taskId} in project ${project}`),
  action("pair-codex", `Launch agent-pair-codex for ${taskId} in project ${project}`),
  action("t3code", `Launch t3code for ${taskId} in project ${project}`),
  action("agent-claude", `Launch agent-claude for ${taskId} in project ${project}`),
  action("agent-codex", `Launch agent-codex for ${taskId} in project ${project}`),
  action("revise", `Revise proposal for ${taskId}`),
  action("abandon", `Abandon task ${taskId}`),
];
```

After:
```typescript
return [
  action("t3code", `Launch t3code for ${taskId} in project ${project}`),
  action("agent-claude", `Launch agent-claude for ${taskId} in project ${project}`),
  action("agent-codex", `Launch agent-codex for ${taskId} in project ${project}`),
  action("revise", `Revise proposal for ${taskId}`),
  action("abandon", `Abandon task ${taskId}`),
];
```

This reduces the action list from 8 to 5, fitting in two ntfy notification batches (at `maxActions=3`) instead of three.

### Change 3: Update test expectations

**File:** `src/notify.test.ts`

Update the `buildProposalNotificationActions` test to expect only the five remaining buttons, and update the `chunkNotificationActions` test for the new chunk sizes.

### No changes needed to `src/mag.ts`

The `queuePopToSkill()` function's `"message"` case (lines 1032-1064) already correctly pattern-matches Launch, Abandon, Followup, and Done messages. The existing regex `content.match(/^Launch ([\w-]+) for ([\w.-]+) in project .+$/)` handles all adapter names. No changes needed on the Mag side.

## Files Modified (summary)

| File | Action |
|------|--------|
| `src/notify.ts` | Add Launch/Abandon patterns to subscriber dispatch; remove 3 legacy action buttons |
| `src/notify.test.ts` | Update test expectations for reduced action button list |

## Test Plan

1. **Unit: `buildProposalNotificationActions` returns 5 actions** — t3code, agent-claude, agent-codex, revise, abandon. No agent-duo/pair-claude/pair-codex.
2. **Unit: `chunkNotificationActions` chunks 5 items at maxActions=3** — produces `[3, 2]`.
3. **Manual: subscriber Launch routing with armed pending-revise.**
   - Tap "Revise proposal for task-X" (arms pending-revise flag).
   - Then tap "Launch t3code for task-Y in project P".
   - Verify: Launch message is queued as `action:"message"` with full text, NOT consumed as revision feedback.
   - Verify: pending-revise flag for task-X remains armed (a subsequent free-text message should still be captured as feedback).
4. **Manual: subscriber Launch routing without pending-revise.**
   - Tap "Launch t3code for task-Y in project P" with no pending-revise flags.
   - Verify: message is queued as `action:"message"` and Mag processes it via `launchSessionFromNotification()`.
5. **Manual: subscriber Abandon routing.**
   - Tap "Abandon task task-X" with a pending-revise flag armed.
   - Verify: Abandon message is queued as `action:"message"`, not consumed as feedback.
6. **Manual: pending-revise still works for actual feedback.**
   - Tap "Revise proposal for task-X".
   - Send a free-text message "Please add error handling".
   - Verify: free-text is consumed as revision feedback and queued as `action:"revise-proposal"` with the feedback content.
7. **Regression: "Done task", "Followup", "Revise followup"** — verify these button taps still route correctly.

## Risk Assessment

- **Low risk.** The change adds two explicit pattern matches to the subscriber dispatch chain, preventing a known misrouting bug. No changes to Mag-side dispatch logic.
- **Pending-revise flag preservation.** Launch and Abandon messages now skip the pending-revise consumption block entirely — the flags remain armed for the next free-text message. This is the correct behavior: tapping a Launch button is not revision feedback.
- **Action button reduction.** Removing three discontinued adapters is safe — agent-duo, agent-pair-claude, and agent-pair-codex are no longer functional. Any existing armed notifications with the old buttons will still work (the subscriber routes all Launch messages generically), but new notifications will have a cleaner button set.
