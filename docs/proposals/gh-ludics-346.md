# pairReviewVerdict parser fix: line-1-wins-with-fallback

## Goal

Fix `pairReviewVerdict()` in `src/orchestration/phases.ts` so that reviews whose
verdict line 1 is `APPROVE` are correctly parsed as approvals, even when the
review body contains the literal token `REQUEST_CHANGES` in prose (quoted
template text, filenames, flag names, consequence descriptions, etc.).

Issue: https://github.com/lukstafi/ludics/issues/346

Motivating incident: on 2026-04-23, slot 6 looped review → work → review → work
for 5 rounds on `gh-ludics-310`. Every review began with `APPROVE` on line 1
but contained a sentence like "…REQUEST_CHANGES consequences." The whole-file
regex matched the token in prose, returned `request_changes`, and the
orchestrator routed back to work each round despite a passing review.

## Acceptance Criteria

- `pairReviewVerdict()` returns `"approve"` for a review whose first non-blank
  verdict-bearing line is `APPROVE` (with or without `**…**` markers,
  backticks, or leading whitespace), regardless of what the rest of the body
  contains — including bodies that mention the literal string
  `REQUEST_CHANGES`.
- `pairReviewVerdict()` returns `"request_changes"` for a review whose first
  non-blank verdict-bearing line is `REQUEST_CHANGES` (with optional markup).
- Reviews that start with a common header prefix (`## Verdict`,
  `**Verdict**:`, `### Verdict`, etc.) before the verdict token are still
  parsed correctly — the parser skips recognized header prefixes and picks the
  verdict from the first non-blank line after them.
- Empty or blank review files still return `null`.
- A fallback to the current whole-body regex is used **only** when the first
  (header-skipped) non-blank line matches neither verdict token — so unusual
  layouts do not silently break, but well-formed reviews are never
  contaminated by prose.
- The fix applies to both the `review` and `plan-review` callers in
  `evaluateTransition` — no divergence between them (single shared parser).
- Existing tests in `src/orchestration/phases.test.ts` continue to pass
  unchanged — specifically the fixtures that write:
  - `"APPROVE\n"` (multiple tests)
  - `"## Verdict\nREQUEST_CHANGES\n"` (regression test)
  - The plan-review `REQUEST_CHANGES` loop-back test.
- A new regression test is added that writes a review with `APPROVE` on line 1
  followed by a prose body containing the literal token `REQUEST_CHANGES`, and
  asserts the verdict parses as `"approve"` (transition: `review` →
  `update-docs`, not `review` → `work`). This is the direct regression for
  the slot 6 / gh-ludics-310 incident.

## Context

### Current implementation

`src/orchestration/phases.ts`, function `pairReviewVerdict()`:

```ts
const content = readFileSync(reviewFile, "utf-8").toUpperCase();
if (/\bAPPROVE\b/.test(content) && !/\bREQUEST_CHANGES\b/.test(content)) return "approve";
if (/\bREQUEST_CHANGES\b/.test(content)) return "request_changes";
return null;
```

Any word-boundary occurrence of `REQUEST_CHANGES` anywhere in the uppercased
body wins, regardless of where `APPROVE` appears. This is the bug.

### Callers

Both callers live in `evaluateTransition` in the same file and route through
this single function; `state.phase` selects which review-file path is read
(via `reviewFilePath`), not which parser is used:

- `"review"` case: `request_changes` → stay in `"work"`; otherwise →
  `"update-docs"`.
- `"plan-review"` case: `request_changes` + `planMergeRound < 3` → back to
  `"plan-merge"`; otherwise → `"work"`.

Both must benefit from the fix — one parser change is sufficient.

### Templates prescribe line-1 verdict shape

- `skills/orchestration/pair-reviewer-review.md` — "The first line is either
  `APPROVE` or `REQUEST_CHANGES`, followed by action items…"
- `skills/orchestration/pair-reviewer-plan-review.md` — "Write `APPROVE` or
  `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`."

No template changes are needed.

### Test fixtures that anchor expected shapes

In `src/orchestration/phases.test.ts` (must keep passing):

- Tests writing `"APPROVE\n"` to `round-N-reviewer.md` (several).
- `"regression: REQUEST_CHANGES + fresh status → review transitions to work"`
  writes `"## Verdict\nREQUEST_CHANGES\n"`.
- `"plan-review in pair mode loops back to plan-merge on REQUEST_CHANGES
  (round < 3)"`.
- `"plan-review proceeds to work after 3 REQUEST_CHANGES rounds"` (guarded by
  `planMergeRound >= 3`, independent of parser behavior).

### Out of scope

- **Loop detection / round-count limits** — rejected by the user on
  2026-04-23. The general-purpose escape hatch for stuck-state situations is
  being designed as an agent-initiated `bail-out: escalate` action in sibling
  task-4cd94043.
- **`runner.ts` merge-review parser** — `approval.toUpperCase().includes("APPROVE")`
  reads a separate `MERGE_REVIEW_DECISION_FILE` (written by
  `merge-review.md`), not a prose body. Not affected by this bug; not changed
  here.
- **Template changes** — already prescribe line-1 verdict shape.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

**Option 4 from the task: "line 1 wins with fallback."** The user selected
this explicitly.

1. Read and uppercase the review body as today.
2. Split into lines; skip leading blank lines and skip recognized "verdict
   header" prefix lines (patterns like `^\s*#{1,6}\s*VERDICT\s*:?\s*$`,
   `^\s*\*\*VERDICT\*\*\s*:?\s*$`).
3. Take the first remaining non-blank line. Strip surrounding `**`, backticks,
   trailing punctuation/whitespace.
4. If that line equals `APPROVE` → return `"approve"`.
   If it equals `REQUEST_CHANGES` → return `"request_changes"`.
5. **Fallback (silent safety net):** if the first line matches neither, run
   the existing whole-body regex logic as today. This preserves parsing for
   unconventional reviews without re-introducing the prose-contamination bug
   for well-formed ones.
6. If still no match and the file is empty/blank → return `null` (unchanged).

Apply once to `pairReviewVerdict()`. No caller changes needed.

### Edge cases to handle explicitly

- `**APPROVE**` / `**REQUEST_CHANGES**` with bold markers.
- `` `APPROVE` `` with backticks.
- Leading whitespace before the verdict token.
- `## Verdict\nAPPROVE\n` — header on line 1, verdict on line 2. Header-prefix
  skipping handles this.
- Trailing period/colon after verdict (e.g., `APPROVE.`) — strip trailing
  punctuation before matching.
- Empty/blank file → `null` (unchanged behavior).

## Scope

**In:**
- Single function change to `pairReviewVerdict()` in
  `src/orchestration/phases.ts`.
- One new regression test in `src/orchestration/phases.test.ts` covering the
  gh-ludics-310 incident shape (APPROVE line 1 + prose body mentioning
  `REQUEST_CHANGES`).
- Verify existing tests still pass unchanged.

**Out:**
- Loop detection, round-count limits, auto-skip heuristics
  (→ task-4cd94043, `bail-out: escalate`).
- Changes to `runner.ts` merge-review parser (different decision file,
  different bug surface).
- Template changes (already correct).
- Retroactive fixes to any in-flight slot state — fix applies going forward;
  manual unblock of slot 6 already occurred.

**Dependencies:** none. Sibling task-4cd94043 (`bail-out: escalate`) is
independent and can ship in any order.
