# Proposal: Fix tmux capture sort and header parsing

**Task**: task-e94f5fbb
**Project**: ludics
**Date**: 2026-04-05

## Goal

Clean up three related issues in `src/orchestration/tmux-capture.ts` that affect correctness for orchestrations reaching round >= 10 and improve code maintainability by eliminating duplicated header parsing logic.

## Acceptance Criteria

1. **Zero-padded round numbers in capture filenames**: `captureTmuxAgentOutputs` produces filenames like `round-001-work-coder.txt` (3-digit zero-padded), so alphabetical and numeric sort orders agree.

2. **No misleading `.sort()` in `readTmuxCaptures`**: The bare `.sort()` on `readdirSync` results is removed. The authoritative sort remains the numeric sort on parsed entries at the end of the function.

3. **Shared `parseCaptureHeader` helper**: A single function parses the `agent:/phase:/round:/timestamp:/hash:` header block. Both `lastCaptureHash` and `readTmuxCaptures` call it instead of inlining regex parsing.

4. **Simplified `lastCaptureHash` sort**: With zero-padded filenames, the custom numeric comparator can be replaced by plain `.sort()` (alphabetical order is now correct). Alternatively, keep the numeric sort for mixed-format robustness -- either is acceptable.

5. **Tests updated**: Existing test filenames use zero-padded format. At least one test case exercises round >= 10 to verify sort correctness. A unit test for `parseCaptureHeader` is added.

6. **No regressions**: `bun test` passes, including tmux-capture tests.

## Context

- **File**: `src/orchestration/tmux-capture.ts` (187 lines)
- **Test file**: `src/orchestration/tmux-capture.test.ts`
- **Consumers**: `retrospective.ts` (calls `readTmuxCaptures`), `runner.ts` (calls `captureTmuxAgentOutputs`)
- **Scope**: Single file refactor + test updates. No API changes to exported functions.

## Approach

1. Define `CaptureHeader` interface and `parseCaptureHeader(raw: string): CaptureHeader | null` that finds the `\n---\n` separator, slices the header portion, and applies the five regex extractions. Export it for testing.

2. In `captureTmuxAgentOutputs` (line 133), change the filename template to use `String(state.round).padStart(3, '0')`.

3. In `readTmuxCaptures` (line 149), remove the `.sort()` call. Replace the inline header parsing block (lines 154-175) with a call to `parseCaptureHeader`.

4. In `lastCaptureHash`, replace the inline hash extraction (line 90) with `parseCaptureHeader`. Simplify the sort to plain `.sort()` since zero-padded filenames sort correctly alphabetically.

5. Update test filenames to `round-001-...`, `round-002-...` format. Add a test with `round-012-...` to verify double-digit round ordering. Add a direct `parseCaptureHeader` unit test.
