# Proposal: Consolidate review file parsing into shared helpers

**Task:** task-90dae811
**Effort:** small

## Goal

Extract all review filename construction and parsing into a single `review-files.ts` module with three helpers: `reviewFilename()`, `reviewFilePath()`, and `parseReviewFilename()`. This eliminates 7 scattered inline string interpolations and ad-hoc regexes, fixing a regex inconsistency (`\w+` vs `.+` for agent names) and establishing a single source of truth for the review file naming convention.

## Acceptance Criteria

- A new module `src/orchestration/review-files.ts` exports:
  - `reviewFilename(type, round, agentName)` returning the bare filename string
  - `reviewFilePath(peerSyncDir, type, round, agentName)` returning the full path under `reviews/`
  - `parseReviewFilename(filename)` returning `{ type, round, agentName }` or `null`
- `ReviewFileType` (`"review" | "plan-review"`) and `ParsedReviewFilename` interface are exported
- All 7 call sites listed below are updated to use the helpers; no inline review filename string interpolation or regex remains in `phases.ts`, `skills.ts`, or `retrospective.ts`
- Agent name matching uses `[\w-]+` (not `\w+` or `.+`) so names with hyphens work while still rejecting pathological inputs
- `parseReviewFilename` is unit-tested with cases for both filename types, hyphenated names, and non-matching strings
- Existing tests continue to pass (`bun test`)
- Plan file naming (`round-N-name.md` in `plans/`) is NOT in scope

## Context

### Construction sites (4)

1. **`src/orchestration/phases.ts:requiredArtifactPath()`** (line ~84): `plan-merge-${planMergeRound}-${agent.name}.md` and (line ~86) `round-${state.round}-${agent.name}.md`
2. **`src/orchestration/skills.ts:buildSkillContext()`** (line ~200): same two patterns for `reviewFile`
3. **`src/orchestration/skills.ts:buildSkillContext()`** (line ~218): `plan-merge-${planMergeRound - 1}-${peer.name}.md` for prior plan-review
4. **`src/orchestration/skills.ts:buildSkillContext()`** (lines ~222, ~224, ~263): `round-${round}-${peer.name}.md` for prior-round review and PREVIOUS_ROUND_SUMMARY

### Parsing sites (3)

5. **`src/orchestration/skills.ts:findLatestReview()`** (line ~19): regex `^round-(\d+)-${peerName}\.md$` — only matches normal reviews, not plan-reviews
6. **`src/retrospective.ts:extractVerdicts()`** (line ~274, ~285): regex `^round-(\d+)-(\w+)\.md$` and `^plan-merge-(\d+)-(\w+)\.md$`
7. **`src/retrospective.ts:extractReviews()`** (line ~313, ~328): regex `^round-(\d+)-(.+)\.md$` and `^plan-merge-(\d+)-(.+)\.md$`

The inconsistency: `extractVerdicts` uses `\w+` which excludes hyphenated agent names; `extractReviews` uses `.+` which could match too broadly (e.g., filenames with extra dots). Neither is ideal.

## Approach

### 1. Create `src/orchestration/review-files.ts`

```typescript
import { join } from "node:path";

export type ReviewFileType = "review" | "plan-review";

export interface ParsedReviewFilename {
  type: ReviewFileType;
  round: number;
  agentName: string;
}

const REVIEW_RE = /^round-(\d+)-([\w-]+)\.md$/;
const PLAN_REVIEW_RE = /^plan-merge-(\d+)-([\w-]+)\.md$/;

export function reviewFilename(type: ReviewFileType, round: number, agentName: string): string {
  return type === "plan-review"
    ? `plan-merge-${round}-${agentName}.md`
    : `round-${round}-${agentName}.md`;
}

export function reviewFilePath(
  peerSyncDir: string, type: ReviewFileType, round: number, agentName: string,
): string {
  return join(peerSyncDir, "reviews", reviewFilename(type, round, agentName));
}

export function parseReviewFilename(filename: string): ParsedReviewFilename | null {
  let m = filename.match(REVIEW_RE);
  if (m) return { type: "review", round: parseInt(m[1]!, 10), agentName: m[2]! };
  m = filename.match(PLAN_REVIEW_RE);
  if (m) return { type: "plan-review", round: parseInt(m[1]!, 10), agentName: m[2]! };
  return null;
}
```

### 2. Update construction sites

Replace all inline `join(dir, "reviews", \`round-...\`)` and `join(dir, "reviews", \`plan-merge-...\`)` calls in `phases.ts` and `skills.ts` with `reviewFilePath(dir, type, round, name)`.

### 3. Update parsing sites

- **`findLatestReview`**: replace the inline regex with `parseReviewFilename(entry)`, filter by `type === "review"` and `agentName === peerName`, track max round.
- **`extractVerdicts` and `extractReviews`**: replace inline regex pairs with a single `parseReviewFilename(f)` call, branching on the returned `type`.

### 4. Add unit tests

Add `src/orchestration/review-files.test.ts` covering:
- `reviewFilename` produces correct strings for both types
- `reviewFilePath` joins directory correctly
- `parseReviewFilename` parses both types, handles hyphenated names, returns `null` for non-matching inputs (e.g., plan files, malformed names)

### 5. Verify

Run `bun test` to confirm all existing tests pass.
