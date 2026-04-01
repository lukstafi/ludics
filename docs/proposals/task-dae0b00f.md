# Fix addFrontmatterField body-scope bug — regression test

## Goal

The `addFrontmatterField()` function in `src/tasks/markdown.ts` had a bug where
its existence check scanned the entire file instead of just the YAML frontmatter
block. A matching line in the markdown body (e.g., `priority: high`) would cause
the function to silently drop the write. The code fix was committed in `e018874`
but no regression test was added. This proposal covers adding that test.

## Acceptance Criteria

- A regression test verifies that `addFrontmatterField` correctly inserts a new
  field even when the markdown body contains a line matching `field: value`.
- A test covers the normal delegation path: when the field already exists in
  frontmatter, `addFrontmatterField` delegates to `updateFrontmatterField` and
  updates the value.
- Tests pass with `bun test src/tasks/markdown.test.ts`.

## Context

**Key files:**

| File | Role |
|------|------|
| `src/tasks/markdown.ts` | Contains `addFrontmatterField`, `updateFrontmatterField` — code under test (already fixed) |
| `src/tasks/priority-value.test.ts` | Existing test file — reference for test patterns (`bun:test`, `describe`/`test`/`expect`) |

**How `addFrontmatterField` works (post-fix):**

1. Reads the file content.
2. Extracts the frontmatter block via `/^---\n([\s\S]*?)\n---/`.
3. Checks if any line in the extracted frontmatter starts with `${field}:`.
4. If found → delegates to `updateFrontmatterField` (updates in place).
5. If not found → inserts `field: value` before the closing `---`.

The bug (pre-fix) was at step 2–3: the existence check used
`content.includes(\`\n${field}:\`)` on the full file content, so a body line
like `priority: high` would trigger delegation to `updateFrontmatterField`,
which would then find nothing in the frontmatter and silently no-op.

**Test approach:** The functions operate on real files (`readFileSync`/
`writeFileSync`), so tests should use temp files. Write content to a temp file,
call the function, read back and assert. Clean up in `afterEach`/`afterAll`.

## Scope

**In scope:** Regression tests for `addFrontmatterField` covering the body-scope
bug and the normal update-delegation path.

**Out of scope:** Tests for `removeFrontmatterField`, `updateDependencyArray`,
`parseTaskFrontmatter`, or other markdown utilities (can be added later in the
same test file).

**No dependencies** on other tasks.
