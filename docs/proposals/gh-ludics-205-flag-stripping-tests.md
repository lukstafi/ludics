# Regression tests for flag-stripping (valued flag+argument pairs)

## Goal

Add regression tests that verify `stripModeAndRoleFlags` in `duo-expand.ts` correctly skips valued flag+argument pairs (e.g. `--coder claude-code:opus`) without leaking the argument as a stray positional token. This guards against the original bug where `.filter()` dropped only the flag name but left its value behind.

## Acceptance Criteria

- A new test file `src/slots/duo-expand.test.ts` exists with direct unit tests for `stripModeAndRoleFlags`
- `stripModeAndRoleFlags` is exported (or a thin re-export wrapper is added) so it can be tested directly
- Tests cover:
  - Valued flags (`--coder val`, `--reviewer val`, `--agent val`) are fully stripped (flag + value)
  - Standalone flags (`--pair`, `--duo`) are stripped
  - Non-flag tokens and unrelated flags are preserved
  - Mixed input: valued flags interleaved with other tokens (e.g. `--plan --coder claude-code:opus --gather`) yields only `--plan --gather`
  - Edge case: valued flag at end of args with no value token (graceful handling, no crash)
  - Edge case: multiple consecutive valued flags
- A regression test in `src/slots/index.test.ts` (in the existing "slot assign" describe block) verifies that duo expansion with `--coder claude-code:opus` does not leak `claude-code:opus` as a stray token in the expanded args
- All existing tests continue to pass

## Context

The function `stripModeAndRoleFlags` at `src/slots/duo-expand.ts:18-32` uses index-based iteration (`for` loop with `i++` skip) to correctly consume flag+value pairs. The fix is already in place -- this task adds tests only.

The function is currently **not exported**. It is called only from `expandDuoSlots` (line 65). To test it directly, it needs to be exported (preferred) or tested indirectly via `expandDuoSlots`.

Existing tests in `src/slots/index.test.ts:195-347` cover slot-assign orchestration flag parsing and duo expansion at the CLI level, but none specifically assert that a valued flag's argument is absent from the output.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. **Export `stripModeAndRoleFlags`** from `duo-expand.ts` (add `export` keyword to the function declaration).

2. **Create `src/slots/duo-expand.test.ts`** with direct unit tests:
   - Import `stripModeAndRoleFlags` and `expandDuoSlots`
   - Test `stripModeAndRoleFlags("--pair --coder claude-code:opus --plan")` returns `"--plan"`
   - Test `stripModeAndRoleFlags("--duo --reviewer codex:o3 --gather --agent foo")` returns `"--gather"`
   - Test `stripModeAndRoleFlags("--effort high --plan")` returns `"--effort high --plan"` (no stripping of unrelated flags)
   - Test `stripModeAndRoleFlags("--coder a --reviewer b --agent c")` returns `""`
   - Test `stripModeAndRoleFlags("--coder")` (missing value) does not crash

3. **Add regression test in `index.test.ts`** in the duo expansion section:
   - Assign a slot with `--duo --coder claude-code:opus --plan`
   - Assert the expanded adapter args contain `--coder claude-code:opus` (properly placed) but do NOT contain a bare `claude-code:opus` token outside a `--coder`/`--reviewer` flag context

4. **Run `bun test` to verify** all tests pass.
