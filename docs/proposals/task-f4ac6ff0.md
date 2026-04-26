# Proposal: Fix SHELL_COMMANDS drift in final-merge.md rescue path

**Task:** task-f4ac6ff0
**Project:** ludics
**Effort:** small
**Priority:** B (CI-red)

## Goal

Restore green CI on the Ludics test suite by resolving the `SHELL_COMMANDS drift` failure in `scripts/lint-template-safety.test.ts:861`. PR #414 (task-9a9e7989) hardened the rescue path in `skills/orchestration/final-merge.md` with three new shell first-tokens (`:`, `state=$(gh`, `exit`) that the lint allowlist does not yet recognize. Apply a hybrid fix: extend `SHELL_COMMANDS` with the two universal POSIX builtins (`:` and `exit`) and rename the lowercase shell variable `state` to `STATE` in the skill so it conforms to the existing uppercase convention that `stripLeadingEnvAssignments` already handles. No parser change, no per-file exemption, no semantics drift.

## Acceptance Criteria

- [ ] `:` added to `SHELL_COMMANDS` array in `scripts/lint-template-safety.ts` (lines 41-49 region).
- [ ] `exit` added to `SHELL_COMMANDS` array in `scripts/lint-template-safety.ts` (lines 41-49 region).
- [ ] In `skills/orchestration/final-merge.md`, the variable `state` is renamed to `STATE` at both occurrences (the `state=$(gh ...)` assignment on line 13 and the `[ "$state" = "MERGED" ]` test on line 14).
- [ ] `bun test scripts/lint-template-safety.test.ts` passes (specifically the `SHELL_COMMANDS drift > every fenced shell block in skills/orchestration/* uses a known first-token` case).
- [ ] Full `bun test` is back to all-green (no other test regressed by the additions).
- [ ] Rescue-path semantics are preserved: on successful `gh pr merge` the `if` branch is a no-op (`:`); on failure the rescue queries `gh pr view` for `state` and exits non-zero unless the server reports `MERGED`.

## Context

### Failure mode

The `SHELL_COMMANDS drift` meta-test (added by task-b435e58d) walks every fenced ```sh``` block in `skills/orchestration/*.md`, tokenizes each line, and asserts that the first token of every command segment is one of: `SHELL_COMMANDS ∪ SHELL_KEYWORDS`, a known dispatch form (`$(`, `[`, `{`, `(`), or a `{{VAR}}` placeholder. After PR #414 merged, three new tokens in `final-merge.md` violate this:

```
final-merge.md:9: unknown shell first-token `:`
final-merge.md:13: unknown shell first-token `state=$(gh`
final-merge.md:14: unknown shell first-token `exit`
```

Token (1) is the POSIX no-op. Token (3) is a universal shell builtin. Token (2) is an env-var-style assignment whose lowercase name slipped past the strict `^[A-Z_][A-Z0-9_]*=` regex used by `stripLeadingEnvAssignments` (`scripts/lint-template-safety.test.ts:764-803`), so the parser sees the whole `state=$(gh` as a literal first token rather than peeling the assignment off.

### Why the meta-test is right to fail

This is the meta-test working as intended: a docs/skill change introduced shell tokens the lint allowlist doesn't know, and the suite caught it before the next release. The fix is to (a) genuinely expand the allowlist for tokens that *should* always be recognized (`:` and `exit` are first-class POSIX builtins, not exotic patterns), and (b) bring the offending skill into line with the established uppercase-shell-var convention rather than loosening the convention check parser-side.

### Rename rationale

The skill already uses uppercase for shell vars (`PR_URL` on line 7 of the same fenced block). The lowercase `state` was a one-off oversight in PR #414. Other orchestration skills also use uppercase consistently — `suggest-refactor.md:5`, `pr-conflict-resolve.md:6,16`, `pr-comments.md:7`. Renaming `state` → `STATE` aligns with that convention and lets the existing strict regex in `stripLeadingEnvAssignments` peel the assignment off naturally, with no parser change. The alternative — relaxing the regex to also accept `^[a-z_][a-zA-Z0-9_]*=` — would weaken an intentional convention signal across all skills for the sake of one slip.

### Sweep result

`grep` for `^\s*[a-z_][a-z0-9_]*=\$(` and for bare `:` / `exit` lines inside fenced shell blocks across `skills/orchestration/*.md` finds nothing else. `final-merge.md` is the only affected file; no other skill needs changes.

## Approach

Two files, ~4 mechanical edits.

### Edit 1: `scripts/lint-template-safety.ts` (lines 41-49)

Append `":"` and `"exit"` to the `SHELL_COMMANDS` array literal. Placement is non-load-bearing (the existing list is loosely category-grouped, not alphabetical); a natural fit is to put `":"` near `"true"`/`"false"` (other no-op-like builtins) and `"exit"` near `"eval"`/`"source"`/`"export"` (other shell-control builtins). Appending at the end is equally acceptable. Two literal additions.

### Edit 2: `skills/orchestration/final-merge.md` (lines 13-14)

Rename `state` to `STATE`. Two occurrences:

- Line 13: `state=$(gh pr view ...)` → `STATE=$(gh pr view ...)`
- Line 14: `[ "$state" = "MERGED" ] || exit 1` → `[ "$STATE" = "MERGED" ] || exit 1`

### Verification

1. Run `bun test scripts/lint-template-safety.test.ts` — the `SHELL_COMMANDS drift` test should pass; the synthetic-unknown-token sanity check (`:867-885`) should still pass (adding `:` and `exit` doesn't weaken detection of a fabricated unknown command like `helmfoo`).
2. Run full `bun test` to confirm no regressions.
3. Spot-check the rendered `final-merge.md` semantics: `if gh pr merge ...; then :; else STATE=$(...); [ "$STATE" = "MERGED" ] || exit 1; fi` is equivalent to the pre-fix block.

### Out of scope

- Extending the parser to recognize lowercase `<var>=$(<cmd>)` assignments (would weaken the uppercase convention check used across all orchestration skills).
- Adding per-file first-token exemptions to `TEMPLATE_ALLOWLIST` (that mechanism is for `{{VAR}}` placeholders only, not shell first-tokens — `lint-template-safety.ts:33-38`).
- Reordering or alphabetizing `SHELL_COMMANDS` (orthogonal cleanup).
