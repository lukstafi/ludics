Instead of rewriting statuses, "completed" should not be considered a valid status. Also, consider introducing "in-progress" as a valid status.

# Follow-up: Solution for gh-ludics-30

This is a follow-up task based on feedback from PR #32.
PR: https://github.com/lukstafi/ludics/pull/32

## Original PR Description

Solution from coder for feature: gh-ludics-30

## PR Comments and Reviews

The comments below (most recent last) describe what needs to be done.
Focus especially on the last comment(s) for the actionable task.

### Comment by lukstafi (2026-03-05T17:54:52Z)

Addressed both review points in 5b9ed57:
- Added per-task auto-proposal debounce (30m) so keepalive does not repeatedly enqueue `draft-proposal` for the same task while it is in progress.
- Kept auto-clear trigger for `done`/`completed`, but normalize slot clear to `done` so `slotClear` done-path side effects (dependency prune + preempt restore) run consistently.

### Comment by lukstafi (2026-03-05T18:16:22Z)

## Refactoring Suggestions

*Post-merge retrospective: what would we do differently if starting from scratch?*

# Refactoring Suggestions

## If starting from scratch, I would...

1. Centralize task status parsing/normalization in one helper used by `src/mag.ts` and `src/slots/index.ts`.
- Right now status strings (`ready`, `done`, `completed`, `abandoned`) are matched ad hoc in multiple places.
- Add a shared helper (for example in `src/tasks/status.ts`) with `readTaskStatus(content)` and `isTerminalStatus(status)` to avoid drift and subtle mismatches.

2. Move auto-proposal dedupe/debounce logic out of `src/mag.ts` keepalive flow into `src/queue.ts`.
- `maybeQueueProposals()` currently combines candidate selection and queue dedupe timing.
- Add queue-level APIs like `queueHasPendingDraftProposal(taskId)` and `queueRequestDebounced(action, key, seconds)` so all queue producers use one dedupe mechanism.

3. Treat `completed` as a first-class normalized terminal state at the slot boundary.
- `maybeClearDoneSlots()` now maps `completed` to `done` before `slotClear()` so side effects run.
- Better long-term approach: normalize inside `slotClear()`/`taskUpdateForSlotClear()` in `src/slots/index.ts` so every caller gets consistent behavior without remembering conversions.

4. Add focused integration tests around keepalive lifecycle behavior.
- Add tests covering: no requeue for terminal tasks, auto-clear on done/completed, one-slot-per-cycle fill, and no duplicate auto-proposal enqueue for same task within debounce window.
- These should exercise `mag start` keepalive-path orchestration with fixture task/slot files.

5. Replace repeated direct `queue.jsonl` string scans with structured query helpers.
- `src/mag.ts` currently checks `qContent.includes('"draft-proposal"')` in multiple functions.
- Expose typed query helpers in `src/queue.ts` to reduce false positives and make future queue format changes safer.

### Review by chatgpt-codex-connector (COMMENTED, null)


### 💡 Codex Review

Here are some automated review suggestions for this pull request.

**Reviewed commit:** `a198bdd720`
    

<details> <summary>ℹ️ About Codex in GitHub</summary>
<br/>

[Your team has set up Codex to review pull requests in this repo](http://chatgpt.com/codex/settings/general). Reviews are triggered when you
- Open a pull request for review
- Mark a draft as ready
- Comment "@codex review".

If Codex has suggestions, it will comment; otherwise it will react with 👍.




Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".
            
</details>

## Implementation Notes (Round 1)

- Removed `completed` from keepalive status handling in `src/mag.ts`:
  - `taskIsConcluded()` now treats only `done` / `abandoned` as concluded by status.
  - `maybeQueueProposals()` no longer treats `completed` as a terminal status.
  - `maybeClearDoneSlots()` now auto-clears only when status is `done`.
- Added `in-progress` to `slot clear` valid statuses in `src/slots/index.ts`.
- Updated CLI/docs usage text to match:
  - `src/index.ts`
  - `docs/ARCHITECTURE.md`
