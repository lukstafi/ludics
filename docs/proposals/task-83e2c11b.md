## Goal

Clean up `src/orchestration/skills.ts` by removing dead code in `resolveProposalAbsPath` and extracting duplicated GitHub issue enrichment logic into a shared helper function.

## Acceptance Criteria

- `resolveProposalAbsPath` reduced to `assertRepoRelativeProposalPath(rawPath); return join(projectDir, rawPath);` — the unreachable `~/` and `/` branches are removed
- A helper function `appendGhIssueBody(content: string): string` is extracted, encapsulating the URL-match + `ghIssueBody()` + append pattern
- `taskSpecText` calls the helper in both branches (file-based proposal and inline/legacy) instead of duplicating the logic
- Existing `bun test` suite passes with no regressions
- No behavioral change: `taskSpecText` produces identical output for all code paths

## Context

**Dead code verified**: `assertRepoRelativeProposalPath` (src/adapters/task-launch.ts:29-38) throws for both `~/` prefixes and `/` prefixes. Therefore lines 72-75 of `resolveProposalAbsPath` (src/orchestration/skills.ts) are unreachable — any input matching those conditions would have already triggered an exception on line 71.

**Duplication verified**: The identical `urlMatch` regex + `ghIssueBody()` + append pattern appears at lines 139-147 (file-based proposal branch) and lines 154-162 (inline/legacy branch) of `taskSpecText`.

**No existing tests** for src/orchestration/skills.ts — adding tests is out of scope for this task.

## Approach

1. **Remove dead code**: Replace the body of `resolveProposalAbsPath` with just `assertRepoRelativeProposalPath(rawPath); return join(projectDir, rawPath);`. Update the docstring to reflect the simplified behavior.

2. **Extract helper**: Create `appendGhIssueBody(content: string): string` that matches a GitHub issue URL in content frontmatter, fetches the issue body via `ghIssueBody()`, and returns content with the issue body appended (or unchanged content if no match).

3. **Simplify `taskSpecText`**: Replace both inline URL-match blocks with calls to `appendGhIssueBody()` — `return appendGhIssueBody(contentWithPointer)` in the file-based branch and `return appendGhIssueBody(content)` in the legacy branch. This removes ~12 lines of duplicated code.
