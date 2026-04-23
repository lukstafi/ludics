# Document effort levels in `docs/task-frontmatter-reference.md`

## Goal

Add a canonical, shareable reference for the `effort` frontmatter field on tasks. The four-level scale (`tiny` / `small` / `medium` / `large`) is currently baked into three code sites — `src/tasks/types.ts` (terse trailing comment), `src/dashboard-server.ts` (validation allowlist), `src/adapters/t3code.ts` (`selectOrchestrationFlags` workflow mapping) — but the *criterion* for picking one level over another lives nowhere canonical. Every agent or human doing triage has to re-derive the scale, and stringent-vs-generous calibration varies by session.

This proposal establishes a new `docs/task-frontmatter-reference.md` as the future home for frontmatter field references (effort today; priority ladder, status lifecycle, `skip_plan`, etc. later), and seeds it with the effort-level section.

Source: conversational follow-up to the mass effort-level audit on 2026-04-22; task-da8b6dff wired `tiny` mechanically (PR #332) but deferred the user-facing doc. No GitHub issue.

## Acceptance Criteria

- [ ] A new file `docs/task-frontmatter-reference.md` exists, introduced as the reference doc for task frontmatter fields, with room to grow beyond the effort section.
- [ ] The file contains an `## Effort levels` section (anchor `#effort-levels`) with four short paragraphs — one each for `tiny`, `small`, `medium`, `large` — covering selection criteria and the orchestration behavior each level maps to.
- [ ] Each paragraph describes:
  - **`tiny`**: mechanical edit whose diff can be sketched without reading the codebase; up to ~4 files of predictable changes; no new abstractions, no new decision points. Maps to Sonnet + `--solo` + no pre-work phases (unconditional early-return in `selectOrchestrationFlags`, ignoring `orchCfg.default_mode`). Worked examples: delete-only / rename-only cleanups at known call sites; single-file helper extraction from known call sites; targeted lint or doc-only change; proposals that explicitly set `skip_plan: true` because implementation is 1:1.
  - **`small`**: focused scope but requires some thinking. Maps to Sonnet + pair mode + no pre-work phases. Worked examples: cross-cutting refactor across a handful of files; single-feature extension to an existing component; fix-or-retire decisions on a short list of failures.
  - **`medium`** (default at task creation): multi-component change or one that needs a design. Maps to Opus + pair mode + `--plan` (unless `skip_plan: true` in frontmatter, which is the one manual override the flag honors). Worked examples: new module with tests; multi-template coordinated edit; adapter extension.
  - **`large`**: multi-week or architectural. Maps to Opus + pair mode + `--plan --gather` (`skip_plan` is ignored at this level). Worked examples: phased architectural work, module split, new subsystem.
- [ ] The section notes that `skip_plan: true` only takes effect at `medium` effort — at `tiny` / `small` the plan phase is already skipped, at `large` the flag is ignored.
- [ ] Framing is descriptive, not normative — phrased so a future `huge` / `epic` level is not foreclosed. No "must never exceed" language; use "typically", "up to ~", etc.
- [ ] The comment on `TaskFrontmatter.effort` in `src/tasks/types.ts` is updated from the terse `// tiny, small, medium, large` to a cross-reference pointing to the new doc (e.g. `/** @see docs/task-frontmatter-reference.md#effort-levels */`, preserving the enumeration of allowed values for IDE-tooltip readers). Content stays in the doc — the comment is just a pointer.
- [ ] `docs/orchestration-patterns.md` is **not** modified (keep it standalone per resolved question #3).
- [ ] `docs/ARCHITECTURE.md` is **not** modified (primary location is the new standalone doc per resolved question #1). An optional forward-link from ARCHITECTURE.md's existing `--solo` CLI mention is *not* required by this task.
- [ ] The file passes whatever Markdown linting the repo uses (e.g. clean render in the dashboard Markdown parser).

## Context

Three code sites currently encode the four-level scale without pointing at a shared doc:

- **`src/tasks/types.ts`** — `TaskFrontmatter.effort: string` has only `// tiny, small, medium, large` as its docstring. This is the natural place for the cross-reference comment.
- **`src/dashboard-server.ts`** — the task-create handler validates incoming `effort` values against the allowlist `["tiny", "small", "medium", "large"]`, defaulting to `"medium"`. (Search for the allowlist literal; it lives in the POST handler that creates tasks.)
- **`src/adapters/t3code.ts`** — `selectOrchestrationFlags` is the code-level contract the doc describes. The function's existing docstring already summarizes the effort → workflow mapping accurately:
  - `tiny` → `--solo --coder ${coder}:${DEFAULT_CLAUDE_MODEL}` (early return, bypasses `orchCfg.default_mode`).
  - `small` → pair (or configured default) + Sonnet + no pre-work phases.
  - `medium` → pair + Opus + `--plan` (unless `options.skipPlan`).
  - `large` → pair + Opus + `--plan --gather`.

Existing related proposals (cross-link-worthy from the new doc if desired, though not required):

- `docs/proposals/solo-mode-and-tiny-effort.md` — introduced `tiny` + `solo` together, with the auto-pairing rule.
- `docs/proposals/gh-ludics-309-small-effort-auto-skip-plan.md` — established the "small/tiny/unknown → no pre-work phases" contract.

`docs/task-frontmatter-reference.md` does not currently exist (verified 2026-04-23). The nearest existing doc, `docs/ARCHITECTURE.md`, shows `effort: large` in a frontmatter example around its "Task representation" subsection but gives no scale explanation; its line 443-ish `--solo` CLI entry mentions "tiny-effort tasks" in passing.

The revised `tiny` criterion is also captured privately in Mag's memory at `memory/feedback_effort_tiny_criterion.md`; this task makes the same yardstick shareable.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Create `docs/task-frontmatter-reference.md` with a brief preamble framing it as the growth-ready home for frontmatter field references, then a single `## Effort levels` section containing the four paragraphs. Keep the paragraphs roughly balanced in length; each should open with the selection criterion, close with orchestration behavior and a worked example or two.
2. Add a short note under the four paragraphs about the `skip_plan` interaction (one or two sentences is enough).
3. Update the `effort` field comment in `src/tasks/types.ts` to the cross-reference one-liner while preserving the list of allowed values so IDE tooltips remain self-sufficient.
4. Do not touch `docs/orchestration-patterns.md` or `docs/ARCHITECTURE.md`.

No code-behavior changes. No test changes expected (the content is purely descriptive).

## Scope

**In scope:**

- New file `docs/task-frontmatter-reference.md` with the `## Effort levels` section and a short preamble.
- One-line change to `src/tasks/types.ts` effort-field comment to cross-reference the new doc.

**Out of scope:**

- Any other frontmatter field sections in the new doc (future work; this task seeds the surface).
- Modifications to `docs/ARCHITECTURE.md`, `docs/orchestration-patterns.md`, or any other existing doc.
- Auto-enforcement (lints that flag mis-classified effort).
- Changing the default effort at task creation (stays `medium`).
- Changes to `selectOrchestrationFlags` or the dashboard allowlist.
- Back-porting the private `memory/feedback_effort_tiny_criterion.md` content verbatim — the doc should be freshly written for a public audience, not a copy-paste.

**Dependencies:** None. Relates to task-da8b6dff (which wired `tiny` into the code paths this doc describes).

**Effort:** `tiny` — this is a doc addition plus a one-line comment tweak at a known location. No design choices remain; no new abstractions. `skip_plan: true` is appropriate — the proposal is 1:1 with implementation.
