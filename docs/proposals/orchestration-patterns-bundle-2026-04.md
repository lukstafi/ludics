# Orchestration Patterns Bundle — Add 14 Entries + Uniformity Trim

## Goal

Extend `docs/orchestration-patterns.md` with 14 new pattern entries (gathered from five source retrospectives / GitHub issues) and, in the same PR, audit the existing entries to trim sub-headers that don't earn their keep. The doc is the reference layer that skill templates cross-reference by anchor; this bundle lands the full backlog of pattern additions accumulated 2026-04-22 to 2026-04-23 in a single reviewable PR so the three sections (Planning / Coding / Reviewing) stay organized and slug anchors stabilize at once.

Provenance (all merged into this bundle per user's Option A decision on 2026-04-23):

- `task-21b4c850` retrospective — 3 patterns (this task's original scope).
- `task-d1932b8f` retrospective — 5 patterns (formerly `task-6f2b0c4a`, abandoned/subsumed).
- `task-da8b6dff` retrospective — 4 patterns (formerly `task-a06e7f69`, abandoned/subsumed).
- gh-ludics-335 (closed as subsumed) — 1 pattern.
- gh-ludics-337 (closed as subsumed) — 1 pattern.

Closes: GitHub issues 335 and 337 (patterns-doc fold of their live scope).

## Acceptance Criteria

**A. New entries added (14 total).** Each of the 14 anchor slugs below exists in `docs/orchestration-patterns.md` under the indicated `##` section, and each entry picks 2–4 sub-headers that are load-bearing for that particular pattern (not a fixed uniform shape). None of the new slugs collide with the existing 16 slugs.

Planning additions (4):

1. `no-regression-ac-framing`
2. `proposal-as-traceability-home`
3. `nullable-predicate-truth-tables`
4. `template-inventory-grep`

Coding additions (6):

5. `injectable-subprocess-runners`
6. `collapsed-branch-negative-tests`
7. `rev-list-direction-comment`
8. `retained-extension-points-need-tests`
9. `top-level-dispatch`
10. `flag-name-keyed-rejection`

And one Coding addition that is a refinement of the existing `regression-test-per-behaviour-change` — see sub-section decision in **§ Approach**:

11. `negative-case-regression-testing` *(placement decided in Approach — either a new sibling entry under `## Coding`, or a sub-section inside `regression-test-per-behaviour-change`)*

Reviewing additions (3):

12. `re-run-reviewer-repro`
13. `cross-merge-round-gap-detection`
14. `post-edit-occurrence-recheck`

**B. Each new entry carries a concrete worked example or recipe.** Abstract principles without a concrete anchor rot — so each entry cites either a file-and-symbol reference (e.g., `src/briefing-lag.ts::RunGit`) or a short distinctive snippet that grounds the pattern in the repo. Line numbers are avoided per the existing `symbol-name-references` principle.

**C. Uniformity-trim pass performed on the existing 16 entries.** The 16 existing entries currently use 3–5 sub-headers apiece. The bundle walks each entry once and either (a) keeps all existing sub-headers when every one is load-bearing, or (b) trims sub-headers whose removal wouldn't lose signal. The result is documented in the PR description as a short per-entry note ("kept as-is" / "trimmed: removed <X>"). No entry is forced to a fixed sub-header count; the audit standard is "does removing this sub-header lose signal?".

**D. Anchor-slug convention preserved.** All new slugs match GitHub's default markdown anchor (lowercase, hyphen-separated, letters/digits only, `##`/`**` stripped). The preamble's existing guidance about slug stability stays unchanged.

**E. Cross-references inside the doc updated where natural.**

- `negative-case-regression-testing` cross-links to `regression-test-per-behaviour-change` (and vice versa if placed as sibling).
- `collapsed-branch-negative-tests` cross-links to `regression-test-per-behaviour-change`.
- `post-edit-occurrence-recheck` cross-links to `exhaustive-occurrence-search` (and vice versa).
- `retained-extension-points-need-tests` cross-links to `regression-test-per-behaviour-change` and `ac-self-check`.
- `flag-name-keyed-rejection` optionally cross-links to `caller-audit-on-signature-change` (both are parser/signature discipline).

No *new* cross-references from external skill templates into the new anchors are in scope — templates already reference the patterns doc by anchor for their existing concerns, and adding new links is follow-up work (see **§ Scope / Out of scope**).

**F. Doc renders correctly on GitHub.** Markdown preview shows all new anchors are reachable via their slugs (quick sanity check: click each `[Planning](#planning)` / `[Coding](#coding)` / `[Reviewing](#reviewing)` TOC link and each new entry's heading produces a stable anchor).

**G. PR description lists the 14 new slugs, their source retrospectives, and a one-line uniformity-trim summary per existing entry.** Traceability lives in the PR body (per the `proposal-as-traceability-home` pattern being added by this bundle itself).

**H. No code changes, no skill-template edits, no proposal-doc edits outside this proposal.** Scope is `docs/orchestration-patterns.md` only (plus this proposal file).

**I. Existing lint and test gates don't regress.** `bun run lint` and `bun test` have the same pass/fail set as the base branch (measured per the no-regression framing this bundle is introducing). Doc-only change is expected to be neutral on both.

## Context

### Target file

`docs/orchestration-patterns.md` in `lukstafi/ludics`. At HEAD the doc has:

- Preamble explaining the patterns / templates relationship and slug convention.
- Three top-level sections: `## Planning`, `## Coding`, `## Reviewing`.
- 16 existing entries across the three sections (verified 2026-04-22; full list in task Tentative Design).
- Stylistic precedent named in the doc itself: `pair-coder-plan-merge.md`'s `## Code-Proposal Alignment Check` section — short, punchy, principle + rule + example.

Existing entry sub-header counts (audited 2026-04-22):

- 3-subheader entries: `wide-table-avoidance`, `scope-declaration-and-salvage`, `assumption-drift`, `symbol-name-references`, `caller-audit-on-signature-change`.
- 4-subheader entries: `data-shape-consumer-sweep`, `regression-test-per-behaviour-change`, `code-proposal-alignment`, `multi-pattern-symbol-extraction`, `round-trip-serialization-fidelity`, `ac-self-check`, `baseline-cross-check-reviewer`.
- 5-subheader entries: `pre-existing-failures-baseline`, `exhaustive-occurrence-search`, `ci-drift-files`, `bail-out-contract`.

The retrospective that kicked off this file (task-21b4c850) implied entries should carry six sub-headers (Principle + Why + Decision rule + Example + When not to apply + Boundary + In-template home) — but none currently do, and the 3–5 range actually in use is the real stylistic precedent. The uniformity trim is therefore lighter than the retrospective framed it: mostly confirming that 5-sub-header entries earn all five.

### Per-pattern source pointers (code references by symbol name, not line number)

Patterns 1–3 (Planning / from task-21b4c850's retrospective):

1. **`no-regression-ac-framing`**: the round-2 amendment in task-21b4c850's PR (base branch `main` already had 611 lint errors before the change; AC 9 needed to be restated as "no regression from base branch"). Retrospective at `retrospectives/task-21b4c850.json`. Recipe: `git stash && <gate> | count-errors` before/after; compare sets, not counts.
2. **`proposal-as-traceability-home`**: arises because coder agents write to the public project repo but not the private harness repo where task files live. Traceability artefacts (grep outputs, scan logs) must land in the proposal's Notes section in the same PR so the reviewer can inspect them. Source: task-21b4c850 feedback item #2.
3. **`negative-case-regression-testing`** (refines `regression-test-per-behaviour-change`): after writing a regression test, run it once with the target behaviour deliberately broken to confirm the test can fail (then revert). task-21b4c850's doc-link slug-resolution test passed round 1 but had two real bugs (phantom `##` anchors in fenced code blocks; `[a-z0-9-]+` silently skipping malformed anchors); both would have been caught by this stress-test.

Patterns 4–8 (Coding / from task-d1932b8f's retrospective — verified in commit history and source):

4. **`injectable-subprocess-runners`**: `RunGit` type in `src/briefing-lag.ts` (`export type RunGit = (args: string[], cwd: string) => RunGitResult`), production shim `defaultRunGit` in the same file. Consumers: `src/staging-ff.ts` threads `RunGit` through `hasRemote`, `worktreeClean`, `currentBranch`, `commitCount`. Tests in `src/briefing-lag.test.ts` define `fakeGit(rules)` (dispatching on `args[0]`/`args[1]`); `src/staging-ff.test.ts` uses the same pattern inline. 19+ unit tests run against synthetic git output with no temp repos.
5. **`nullable-predicate-truth-tables`**: detached-HEAD bug in `src/staging-ff.ts`'s fast-forward flow — `currentBranch()` returns `null` for detached HEAD; the surrounding logic now has explicit `priorBranch` capture + prior-HEAD-SHA capture + restore-detached-HEAD branch. Fix commit: `c31d080 fix(staging-ff,runner): handle detached HEAD; add merged-PR regression test`. Truth-table row: (current-branch ∈ {null, non-null}) × (target-branch match ∈ {true, false}).
6. **`collapsed-branch-negative-tests`**: task-d1932b8f's merge (commit `12e2fca`, PR #331) simplified upstream-workflow branching from three paths to one. Regression tests in `staging-ff.test.ts` use `emitEvent` capture to assert *absence* of stale events — the N+1 rule: N tests for unified handling + 1 negative test that removed branches' artifacts (emits, writes, notifies) are absent. Recipe: grep the pre-change code for every `emit`, `write`, `notify` inside the collapsed branch; each becomes an assertion target.
7. **`rev-list-direction-comment`**: `src/briefing-lag.ts::parseLeftRightCount` parses `git rev-list --left-right --count A...B`; the test-side comment in `src/briefing-lag.test.ts` documenting `upstream/<u>...origin/<o>` → left=behind-upstream, right=ahead-of-upstream is the "future-me" style example. Principle: one-line direction comment at every `rev-list --left-right` call site.
8. **`retained-extension-points-need-tests`**: `resolveTemplatePath(phase, mode, role, hasUpstream?)` in `src/orchestration/skills.ts` — the `hasUpstream` branch checks `pair-<role>-upstream-<phase>.md` then `upstream-<phase>.md`. Synthetic-consumer test in `src/orchestration/skills.test.ts` writes a temp `upstream-update-docs.md` and asserts the override mechanism resolves correctly with `hasUpstream=true` and falls back with `false`. The test is the "format contract the extension point commits to".

Patterns 9–12 (various sections / from task-da8b6dff's retrospective):

9. **`top-level-dispatch`** (Planning): when adding a new mode to a state machine, prefer `if (state.mode === "solo") return evaluateTransitionSolo(state);` at the top over sprinkling `if (solo) …` into each case. task-da8b6dff added solo-mode transitions without touching any pair/duo case body this way.
10. **`template-inventory-grep`** (Planning): before writing N new template variants, `grep -c "reviewer\|peer" pair-coder-<phase>.md` to see if the existing template is already role-agnostic. task-da8b6dff wrote only `solo-work.md` — `pr-create`, `update-docs`, etc. were reviewer-free and fell through naturally. Expected: 1 override per mode, not N.
11. **`re-run-reviewer-repro`** (Reviewing): when the reviewer files a bug at a specific invocation (`parseT3CodeAdapterArgs(<exact args>)`, `curl <exact URL>`), the round-N+1 fix re-runs *that exact invocation*, not just a new unit test. Unit tests test the author's interpretation of the bug; the reviewer's repro tests the contract.
12. **`cross-merge-round-gap-detection`** (Reviewing): task-da8b6dff had four merge iterations (merged-0 → merged-3), each surfacing a real gap (tmux-adapter help text, `docs/ARCHITECTURE.md` enumerations, template fallback order, `runner.ts::isPairBailedOut` second call site). The reviewer's grep anchors (e.g., `rg -n 'mode: "duo" \| "pair"' docs`) became reusable audit tools for the next similar change. Principle: expect merge review to catch real gaps; don't preempt them all.

Pattern 13 (Reviewing / from gh-ludics-335):

13. **`post-edit-occurrence-recheck`**: combines two directions. (a) After migrating occurrences of pattern A to pattern B across N sites, re-run the original `grep A` to confirm only expected residue remains (server endpoints, test guards). (b) Run the inverse `grep B` to audit the new sites for consistency — catches half-migrated sites that picked different escape/helper choices. Worked example: task-c5937037's `task-files/` → `task.html?task=` migration (3 `dashboard.js` patterns + 1 `dashboard.ts` line). The plan should state the *expected* post-edit match set for both directions. Complements existing `exhaustive-occurrence-search` (same principle applied before *and* after the edit, in both directions). Resurrects the inverse-grep half of abandoned `task-779001d7`.

Pattern 14 (Coding / from gh-ludics-337):

14. **`flag-name-keyed-rejection`**: rejection must be keyed on *which flag was provided* (track the flag name as a string when seen), not on whether the resulting variable is set after parsing. Shared flags (`--effort`) and role-specific flags (`--reviewer-effort`) assign the same underlying variable, so variable-state inference silently drops the role-specific flag. Worked pattern: `reviewerOnlyFlag: string | null` in `parseT3CodeAdapterArgs` (`~/ludics/src/adapters/t3code.ts`) — set on first role-specific flag seen, checked at mode-gate with a specific error naming the offending flag.

### Cross-reference consumers (read-only — not edited by this bundle)

These files currently link into `orchestration-patterns.md` by anchor. They are not modified by this bundle (out of scope); listed for awareness in case any existing anchor changes during the uniformity-trim pass. None should — the trim is sub-header-level, not heading-level.

- `skills/orchestration/pair-coder-plan.md` (3 anchors).
- `skills/orchestration/pair-coder-work.md` (4 anchors).
- `skills/orchestration/pair-reviewer-plan-review.md` (3 anchors).
- `skills/orchestration/pair-reviewer-review.md` (4 anchors).
- `docs/proposals/orchestration-template-principles-refactor.md` (historical).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Step 1 — Draft the 14 new entries in a worktree

Start a worktree on `main`. For each of the 14 patterns, write the entry against the target section, consulting the source retrospective for the worked example / recipe. Guidance:

- **Sub-header budget**: 2–4 sub-headers per entry, picked for the specific pattern. Sketches (proposal-phase suggestions — coder may adjust):
  - Recipe-style entries (`no-regression-ac-framing`, `rev-list-direction-comment`, `post-edit-occurrence-recheck`): **Principle** + **Why** + **Recipe**.
  - Decision-rule entries (`nullable-predicate-truth-tables`, `re-run-reviewer-repro`, `flag-name-keyed-rejection`): **Principle** + **Why** + **Example** (or **Worked pattern**).
  - Technique entries (`injectable-subprocess-runners`, `top-level-dispatch`, `collapsed-branch-negative-tests`): **Principle** + **Why** + **Worked example** + **When not to apply**.
  - Narrow/concrete entries (`template-inventory-grep`): **Principle** + **Example** — 2 sub-headers is fine.
- **Tone**: match existing entries. Each entry is agent-facing reference; keep prose tight.
- **Examples**: prefer linking to symbols (`src/briefing-lag.ts::RunGit`) over quoting long code blocks. Short distinctive snippets are welcome; full function bodies are not.

### Step 2 — Decide `negative-case-regression-testing` placement

Two options; proposal leaves it to the coder after drafting the content:

- **Option A (new sibling entry)** — add `### Negative-case regression testing` under `## Coding`, cross-link to `regression-test-per-behaviour-change`. Clearer anchor for templates to link at later.
- **Option B (sub-section of existing entry)** — add a `**Negative-case stress-test.**` paragraph inside `regression-test-per-behaviour-change`. Keeps the two halves co-located but GitHub anchors to bold-text sub-headings aren't stable, so external cross-linking is harder.

Coder picks whichever reads better after both entries are drafted. Acceptance Criterion A counts 14 total new *anchors*; if Option B is chosen, the total is 13 new anchors + 1 sub-section (still acceptable, so long as the content is covered).

### Step 3 — Uniformity-trim audit of the 16 existing entries

Walk each existing entry once. For every sub-header, ask: *would removing this sub-header lose signal agents would use?* If no, trim it. Keep a one-line note per entry for the PR description. Guidance:

- The 5-sub-header entries (`pre-existing-failures-baseline`, `exhaustive-occurrence-search`, `ci-drift-files`, `bail-out-contract`) are the most likely candidates for trimming; sanity-check each.
- 4-sub-header entries: usually fine; check that the 4th sub-header (often "Boundary" or "When not to apply") actually distinguishes from the main principle.
- 3-sub-header entries: likely no change.
- Entries marked with "In-template home" sub-headers (`symbol-name-references`, `code-proposal-alignment`, `baseline-cross-check-reviewer`): keep those — the cross-ref is load-bearing for the reader.

The audit is *subjective* by design. The PR description enumerates what was trimmed and why; the reviewer either agrees or REQUEST_CHANGES specific sub-headers back.

### Step 4 — Slug-collision sanity check

Before committing, run a grep against the final doc for each of the 14 new slugs to confirm each appears exactly once as a heading and no existing slug was accidentally renamed by the uniformity-trim pass.

```sh
for slug in no-regression-ac-framing proposal-as-traceability-home \
            negative-case-regression-testing injectable-subprocess-runners \
            collapsed-branch-negative-tests rev-list-direction-comment \
            retained-extension-points-need-tests top-level-dispatch \
            flag-name-keyed-rejection nullable-predicate-truth-tables \
            template-inventory-grep re-run-reviewer-repro \
            cross-merge-round-gap-detection post-edit-occurrence-recheck; do
  matches=$(grep -c "^### .*$(echo $slug | tr '-' ' ')" docs/orchestration-patterns.md || true)
  echo "$slug: $matches"
done
```

(The command is illustrative — exact regex depends on how the heading text maps to the slug. The principle is *verify each new anchor resolves*.)

### Step 5 — PR description

The PR description must list:

1. Each new entry's slug + source retrospective + one-line summary.
2. Per-existing-entry uniformity-trim note.
3. A link to this proposal.
4. Closes: `lukstafi/ludics#335` and `lukstafi/ludics#337`.

This is the `proposal-as-traceability-home` pattern in action: the PR body carries the provenance so the reviewer can inspect it.

## Scope

### In scope

- `docs/orchestration-patterns.md` — 14 new entries + uniformity-trim audit.
- PR description with per-entry provenance + uniformity-trim notes.
- Closing GitHub issues 335 and 337 via PR commit message.

### Out of scope

- **Skill-template edits.** Per user's reference-layer-not-inline principle (2026-04-23): patterns doc is *optional reading* for authors/agents; no inlining into skill templates in this scope. Existing template cross-references stay as-is. New template cross-references into the 14 new anchors are a follow-up — gh-ludics-334, gh-ludics-338, gh-ludics-339 were abandoned as subsumed by this very principle.
- **Code changes.** The patterns doc is the only file edited in scope. Notably, the preventive-comment side of task-8f5a78a1 (add a comment near `reviewerOnlyFlag` pointing at the new `flag-name-keyed-rejection` anchor) is handled *separately* on that task, not here — even though the anchor this bundle creates is the target of that comment.
- **`docs/testing-patterns.md` changes.** Sibling doc covers bun test patterns, not orchestration.
- **New proposal documents** beyond this one.
- **Resurrected patterns from abandoned `task-779001d7`**: only the inverse-grep direction makes it in (via `post-edit-occurrence-recheck` above). The other two (`interpolation-context-then-escape`, URL round-trip behavioural tests) remain abandoned.
- **Shared `parseFlag(name, modeAccepts)` helper** (gh-ludics-337 action 3): premature; single consumer; not pursued.

### Dependencies

- **No blocking dependencies on other tasks.**
- **Relates to** `task-8f5a78a1` (pre-existing task): that task's Option B (preventive comment on `reviewerOnlyFlag`) should land *after* this bundle so it can cite the new `flag-name-keyed-rejection` anchor. Coordination happens on `task-8f5a78a1`, not here.
- **Closes on merge**: GitHub issues `lukstafi/ludics#335` and `lukstafi/ludics#337`.
