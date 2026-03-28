# Proposal: Fix slots refresh not populating Session field for t3code

**Task:** gh-ludics-46
**Effort:** small
**Files changed:** 3 (`src/adapters/t3code.ts`, `src/slots/markdown.ts`, `src/adapters/t3code.test.ts`)

## Problem

After `ludics slots refresh`, a t3code slot's `**Session:**` field in `slots.md` stays `null`. Two independent bugs:

1. `readState()` in `t3code.ts` never emits a `**Session:**` line in its output
2. `mergeAdapterState()` in `markdown.ts` explicitly skips `**Session:**` lines from adapter output

## Change 1: Emit Session in t3code `readState()`

**File:** `src/adapters/t3code.ts`, line ~701

Add `md.keyValue("Session", slotState.threads[0]!.threadId)` to emit the primary thread ID as the Session value. For single-thread mode this is the only thread; for orchestrated mode it's the first thread's ID.

## Change 2: Parse and propagate Session in `mergeAdapterState()`

**File:** `src/slots/markdown.ts`, function `mergeAdapterState`

- Remove `**Session:**` from the skip group (was being discarded alongside Mode/Feature)
- Parse the session value from `**Session:**` lines into an `adapterSession` variable
- When rebuilding the slot block, replace `**Session:** null` with the adapter-provided value (if any; otherwise preserve the existing value)

## Change 3: Tests

**File:** `src/adapters/t3code.test.ts`

Three new test cases:
- Session field is populated from adapter output
- Session persists across multiple refreshes (not reset to null)
- Session is not cleared when adapter output lacks a Session line

## Notes

- All 100 tests pass
- agent-claude/agent-codex adapters unaffected (they don't emit Session from readState, and their Session is set at assign time)
