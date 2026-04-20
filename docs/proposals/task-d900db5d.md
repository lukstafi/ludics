# Proposal: Add `{{#UNLESS VAR}}` conditional blocks to `substituteTemplate` and remove pre-computation workarounds

**Task**: task-d900db5d
**Project**: Ludics
**Effort**: small

## Goal

Extend the template engine in `substituteTemplate()` with a negated conditional `{{#UNLESS VAR}}...{{/UNLESS}}` (include body when variable is empty/missing), and inline two pre-computed context variables (`UPSTREAM_REPO_NOTE`, `PR_CREATE_REPO_FLAG`) into their respective templates using `{{#IF}}` conditionals, removing the TypeScript-side workarounds.

## Acceptance Criteria

1. **`{{#UNLESS VAR}}` support**: `substituteTemplate()` processes `{{#UNLESS VAR}}...{{/UNLESS}}` blocks, including the body when the named variable is empty or absent, and removing it when the variable is non-empty.
2. **Inside-out evaluation**: `#UNLESS` blocks evaluate innermost-first (same strategy as `#IF`), and `#IF`/`#UNLESS` can be freely nested inside each other.
3. **`UPSTREAM_REPO_NOTE` removed**: The pre-computed `UPSTREAM_REPO_NOTE` key is removed from `buildSkillContext()`. The upstream-forwarding note is expressed inline in templates using `{{#IF UPSTREAM_REPO}}...{{/IF}}`.
4. **`PR_CREATE_REPO_FLAG` removed**: The pre-computed `PR_CREATE_REPO_FLAG` key is removed from `buildSkillContext()`. The `--repo` flag is expressed inline in templates using `{{#IF PROJECT_REPO}}...{{/IF}}`.
5. **Templates updated**: `skills/orchestration/pr-create.md` and `skills/orchestration/pair-coder-pr-create.md` use inline conditionals instead of the removed variables.
6. **Tests**: New tests for `#UNLESS` (missing var, empty var, non-empty var, nested `{{VAR}}` inside, multi-line, mixed `#IF`+`#UNLESS`). Existing tests referencing the removed variables (`UPSTREAM_REPO_NOTE`, `PR_CREATE_REPO_FLAG`) are updated or replaced. `baseCtx()` no longer includes `UPSTREAM_REPO_NOTE`.
7. **No regressions**: All existing `#IF` tests continue to pass. Template rendering for `pr-create` and `pair-coder-pr-create` produces equivalent output.

## Context

- `substituteTemplate()` in `src/orchestration/skills.ts` already implements `{{#IF VAR}}...{{/IF}}` using an inside-out regex loop (the `leafIf` pattern with negative lookahead `(?:(?!\{\{#IF\s)[\s\S])*?`).
- `buildSkillContext()` in the same file pre-computes `UPSTREAM_REPO_NOTE` (lines 281-283) and `PR_CREATE_REPO_FLAG` (lines 296-299) as string concatenations. These exist solely because the original template language lacked conditionals. Now that `#IF` exists, they are unnecessary indirection.
- `baseCtx()` in `src/orchestration/skills.test.ts` (line 67) includes `UPSTREAM_REPO_NOTE: ""`. Tests at lines 161-191 directly assert on `UPSTREAM_REPO_NOTE` rendering. Test at line 583 asserts on `PR_CREATE_REPO_FLAG`.
- The `#UNLESS` feature is needed for future use cases (default-when-unconfigured patterns) and for template language completeness/symmetry.

## Approach

### A. Add `{{#UNLESS VAR}}...{{/UNLESS}}` to `substituteTemplate()`

Insert a second while-loop immediately after the `#IF` loop (between the current Phase 1 and Phase 2 comments), using an identical regex strategy with `#UNLESS`/`/UNLESS` tags and inverted inclusion logic:

```typescript
// Phase 1b: process conditional blocks {{#UNLESS VAR}}...{{/UNLESS}}
const leafUnless = /\{\{#UNLESS\s+([A-Z0-9_]+)\}\}((?:(?!\{\{#UNLESS\s)[\s\S])*?)\{\{\/UNLESS\}\}/g;
while (leafUnless.test(result)) {
  result = result.replace(leafUnless, (_match, key: string, body: string) => {
    return (values[key] ?? "") === "" ? body : "";
  });
}
```

The `#IF` pass runs first and resolves all `#IF` blocks, then `#UNLESS` runs on the result. The two lookaheads (`(?!\{\{#IF\s)` and `(?!\{\{#UNLESS\s)`) are independent, so cross-nesting works naturally.

### B. Inline `UPSTREAM_REPO_NOTE` into templates

Replace `{{UPSTREAM_REPO_NOTE}}` in `pr-create.md` and `pair-coder-pr-create.md` with:

```
{{#IF UPSTREAM_REPO}}
> **Upstream forwarding**: This project forwards approved PRs to upstream (`{{UPSTREAM_REPO}}`). Create the PR against the working repo, not upstream.
{{/IF}}
```

Remove the `UPSTREAM_REPO_NOTE` property from `buildSkillContext()`.

### C. Inline `PR_CREATE_REPO_FLAG` into templates

Replace `{{PR_CREATE_REPO_FLAG}}` in the `gh pr create` lines with:

```
gh pr create {{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}--title ...
```

Remove the `PR_CREATE_REPO_FLAG` computation from `buildSkillContext()`.

### D. Update tests

- Remove `UPSTREAM_REPO_NOTE` from `baseCtx()`.
- Replace the three tests at lines 161-191 that assert on `UPSTREAM_REPO_NOTE` with equivalent tests that render the actual `pr-create.md` template and verify inline conditional output.
- Update the `PR_CREATE_REPO_FLAG` assertion at line 583 (either remove or change to verify `PROJECT_REPO` is set and the template renders correctly).
- Add `#UNLESS` tests mirroring the existing `#IF` suite (6 tests listed in task elaboration Part D).

### Not in scope

- `PROPOSAL_INSTRUCTION` and `VERIFICATION_CONTEXT` pre-computations remain unchanged (they contain complex logic that does not reduce to simple conditionals).
- No new `#UNLESS` usage in templates yet (the feature is added for completeness; concrete usage will come in future tasks).
