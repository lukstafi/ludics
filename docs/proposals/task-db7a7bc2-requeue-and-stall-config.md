# Proposal: Requeue-on-failure for maybeFeedMagQueue and stall config validation in mag doctor

**Task:** task-db7a7bc2
**Date:** 2026-04-13

## Goal

Improve queue delivery reliability and config validation. Currently, if `triggerSkill()` fails after a queue item is popped in `maybeFeedMagQueue()`, the item is silently lost (at-most-once delivery). Additionally, `magDoctor()` does not validate the `stall_threshold_seconds` and `stall_nudge_cooldown_seconds` config values, making misconfiguration hard to diagnose.

Related: follow-up from task-1772ff03 retrospective (settled-aware queue feed).

## Acceptance Criteria

1. When `triggerSkill()` returns `false` in `maybeFeedMagQueue()`, the popped queue item is reinserted at the front of `queue.jsonl` for retry on the next keepalive cycle.
2. A retry counter (e.g., `_retry_count` field on the JSON object) prevents infinite requeue loops. After a configurable max retries (default 3), the item is dropped with a `mag_queue_dropped` event.
3. A distinct `mag_queue_requeued` event is emitted on each requeue.
4. `magDoctor()` validates `mag.stall_threshold_seconds` and `mag.stall_nudge_cooldown_seconds` from config: warns if present but not a positive number, displays effective values (configured or default), and optionally warns on unusually low (<30s) or high (>600s) thresholds.
5. `bun run build` succeeds and all existing tests pass.

## Context

### Queue feed pipeline (src/mag.ts)

`maybeFeedMagQueue()` (line ~241): checks `isMagSettled()` and `queuePending()`, claims the settled sentinel via atomic rename, calls `queuePopSkill()` which internally calls `dequeueQueueHead()` to remove the front line from `queue.jsonl`. The resolved command string is then passed to `triggerSkill()`. On failure (lines 267-270), an event is emitted but the item is lost.

**Key types and functions:**
- `dequeueQueueHead()` (line ~1177): returns `{ status: "popped", line: string, request: Record<string, unknown> | null }` -- the `line` field contains the original JSONL text.
- `queuePopSkill()` (line ~1200): calls `dequeueQueueHead()`, resolves the request to a skill command string via `resolveQueueRequestCommand()`. Returns only the command string (loses the original line).
- `triggerSkill()` (line ~97): sends keys to tmux session, returns boolean.

### Queue file helpers (src/queue.ts)

- `readQueueLines()` / `writeQueueLines()` (lines 73-89): atomic read/write of queue file lines using tmp+rename pattern. These can be used as building blocks for a reinsertion helper.

### Stall config (src/mag.ts)

`stallThresholdMs()` and `stallNudgeCooldownMs()` (lines 174-188) read from `config.mag` and silently fall back to defaults (120s each). `magDoctor()` (line ~3045) checks tmux, claude, jq, ttyd, session, state dir, queue, and stop hooks but does not validate any config values.

## Scope

**In scope:**
- Requeue mechanism in `maybeFeedMagQueue()` with retry counting
- Queue reinsertion helper (prepend to front of `queue.jsonl`)
- Stall config validation section in `magDoctor()`
- Associated events for requeue and drop

**Out of scope:**
- Changes to queue pop semantics elsewhere (stop hooks, CLI commands)
- Changes to stall detection logic itself
- New configuration keys beyond retry max
