# Proposal: Lightweight Incoming Channel

## Problem

The current incoming message flow is bureaucratic:

1. `notify subscribe` SSE listener appends to `mag/inbox.md`
2. `queueRequest("message")` enqueues an action
3. Mag's stop hook pops the queue, maps `"message"` → `/ludics-read-inbox`
4. The 55-line `ludics-read-inbox.md` skill tells Mag to run `ludics mag inbox --consume`, parse messages, categorize them (information updates, requests, context notes, ambiguous), journal them, and write a result JSON
5. Additionally, `ludics-suggest`, `ludics-health-check`, and `ludics-briefing` all begin with "Check inbox" — redundant with the dedicated skill

**Costs:**
- Mag burns an entire skill invocation just to read a message and decide what to do
- The inbox file is an intermediate store that adds latency (write to file → queue → Mag wakes → reads file → acts)
- Every other skill carries "check inbox" boilerplate, inflating prompt context
- The `--consume` / archive dance adds moving parts for crash recovery

## Proposal: Direct Queue Injection

Replace the inbox file + dedicated skill with direct message content in the queue:

### Change 1: Subscriber writes message body into the queue

```typescript
// In subscribeIncoming(), instead of:
appendToInbox(data.message, data.title);
queueRequest("message");

// Do:
const escaped = data.message.replace(/"/g, '\\"');
queueRequest("message", `"content":"${escaped}"`);
```

The queue entry becomes:
```json
{"id":"req-...","action":"message","timestamp":"...","content":"approve elaboration for task-042"}
```

### Change 2: Mag stop hook injects message content directly

In `magProcessQueue()`, when `action === "message"`:

```typescript
case "message": {
  const content = String(request.content ?? "");
  return `/user-message ${content}`;
  // Or simply type the message into Mag's terminal as a user turn
}
```

**Simplest version**: just send the message text as a user turn to Mag's tmux session. Mag is already Claude Code — it can interpret "approve elaboration for task-042" without a skill telling it how. The queue entry provides the timestamp and content; Mag's own CLAUDE.md context tells it what ludics commands are available.

### Change 3: Remove inbox boilerplate from other skills

Delete the "Check inbox" step from `ludics-suggest`, `ludics-health-check`, and `ludics-briefing`. Incoming messages are already processed as they arrive (via the queue). If Mag is mid-skill when a message arrives, it queues normally and processes next — no need for every skill to defensively poll.

The briefing pre-computation already captures inbox content into `briefing-context.md`. If we want to preserve that for the briefing, the subscriber can still log to `notifications.jsonl` (which it already does), and the briefing context generator can read recent incoming notifications from there.

### Change 4: Retire `ludics-read-inbox.md`

With direct injection, the skill has no role. Delete it.

### What we keep

- `mag/inbox.md` can survive as an **optional manual channel** — the user can edit it directly and run `ludics mag message "check inbox"` to nudge Mag. This preserves the flexibility the inbox file provides (e.g., multi-paragraph messages, file-based automation) without making it the primary path.
- `notifications.jsonl` continues logging all directions for audit.
- `ludics mag message "text"` still works — it writes to the queue with content inline.

## Alternative: Keep the Skill but Slim It

If we want to keep the skill for structured processing:

- Trim `ludics-read-inbox.md` to ~10 lines: "Read the `content` field from the queue request. Act on it. Done."
- Still remove inbox boilerplate from other skills.
- Still remove the inbox file as intermediate store.

This is less minimal but preserves the "skill per action" pattern.

## Argument for Status Quo

The current design does have a virtue: the inbox file is human-readable, appendable from multiple sources (ntfy, CLI, even manual file edits), and acts as a buffer if Mag is down. The archival to `past-messages.md` provides history.

However, `notifications.jsonl` already provides the audit trail, and the queue itself buffers requests when Mag is unavailable. The inbox file is redundant with both.

## Recommendation

Go with **Direct Queue Injection** (Changes 1-4). It eliminates:
- 1 skill file (55 lines of prompt overhead)
- 1 intermediate file (`inbox.md` as required path)
- ~6 lines of boilerplate across 3 other skills
- The `--consume` / archive machinery in the CLI

Net result: an incoming ntfy message reaches Mag as a direct conversational turn within one queue cycle, with zero intermediate files.
