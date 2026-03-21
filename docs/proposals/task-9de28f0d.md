# Proposal: t3code thread cleanup and thread ID storage

## Summary

Persist t3code thread IDs in task frontmatter on slot clear, and delete stale threads during briefing preparation.

## Changes

### 1. Save thread IDs on slot clear (`t3code.ts`)

In the `stop()` function, before removing orchestration state:
- Read `threadIds` from the orchestration state
- Write them to the task file as `t3code_threads: [id1, id2]` via `addFrontmatterField()`
- This preserves the thread IDs after the ephemeral orchestration state is deleted

### 2. Clean up threads during briefing (`mag.ts`)

Add a step in the briefing (or keepalive) path:
- Scan task files for `status: done` or `status: abandoned` with `t3code_threads:` field
- For each thread ID, send a `thread.delete` command via the t3code WebSocket API
- Remove the `t3code_threads` field from the task after successful deletion (or mark as cleaned)
- Skip if t3code server is not running
- Idempotent — no error if threads are already gone

### 3. Task frontmatter field (`markdown.ts`)

- Add support for array field `t3code_threads` in frontmatter
- Format: `t3code_threads: ["thread-slot-5-abc123", "thread-slot-5-def456"]`

### Files to modify

- `src/adapters/t3code.ts` — save thread IDs in stop/clear flow
- `src/mag.ts` — briefing/keepalive thread cleanup step
- `src/t3code/client.ts` — thread delete command (if not already present)
- `src/tasks/markdown.ts` — array frontmatter helpers (if needed)
