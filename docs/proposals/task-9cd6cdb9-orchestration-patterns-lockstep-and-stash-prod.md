# Lint-elevation hygiene: lockstep contract-prose rewrite + stash-prod mutation test

## Goal

Land two tactical workflow patterns from the `task-78cbb135` retrospective (PR #473, lint:cli-readme fail-on-undocumented) into the harness's two reference-layer docs, each in the family that natively fits its concern. Doc-only; no code changes to ludics.

- **Pattern 1 — lockstep contract-prose rewrite.** Append one new sub-pattern to `docs/orchestration-patterns.md` under `## Coding`, **adjacent to (immediately after) `### CI drift files`**. Concerns "when the change modifies what a file does, edit its in-file self-description in the same commit." Per the user's 2026-05-02 resolution (Option B), the entry is a *rule + one-sentence anchor* shape — no `Worked example` subheader, no `Principle/Why/When` block.
- **Pattern 2 — stash-prod mutation test.** Append one new `### ` clause to `docs/ac-rigor-reference.md` under `## Vacuous-harness family`, as a **sibling of `### Vacuous test harness — assert on the artifact the AC names`** (Option B per user 2026-05-02 resolution). Concerns "ensure your new test actually falsifies under regression." The clause cross-links back to `### No-regression framing when the gate baseline is red` in the **Baseline-aware framing family** — same toolset (`git stash`), distinct probe (stash-and-rerun = "is this failure pre-existing?"; stash-prod = "does my new test exercise my new code?").
- **Pointer update.** `skills/worker-conventions.md` § "AC verification rigor" — append the new clause title to the **Vacuous-harness family** bullet (the existing three-bullet family-grouped pointer).

Refs: `task-78cbb135` (the source retrospective, PR #473), `task-d6656cf3` (round-2 expansion of `ac-rigor-reference.md`, merged via PR #474, established the family-grouped `worker-conventions.md` pointer shape), `task-01647adf` (Time-since-X clause, established the no-touch-to-`worker-conventions.md` precedent for Falsifier-shape additions — *broken* by this task because the user resolution explicitly asks for the pointer update), `task-96d69bf9` (sibling AC-rigor task that lands the "X unchanged" clause one slot ahead of this one and bumps the preamble count from `fourteen` to `fifteen` — this task bumps it from `fifteen` to `sixteen` and prunes `stash-prod mutation tests` from the preamble's future-anticipated parenthetical because it's no longer future-anticipated).

## Acceptance Criteria

The verifier checks every AC below by literal-string `grep -F` or `grep -cE` against the post-commit tree. Cite `git diff main...HEAD -- <paths>` (symmetric, stable across rebases) or line-numbered direct reads of the post-commit source — not bare `git diff`.

### AC1 — Pattern 1 heading is present in `docs/orchestration-patterns.md`

After the change, `grep -F` against the new H3 literal returns at least one match in `docs/orchestration-patterns.md`:

- `### Lockstep contract-prose rewrite`

**Falsifier (presence):** `grep -F "### Lockstep contract-prose rewrite" docs/orchestration-patterns.md` returns no match.

### AC2 — Pattern 1 placement: under `## Coding`, immediately after `### CI drift files`

The new H3 (`### Lockstep contract-prose rewrite`) is positioned under `## Coding`, immediately following the existing `### CI drift files` subsection and before `### Multi-pattern symbol extraction`.

**Falsifier (relative-position):** Run `grep -nE '^(##|###) ' docs/orchestration-patterns.md`. The line number of `### Lockstep contract-prose rewrite` must satisfy:

- Strictly greater than the line of `## Coding`.
- Strictly greater than the line of `### CI drift files`.
- Strictly less than the line of `### Multi-pattern symbol extraction`.

If any of the three relative-position checks fails, the AC is falsified. (The "immediately after `### CI drift files`" constraint is enforced by the pair of CI-drift-files-less-than and Multi-pattern-symbol-extraction-greater-than bounds with no other `### ` heading between them — verified by checking the line-number sequence has no third H3 in the gap.)

### AC3 — Pattern 1 voice: rule + one-sentence anchor, no `Principle`/`Why`/`Worked example` subheaders

The new entry follows the user's resolved Option B shape: a one-sentence rule body, plus a parenthetical or follow-on sentence anchoring with the concrete `scripts/lint-cli-readme.ts` trigger from PR #473. **No** `**Principle.**`, `**Why.**`, `**When not to apply.**`, or `**Worked example.**` bold-prefixed subheaders appear within the new entry's body (between the new `### ` heading and the next `### `/`## ` heading). Body length: 3–5 sentences inclusive (matching the retrospective body's "pithy form" target).

**Falsifier (no subheaders):** `awk '/^### Lockstep contract-prose rewrite/,/^(### |## )/' docs/orchestration-patterns.md | grep -E '^\*\*(Principle|Why|When not to apply|Worked example)\.\*\*'` returns any match.

**Falsifier (concrete-trigger anchor present):** `awk '/^### Lockstep contract-prose rewrite/,/^(### |## )/' docs/orchestration-patterns.md | grep -F "lint-cli-readme"` returns no match. (The retrospective's concrete trigger — `scripts/lint-cli-readme.ts` — must appear in the entry as a parenthetical anchor.)

### AC4 — Pattern 1 body content: language-agnostic rule, naming the failure mode

The new entry's body covers all of:

1. **The rule.** When a file documents its own contract — a header docstring, top-of-file comment block, leading prose section, or any other in-file description of what the file does — and the change modifies what the file actually does, edit the prose in the same commit.
2. **The "code-shaped artifact" framing.** The prose is a code-shaped artifact, not commentary; future readers and grep audits use it as the source-of-truth claim, so silent drift is the failure mode.
3. **Concrete trigger anchor.** A parenthetical citing `scripts/lint-cli-readme.ts` (PR #473): the header advertised "warnings about undocumented commands are non-fatal" while the round-1 fix flipped the exit-code branch but left the header intact — a self-contradicting file.
4. **Distinction from `### CI drift files`.** The rule must read as covering drift between *the file's prose and the file's behaviour* (un-lint-enforced; same file), not drift between *lint-paired files* (machine-enforced; pair of files). The neighbour entry already encodes the latter; this entry generalises the lockstep idea to the in-file case.

**Falsifier (per-element literal presence):** `grep -F` for any of the literal phrases below against the new entry's body returns no match (run via `awk '/^### Lockstep contract-prose rewrite/,/^(### |## )/' docs/orchestration-patterns.md | grep -F "<phrase>"`):

- `code-shaped artifact` — the load-bearing framing line (the rule that future readers and grep audits *use the prose as source-of-truth* is what makes silent drift the failure mode).
- `lint-cli-readme` — the concrete trigger anchor.
- One of `header docstring`, `top-of-file`, or `in-file` — the language-agnostic framing of "the file's self-description."

### AC5 — Pattern 2 heading is present in `docs/ac-rigor-reference.md`

After the change, `grep -F` against the new H3 literal returns at least one match in `docs/ac-rigor-reference.md`:

- `### Stash-prod mutation test — confirm your new test actually falsifies`

**Falsifier (presence):** `grep -F "### Stash-prod mutation test — confirm your new test actually falsifies" docs/ac-rigor-reference.md` returns no match.

### AC6 — Pattern 2 placement: under Vacuous-harness family, sibling of "Vacuous test harness — assert on the artifact the AC names"

The new clause is inserted under `## Vacuous-harness family`, immediately after the existing `### Vacuous test harness — assert on the artifact the AC names` and before the existing `### Vacuous doc/config harness — same rule, doc artifacts`. Reading order in that family becomes: Vacuous test harness → Stash-prod mutation test → Vacuous doc/config harness → Probe before cleanup.

**Falsifier (relative-position):** Run `grep -nE '^(##|###) ' docs/ac-rigor-reference.md`. The line number of `### Stash-prod mutation test — confirm your new test actually falsifies` must satisfy:

- Strictly greater than the line of `### Vacuous test harness — assert on the artifact the AC names`.
- Strictly less than the line of `### Vacuous doc/config harness — same rule, doc artifacts`.
- Strictly less than the line of `## Proposal-as-canonical family`.

If any of the relative-position checks fails, the AC is falsified.

### AC7 — Pattern 2 body content: rule, command shape, distinction-from-stash-and-rerun, mutation-testable shape

The new clause body (prose between the new H3 and the next `### ` or `## ` heading) covers all of:

1. **The rule.** A test that traverses but doesn't enforce — i.e., a vacuous test on its production change — passes whether or not the production fix is present. Mutation-test the new regression test by stashing the production change.
2. **The command shape.** `git stash push -- <production-file>` reverts only the lint/bug fix while leaving the new test in place; the test runner (`bun test`, `pytest`, whatever) then surfaces the assertion that fires under regression. `git stash pop` restores in one step.
3. **Why this beats alternatives.** Cheaper and less error-prone than editing the test fixture or temporarily breaking the production code in-place — and robust to multi-file stash sets when scoped via the path argument.
4. **The cross-link / distinction.** `git stash` is also the toolset for the **No-regression framing when the gate baseline is red** clause (Baseline-aware framing family). Same toolset, distinct probe: **stash-and-rerun** answers *"is this failure pre-existing in main?"*; **stash-prod** answers *"does my new test actually exercise my new code?"*. The clause must explicitly cite the cross-link so a reader landing on either clause finds the other.
5. **Mutation-testable shape (self-application).** The clause body itself names a concrete falsifier — the literal `git stash push -- ` command form — so that a verification probe can assert the clause is non-stub. This is the kind of mutation-testable assertion the clause prescribes.

The body is between 4 and 7 sentences inclusive (matching the doc's existing template; the Time-since-X sibling clause is 5 sentences, the X-unchanged sibling clause is 4–7).

**Falsifier (per-element literal presence):** `grep -F` for any of the literal phrases below against `docs/ac-rigor-reference.md` returns no match (a probe on the new clause body via `awk '/^### Stash-prod mutation test/,/^(### |## )/' docs/ac-rigor-reference.md | grep -F "<phrase>"`):

- `git stash push --` — the literal command form (must match exactly, including the trailing space-and-double-dash; this is the mutation-testable falsifier the clause exemplifies).
- `git stash pop` — the restoration step (one-line restore is part of the technique).
- `stash-and-rerun` or `No-regression framing` — the cross-link target name (either alternative satisfies; the canonical heading the cross-link points at is `### No-regression framing when the gate baseline is red`).
- `pre-existing` — the stash-and-rerun probe's question framing ("is this failure pre-existing in main?"). The distinction-from-sibling-clause sentence must include this word.
- One of `exercise my new code`, `exercises my new code`, or `actually falsifies` — the stash-prod probe's question framing.

### AC8 — Pattern 2 cross-link reciprocity: cited heading exists, exact form

The new clause's cross-link references the existing heading `### No-regression framing when the gate baseline is red` (Baseline-aware framing family) by its exact title text. The cross-link form is either a markdown anchor (`[…](#no-regression-framing-when-the-gate-baseline-is-red)`) or an unambiguous prose reference that includes the literal phrase **`No-regression framing when the gate baseline is red`** as a substring of the cross-link sentence.

**Falsifier (exact title literal present):** `awk '/^### Stash-prod mutation test/,/^(### |## )/' docs/ac-rigor-reference.md | grep -F "No-regression framing when the gate baseline is red"` returns no match.

**Falsifier (heading still exists, unmodified):** `grep -F "### No-regression framing when the gate baseline is red" docs/ac-rigor-reference.md` returns no match. (The cited heading must survive this commit — no rename, no relocation.)

### AC9 — Clause cardinality is exactly 16

After the change, `grep -cE '^### ' docs/ac-rigor-reference.md` returns the integer `16`.

**Falsifier (count):** `grep -cE '^### ' docs/ac-rigor-reference.md` returns any value other than `16`.

### AC10 — Preamble count update: "fifteen clauses" replaced by "sixteen clauses"; stash-prod pruned from parenthetical

The preamble (`docs/ac-rigor-reference.md` line 5, post-task-96d69bf9) currently reads (when the predecessor sibling task lands):

> Today it covers fifteen clauses across five thematic families; further reviewer-flagged learnings (closed-set / cardinality probes, stash-prod mutation tests, and others) are expected to land as additional `### ` subsections under the same families or new sibling families.

After this change:

- The literal `fifteen clauses` is replaced by `sixteen clauses`. The literal must change, not be left alongside the new one.
- The literal `stash-prod mutation tests` is removed from the parenthetical's future-anticipated list — this task lands that clause, so it is no longer future-anticipated. The parenthetical retains `closed-set / cardinality probes` and the `and others` tail.

**Falsifier (count present):** `grep -F "sixteen clauses" docs/ac-rigor-reference.md` returns no match.

**Falsifier (count absent):** `grep -F "fifteen clauses" docs/ac-rigor-reference.md` still returns a match. (The literal `fifteen` must be replaced, not left alongside.)

**Falsifier (parenthetical pruned):** `grep -F "stash-prod mutation tests" docs/ac-rigor-reference.md` returns any match in the preamble. (The phrase may legitimately survive elsewhere — e.g., as a substring inside the new clause body if the wording calls back to it — but it must not remain in the preamble's future-anticipated parenthetical at line ~5.)

**Recovery if the predecessor lands first as expected:** the implementer reads the live preamble at `docs/ac-rigor-reference.md:5` before editing. If the predecessor (`task-96d69bf9`) has not yet landed at implementation time, the count edit becomes `fourteen` → `sixteen` directly, and the parenthetical-pruning edit still applies; the AC's count-of-16 invariant is what matters, not the intermediate "fifteen" snapshot.

### AC11 — `worker-conventions.md` pointer update: Vacuous-harness family bullet includes the new clause title

In `skills/worker-conventions.md`, § "AC verification rigor" (currently the three-bullet family-grouped pointer with bullets `Vacuous-harness family:`, `Falsifier-shape family:`, `Process-around-the-AC:`), the **Vacuous-harness family** bullet is amended to include the literal title of the new clause. After the change, the bullet's title list contains all four titles, in the order they appear in the doc:

1. `Vacuous test harness — assert on the artifact the AC names`
2. `Stash-prod mutation test — confirm your new test actually falsifies`
3. `Vacuous doc/config harness — same rule, doc artifacts`
4. `Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'`

**Falsifier (title present in pointer):** `grep -F "Stash-prod mutation test — confirm your new test actually falsifies" skills/worker-conventions.md` returns no match.

**Falsifier (Vacuous-harness bullet preserved, not duplicated):** `grep -cE '^- Vacuous-harness family:' skills/worker-conventions.md` returns any value other than `1`. (Exactly one Vacuous-harness family bullet exists in the pointer.)

**Falsifier (other bullets unchanged):** Either `grep -F "Falsifier-shape family:" skills/worker-conventions.md` or `grep -F "Process-around-the-AC:" skills/worker-conventions.md` returns no match. (The other two family bullets must survive verbatim — this task does not touch them.)

### AC12 — Touched files: exactly three doc paths plus the proposal

`git diff --name-only main...HEAD` returns exactly the paths:

- `docs/orchestration-patterns.md` (Pattern 1).
- `docs/ac-rigor-reference.md` (Pattern 2 + preamble).
- `skills/worker-conventions.md` (pointer update).
- `docs/proposals/task-9cd6cdb9-orchestration-patterns-lockstep-and-stash-prod.md` (this proposal, already committed by the orchestrator's worker step).

No source-code files (`src/**`, `scripts/**`, `templates/**`), no tests (`*.test.ts`), no schema files.

**Falsifier:** `git diff --name-only main...HEAD` returns any path outside the four-path set above, or any of the four paths is missing from the diff at completion.

## Context

### Reference doc structure as merged on `origin/main`

From `git show origin/main:docs/ac-rigor-reference.md` (verified 2026-05-03):

- Preamble (line 5): `"fourteen clauses across five thematic families"` with future-anticipated parenthetical `"(closed-set / cardinality probes, stash-prod mutation tests, and others)"`.
- 14 `### ` clauses across 5 `## ` families:
  - `## Vacuous-harness family` — three clauses: Vacuous test harness; Vacuous doc/config harness; Probe before cleanup.
  - `## Proposal-as-canonical family` — two clauses: Proposal beats task file; Self-contradicting AC literal probe.
  - `## Falsifier-shape family` — six clauses: Literal-grep AC; Per-element assertions; Byte-pinned assertions; Prose-only template; Time-since-X; Literal paths in ACs.
  - `## Verification-evidence family` — two clauses: AC verification evidence must survive the commit boundary; Diff-enumerated verification lines go stale.
  - `## Baseline-aware framing family` — one clause: No-regression framing when the gate baseline is red.

Sibling task `task-96d69bf9` (proposal at `docs/proposals/task-96d69bf9-ac-rigor-x-unchanged-structural-snapshot.md`, commit `d9c6120`) is queued ahead of this task. When it lands, the preamble bumps to `fifteen clauses` and Falsifier-shape grows to seven clauses (X-unchanged inserted between Time-since-X and Literal paths in ACs). This task lands afterward and bumps to `sixteen clauses`.

### orchestration-patterns.md structure (relevant slice)

`docs/orchestration-patterns.md` § `## Coding` (line 258) opens with `### CI drift files` (line 260), followed by `### Multi-pattern symbol extraction`, `### Round-trip serialization fidelity`, etc. The `### CI drift files` entry already encodes "edit two files in lockstep" but for *machine-enforced* drift pairs (`src/config.ts` ↔ `templates/config.reference.yaml`; `src/index.ts` USAGE ↔ README CLI Reference). Pattern 1 generalises the lockstep idea to the **un-lint-enforced** case where the prose is in the *same* file as the change. The two patterns sit naturally adjacent because they share the lockstep theme; readers grep-finding the new entry alongside `### CI drift files` see the two flavours together.

The dominant voice in § Coding uses `**Principle.**` / `**Why.**` / `**When not to apply.**` / `**Worked example.**` bold-prefixed subheaders (see `### CI drift files`, `### Multi-pattern symbol extraction`, `### Round-trip serialization fidelity`). The user explicitly resolved Pattern 1 to break with this convention (Option B): a tighter rule + one-sentence anchor shape, no subheaders. The brevity tradeoff is worth it for a pattern whose generic statement is the load-bearing content; a worked-example block would re-anchor in TS/JSDoc terms when the rule is supposed to read as language-agnostic.

### ac-rigor-reference.md structure (relevant slice)

`## Vacuous-harness family` (line 13) opens with a family preamble (line 15): *"The shared rule: an AC verification line is vacuous when the only edit needed to falsify it is the assertion sentence itself. The harness condition must be paired with a probe that reads the artifact the AC names — whether that artifact is a journal file, a rendered string, or a doc heading."* The three existing clauses sit under this preamble:

1. **Vacuous test harness — assert on the artifact the AC names** (line 17): the foundational clause for test-shape ACs.
2. **Vacuous doc/config harness — same rule, doc artifacts** (line 21): generalises to doc/config artefacts.
3. **Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'** (line 25): generalises to runtime-cleanup state.

Pattern 2 fits as a sibling of the *first* clause: stash-prod is the *probe* that detects vacuous tests on the production change (i.e., your test traverses the production code path but doesn't actually assert against the new behaviour, so removing the production fix doesn't surface a failing test). The user-resolved Option B places it immediately after **Vacuous test harness**, so the family's reading order becomes: Vacuous test harness (the shape-of-vacuity rule) → Stash-prod mutation test (the *probe* that detects vacuity) → Vacuous doc/config harness (extension to doc artefacts) → Probe before cleanup (extension to runtime artefacts).

### Cross-link to Baseline-aware framing family

`## Baseline-aware framing family` § `### No-regression framing when the gate baseline is red` (line 85) already cites the canonical command form `git stash && bun test <file> && git stash pop` for its **stash-and-rerun** technique — the probe for "*is this failure pre-existing in main?*". Pattern 2's stash-prod technique uses the *same toolset* (`git stash`) for a *distinct probe* — "*does my new test exercise my new code?*". The cross-link from Pattern 2 to the No-regression-framing clause makes the same-toolset / distinct-probe distinction visible at both reading entry points: a reviewer landing on the Vacuous-harness family clause sees the cross-link; a reviewer landing on the Baseline-aware framing family clause does not currently see a back-link, but does not need one — the clause body retains its own internal framing.

### worker-conventions.md pointer (current shape on `origin/main`)

`skills/worker-conventions.md` § "AC verification rigor" (lines 44–49) is a three-bullet family-grouped pointer:

- `Vacuous-harness family:` Vacuous test harness; Vacuous doc/config harness; Probe before cleanup.
- `Falsifier-shape family:` Literal-grep AC; Per-element assertions; Byte-pinned assertions; Prose-only template; Literal paths in ACs.
- `Process-around-the-AC:` Proposal beats task file; Self-contradicting AC literal probe; AC verification evidence must survive the commit boundary; Diff-enumerated verification lines go stale; No-regression framing.

(Note: the on-main pointer hasn't yet been updated for `Time-since-X ACs need two boundary fixtures` or `'X unchanged' ACs need structural snapshot, not single-field check` — the `task-01647adf` precedent established that Falsifier-shape additions don't update `worker-conventions.md`. This task explicitly *does* update it for the Vacuous-harness addition, per the user's 2026-05-02 resolution.)

The new clause title appends to the `Vacuous-harness family:` bullet. Family-internal ordering matches doc-internal ordering: the new title is inserted between `Vacuous test harness — assert on the artifact the AC names` and `Vacuous doc/config harness — same rule, doc artifacts`.

### Concrete trigger for Pattern 1

`scripts/lint-cli-readme.ts` (PR #473 / `task-78cbb135`) — header docstring on lines 8–11 advertised "warnings about undocumented commands are non-fatal"; the round-1 fix flipped the exit-code branch but left the header intact, producing a self-contradicting file. The retrospective body cites this as the failure mode the pattern names. Cite as a parenthetical anchor; do not anchor the rule body in TS/JSDoc-specific terms — the rule generalises across languages (Python `"""docstring"""`, OCaml `(** *)`, Rust `//!`, Go `// Package`, shell `# About:` headers, top-of-file README `<!-- about -->` regions, leading-`description` field in YAML/TOML config files describing the artifact).

### Predecessor proposal as template

`docs/proposals/task-96d69bf9-ac-rigor-x-unchanged-structural-snapshot.md` is the immediate template for shape, AC style, and verification probe. It uses:

- Per-AC literal `grep -F` / `grep -cE` falsifiers.
- Per-clause line-number invariants for placement (`grep -nE '^(##|###) '` then numerical strict-inequality checks).
- A clause-cardinality probe paired with per-clause presence loop (the cardinality probe is the count, the presence loop is per-element literal grep).
- Post-commit-evidence framing (`git diff main...HEAD -- <paths>`, not bare `git diff`).

This proposal mirrors that style. It also adds the **mutation-testable clause body** invariant (AC7's "stash-prod is itself a mutation-testable assertion") that the retrospective body explicitly asks for: Pattern 2's clause body should itself be the kind of mutation-testable assertion it describes — the verification probe greps for the literal `git stash push --` command form, so a stub clause body without that literal fails the AC.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The work is doc-only with three touched files. A natural single-commit shape:

1. **Pattern 1 → `docs/orchestration-patterns.md`.** Insert a new `### Lockstep contract-prose rewrite` subsection under `## Coding`, immediately after `### CI drift files` and before `### Multi-pattern symbol extraction`. Body: 3–5 sentences. The rule sentence states the lockstep principle (file documents its own contract → edit prose in same commit). The framing sentence names the failure mode (prose is a code-shaped artifact, not commentary; future readers and grep audits use it as the source-of-truth claim, so silent drift is the failure mode). The anchor sentence cites the concrete trigger as a parenthetical (`scripts/lint-cli-readme.ts` from PR #473 — header advertised "warnings about undocumented commands are non-fatal" while the round-1 fix flipped the exit-code branch but left the header intact). One closing sentence may distinguish the rule from the neighbouring `### CI drift files` (un-lint-enforced same-file vs lint-enforced paired-file). **No** `**Principle.**`/`**Why.**`/`**Worked example.**` bold-prefixed subheaders; the entry breaks with the dominant § Coding voice per the user's Option B resolution.

2. **Pattern 2 → `docs/ac-rigor-reference.md`.** Insert a new `### Stash-prod mutation test — confirm your new test actually falsifies` clause under `## Vacuous-harness family`, immediately after `### Vacuous test harness — assert on the artifact the AC names` and before `### Vacuous doc/config harness — same rule, doc artifacts`. Body: 4–7 sentences. Cover the rule (mutation-test the new regression test), the command shape (`git stash push -- <production-file>` → run test → `git stash pop`), the cross-link to **No-regression framing when the gate baseline is red** with the same-toolset-distinct-probe distinction (stash-and-rerun = "is this failure pre-existing?"; stash-prod = "does my new test exercise my new code?"). The clause's literal `git stash push --` command form is the mutation-testable falsifier the AC tests for.

3. **Preamble update in `docs/ac-rigor-reference.md`.** At the line currently containing `"fifteen clauses across five thematic families"` (post-`task-96d69bf9` landing) — or `"fourteen clauses"` if the predecessor hasn't landed yet — replace the count word with `sixteen`. Remove the literal `stash-prod mutation tests` from the future-anticipated parenthetical (`(closed-set / cardinality probes, stash-prod mutation tests, and others)`); the parenthetical retains `closed-set / cardinality probes` and the `and others` tail. Read the live file before editing — the predecessor's exact wording is what the edit operates on.

4. **`worker-conventions.md` pointer update.** In `skills/worker-conventions.md` § "AC verification rigor" (lines ~44–49), append the new clause title `Stash-prod mutation test — confirm your new test actually falsifies` to the `Vacuous-harness family:` bullet, in the order that matches doc-internal ordering (between `Vacuous test harness — assert on the artifact the AC names` and `Vacuous doc/config harness — same rule, doc artifacts`). Do not touch the `Falsifier-shape family:` or `Process-around-the-AC:` bullets.

5. **Verify before committing:**
   - `grep -cE '^### ' docs/ac-rigor-reference.md` → `16`.
   - `grep -F "### Lockstep contract-prose rewrite" docs/orchestration-patterns.md` → match.
   - `grep -F "### Stash-prod mutation test — confirm your new test actually falsifies" docs/ac-rigor-reference.md` → match.
   - `grep -F "sixteen clauses" docs/ac-rigor-reference.md` → match; `grep -F "fifteen clauses" docs/ac-rigor-reference.md` → no match; `grep -F "fourteen clauses" docs/ac-rigor-reference.md` → no match.
   - The literal `stash-prod mutation tests` does not appear in the preamble parenthetical (line ~5 of `docs/ac-rigor-reference.md`).
   - Per-element literal phrases from AC4 each return at least one match in the new Pattern 1 entry body.
   - Per-element literal phrases from AC7 each return at least one match in the new Pattern 2 clause body. In particular, `grep -F "git stash push --" docs/ac-rigor-reference.md` returns at least one match.
   - The cross-link target heading still exists: `grep -F "### No-regression framing when the gate baseline is red" docs/ac-rigor-reference.md` → match.
   - `grep -F "Stash-prod mutation test — confirm your new test actually falsifies" skills/worker-conventions.md` → match.
   - `git diff --name-only main...HEAD` → exactly the four paths from AC12.

6. **Commit message style** follows the Time-since-X / X-unchanged precedents:

   > `docs: add lockstep-contract-prose rewrite + stash-prod mutation-test clauses`
   >
   > Two tactical workflow patterns from task-78cbb135 retrospective land in
   > the two reference-layer docs. Pattern 1 (Lockstep contract-prose
   > rewrite) under orchestration-patterns § Coding adjacent to CI drift
   > files — covers in-file prose-vs-behaviour drift, complementary to the
   > lint-enforced paired-file flavour. Pattern 2 (Stash-prod mutation test)
   > under ac-rigor-reference § Vacuous-harness family adjacent to the
   > foundational vacuous-test-harness clause — same toolset (git stash) as
   > the No-regression-framing baseline-aware-framing clause but a distinct
   > probe (stash-prod = "does my new test exercise my new code?", not "is
   > this failure pre-existing?"). Bumps the AC-rigor preamble's clause count
   > from fifteen to sixteen and prunes "stash-prod mutation tests" from the
   > future-anticipated parenthetical (it just landed). worker-conventions.md
   > § AC verification rigor pointer's Vacuous-harness bullet picks up the
   > new clause title.
   >
   > Refs: task-9cd6cdb9 (from task-78cbb135 round-1 retrospective, PR #473)

   Use `git diff main...HEAD -- docs/ac-rigor-reference.md docs/orchestration-patterns.md skills/worker-conventions.md` (post-commit, symmetric) for verification evidence — not bare `git diff`.

This proposal is itself an AC-rigor exercise: the ACs above use literal `grep -F` / `grep -cE` falsifiers, per-element decomposition (AC4, AC7), per-line-number relative-position invariants (AC2, AC6), post-commit-evidence framing (AC12), and the mutation-testable-clause-body shape (AC7's `git stash push --` literal-grep falsifier — the clause body itself is a mutation-testable assertion in the sense the clause prescribes).

## Scope

**In scope:**

- Append `### Lockstep contract-prose rewrite` subsection to `docs/orchestration-patterns.md` under `## Coding`, immediately after `### CI drift files`. Voice: rule + one-sentence anchor (Option B), no `Principle/Why/Worked example` subheaders.
- Append `### Stash-prod mutation test — confirm your new test actually falsifies` clause to `docs/ac-rigor-reference.md` under `## Vacuous-harness family`, sibling of `### Vacuous test harness — assert on the artifact the AC names` (Option B).
- Cross-link Pattern 2's clause body to `### No-regression framing when the gate baseline is red` (Baseline-aware framing family) with the same-toolset-distinct-probe distinction.
- Update the `docs/ac-rigor-reference.md` preamble: clause count from `fifteen` (post-predecessor) or `fourteen` (if predecessor lands after this task) → `sixteen`; prune `stash-prod mutation tests` from the future-anticipated parenthetical.
- Update `skills/worker-conventions.md` § "AC verification rigor" Vacuous-harness family bullet to include the new clause title.

**Out of scope:**

- Updating the `Falsifier-shape family` or `Process-around-the-AC` bullets in `skills/worker-conventions.md` (e.g., adding `Time-since-X ACs need two boundary fixtures` or `'X unchanged' ACs need structural snapshot` to the Falsifier-shape bullet — those are separate maintenance items per the `task-01647adf` precedent).
- Restructuring family sections, renaming existing clauses, or reflowing the preamble's `"five thematic families"` wording (still accurate after this round).
- Adding back-links from `### No-regression framing when the gate baseline is red` to the new clause (one-way cross-link from Pattern 2 to No-regression-framing is sufficient; symmetric back-linking is a separate maintenance item).
- Clauses for closed-set / cardinality probes (still future-anticipated; named in the preamble parenthetical even after this round's prune).
- Source-code changes, test additions, schema updates, lint-rule additions.

**Dependencies:**

- `blocked_by: []` — `task-d6656cf3` (round-2 expansion that established the family-grouped `worker-conventions.md` pointer shape) merged via PR #474. `task-96d69bf9` (X-unchanged sibling clause) is queued ahead of this one but does not formally block; if it lands first the preamble bumps `fifteen → sixteen`, if it lands after the implementer reads the live preamble and bumps `fourteen → sixteen` directly. Either way, the AC's invariant of `sixteen clauses` post-merge holds.
- Blocks `task-4335d903` (the consumer task downstream).
- Relates to `task-78cbb135` (the round-1 retrospective source), `task-66feb317`, `task-d6656cf3`, `task-96d69bf9`, `task-01647adf`.
