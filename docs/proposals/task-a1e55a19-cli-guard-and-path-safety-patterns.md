# CLI guard hygiene + path-safety probe pattern

## Goal

Land two tactical workflow patterns from the `task-a804cb4d` retrospective (PR #476, elaborate/stale workflow hardening, round-2 path-traversal catch on a freshly-shipped `tasks status` CLI subcommand) into the harness's two reference-layer docs. Doc-only; no code changes to ludics.

- **Pattern 1 — CLI guard checklist for file-mutating subcommands.** Append one new sub-pattern to `docs/orchestration-patterns.md` near the existing CLI / lint cluster (the `### CI drift files` / `lint-cli-readme` neighbourhood, line 264 area). Concerns "every new file-mutating CLI subcommand needs the path-input guard before any `join(tasksDir(), ...)`-style join; mirroring a sibling case is a checklist task — walk its body line by line." Anchor the rule to PR #476 round 2 (the path-traversal catch on `tasks status`).
- **Pattern 2 — Path-safety regression-test shape.** Append **two adjacent `### ` clauses** to `docs/ac-rigor-reference.md` under `## Vacuous-harness family` — one for the *real-decoy + byte-identity probe shape*, one for the *test inputs your guard accepts* failure mode. The two clauses match the precedent of the existing `Stash-prod mutation test` / `Sibling-mutation for cardinality probes` siblings, where each distinct probe shape gets its own grep-able heading.
- **Pointer update.** `skills/worker-conventions.md` § "AC verification rigor" — the **Vacuous-harness family** bullet's inline title list picks up both new clause titles, in the order they appear in the doc.
- **Preamble count.** `docs/ac-rigor-reference.md` line-5 preamble's clause-count word increments by 2 (current `twenty-two` → post-merge `twenty-four`, but the load-bearing invariant is *current count + 2*, see Re-grep coordination below).

Refs: `task-a804cb4d` (the source retrospective, PR #476), `task-4335d903` (immediate predecessor that landed the prior AC-rigor refinements and the `Sibling-mutation for cardinality probes` precedent for two-clause Vacuous-harness additions, PR #511 merged 2026-05-09), `task-9cd6cdb9` (structural template — same two-doc landing split: orchestration-patterns + ac-rigor + worker-conventions pointer, PR #490).

## Acceptance Criteria

The verifier checks every AC below by literal-string `grep -F` or `grep -cE` against the post-commit tree. Cite `git diff main...HEAD -- <paths>` (symmetric, stable across rebases) or line-numbered direct reads of the post-commit source — not bare `git diff`.

### AC1 — Pattern 1 heading is present in `docs/orchestration-patterns.md`

After the change, `grep -F` against the new H3 literal returns at least one match in `docs/orchestration-patterns.md`:

- `### CLI guard checklist for file-mutating subcommands`

(Final heading wording is the implementer's call within the constraints below; the literal recorded here is what the AC verifier greps against. If the implementer chooses a different literal, this AC text and AC4 / AC6 must be revised in the same commit so the contract and the verifier agree.)

**Falsifier (presence):** `grep -F "### CLI guard checklist for file-mutating subcommands" docs/orchestration-patterns.md` returns no match.

### AC2 — Pattern 1 placement: under `## Coding`, near the CLI / lint cluster

The new H3 is positioned under `## Coding` (line 262 area), in the CLI / lint-related neighbourhood that currently contains `### CI drift files` (line 264) and `### Lockstep contract-prose rewrite` (line 279). Adjacent placement (immediately before or after one of these) is fine; the load-bearing invariant is *somewhere under `## Coding`, not isolated in an unrelated family*.

**Falsifier (relative-position):** Run `grep -nE '^(##|###) ' docs/orchestration-patterns.md`. The line number of the new H3 must satisfy:

- Strictly greater than the line of `## Coding`.
- Strictly less than the line of the next `## ` family heading (the family that follows `## Coding`).
- The new H3 is within 5 H3-headings of `### CI drift files` (i.e., the `## Coding` cluster, not the bottom of the family).

If any of the three relative-position checks fails, the AC is falsified.

### AC3 — Pattern 1 body content: language-agnostic rule, naming the failure mode

The new entry's body covers all of:

1. **The rule.** Every new CLI subcommand that does `join(tasksDir(), \`${id}.md\`)` (or any equivalent path-from-untrusted-input join) needs the path-input guard at the start of its case body, *before* the join — a "task not found" check fires *after* the join and so misses path-traversal IDs.
2. **The mirroring-is-a-checklist framing.** When mirroring a sibling CLI surface, audit *all* of its guards — not just the headline behaviour. A diff between the sibling's body and the new case body should be approximately the *only* differences (input enum, error messages, value field). Anything else is a guard you forgot to copy.
3. **Concrete trigger anchor.** A parenthetical citing PR #476 round 2 (path-traversal catch on `tasks status`) and the `TASK_ID_RE` guard in `tasksSetPriority` (`src/tasks/index.ts:657`) as the reference shape mirrored from.
4. **Distinction from `### CI drift files`.** That neighbour clause covers drift between *paired files* enforced by lint (`src/config.ts` ↔ `templates/config.reference.yaml`); this clause covers a *single-file mirroring* discipline (sibling case body inside `src/tasks/index.ts`) that no current lint rule enforces. The two clauses sit naturally adjacent — both are "lockstep / mirroring" disciplines around CLI surfaces, distinct in what they pair.

**Falsifier (per-element literal presence):** `grep -F` for any of the literal phrases below against the new entry's body returns no match (run via `awk '/^### CLI guard checklist for file-mutating subcommands/{p=1;next} p && /^(### |## )/{exit} p' docs/orchestration-patterns.md | grep -F "<phrase>"`):

- `TASK_ID_RE` — the concrete guard the rule names (or its function-level callers like `tasksSetPriority`; one of these literals must appear).
- `before the join` or `before any join` — the rule's load-bearing temporal qualifier (the guard runs *before* the path is resolved).
- `PR #476` — the concrete trigger anchor.
- `mirror` or `mirroring` — the framing that the new case is a checklist clone of a sibling, not a fresh design.

### AC4 — Pattern 2: two new `### ` clauses under `## Vacuous-harness family`

After the change, `grep -F` against each of the two new H3 literals returns exactly one match in `docs/ac-rigor-reference.md`:

- `### Real-decoy + byte-identity for path-safety probes`
- `### Test inputs your guard accepts pass for the wrong reason`

(Final clause titles are the implementer's call within the constraints below; the literals recorded here are what the AC verifier greps against. If the implementer chooses different titles, this AC text and ACs 5–8 must be revised in the same commit so the contract and the verifier agree.)

**Falsifier (presence, exactly one each):**

- `grep -cF "### Real-decoy + byte-identity for path-safety probes" docs/ac-rigor-reference.md` returns any value other than `1`.
- `grep -cF "### Test inputs your guard accepts pass for the wrong reason" docs/ac-rigor-reference.md` returns any value other than `1`.

### AC5 — Pattern 2 placement: both clauses under Vacuous-harness family, adjacent

Both new clauses sit under `## Vacuous-harness family` (line 13 area), adjacent to each other (no other `### ` heading between them), inserted at the family's tail (after `### Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'`) or — if the implementer reads the live structure and finds a more natural slot — somewhere internal to the family. The load-bearing invariant is *both clauses live under `## Vacuous-harness family`, adjacent, and the family count grows by exactly 2*.

**Falsifier (family-membership):** Run `grep -nE '^(##|###) ' docs/ac-rigor-reference.md`. Both new H3 line numbers must satisfy:

- Strictly greater than the line of `## Vacuous-harness family`.
- Strictly less than the line of `## Proposal-as-canonical family`.
- The two new H3 lines are consecutive in the H3 sequence within the family (no other `### ` between them).

**Falsifier (count):** The Vacuous-harness family clause count (number of `### ` lines between `## Vacuous-harness family` and the next `## ` heading) is exactly *current_count + 2*. The implementer should `grep -nE '^### ' docs/ac-rigor-reference.md` against the live tree at implementation time to read the current count; on `origin/main` as of the proposal-write moment the family contains 5 clauses, so the post-merge target is 7 — but the load-bearing invariant is *+2 from whatever the doc actually contains then*, not the literal `7`.

### AC6 — Pattern 2 first clause body: real decoy + byte-identity, mutation-test recipe

The first new clause's body (between its H3 and the next `### ` / `## ` heading) covers all of:

1. **The rule.** Path-safety regression tests need a *real sibling decoy file* plus *byte-identity comparison*, not just `expect.rejects.toThrow`. A `rejects.toThrow(/invalid task ID/)` assertion passes whenever the runtime throws — including the harmless "task not found" path that doesn't actually exercise traversal.
2. **The non-vacuous shape (recipe).** Seed a real file outside the protected directory before the test, run each malicious-ID call, then assert byte-identity (`expect(after).toBe(decoyContent)`). The clause body must include this seed-real-decoy-then-byte-identity recipe inline — the kind of mutation-testable assertion the clause prescribes (per the `Stash-prod mutation test` precedent of dogfooding the discipline in the clause body).
3. **The mutation-test step.** Mutation-test by removing the production guard and confirming the call *resolves* (writes via traversal) instead of rejecting; if the test still passes after the mutation, the assertion is wrong.
4. **Concrete trigger anchor.** A parenthetical citing PR #476 round 2 and the `tasks status` `TASK_ID_RE` guard as the precipitating instance.

**Falsifier (per-element literal presence):** `grep -F` for any of the literal phrases below against the new clause body returns no match (run via `awk '/^### Real-decoy + byte-identity for path-safety probes/{p=1;next} p && /^(### |## )/{exit} p' docs/ac-rigor-reference.md | grep -F "<phrase>"`):

- `byte-identity` or `byte identity` — the load-bearing assertion shape.
- `decoy` — the seeded-sibling-file framing.
- `expect(after).toBe` or `toBe(decoyContent)` — at least one of these literal probe forms; the clause must dogfood its own discipline by carrying the recipe inline (per AC8 below).
- `PR #476` — the concrete trigger anchor.

### AC7 — Pattern 2 second clause body: test inputs your guard accepts

The second new clause's body covers all of:

1. **The rule.** Don't include test inputs the regex (or guard) actually accepts. The malicious-set in a path-safety test should be exactly the strings the guard rejects, not the strings that "look bad."
2. **The worked example.** First draft of the malicious-IDs list included `..`, but `TASK_ID_RE = /^[A-Za-z0-9._-]+$/` accepts dots — bare `..` resolves to `<tasks>/...md` (a literal weird-named file inside the protected dir, no traversal) and the assertion fails for the wrong reason. The clause body must name the literal regex (`/^[A-Za-z0-9._-]+$/` or its character-class fragment `[A-Za-z0-9._-]`) so a reader sees concretely *why* dots are accepted.
3. **The discipline.** Always check the regex's char class before deciding which strings are "rejected"; the test's malicious set should be exactly the strings the guard rejects.
4. **Concrete trigger anchor.** A parenthetical citing PR #476 round 2.

**Falsifier (per-element literal presence):** `grep -F` for any of the literal phrases below against the new clause body returns no match (run via `awk '/^### Test inputs your guard accepts pass for the wrong reason/{p=1;next} p && /^(### |## )/{exit} p' docs/ac-rigor-reference.md | grep -F "<phrase>"`):

- `[A-Za-z0-9._-]` — the regex's character class (literal substring; this anchors *why* dots slip through). Either the bare class or the full `/^[A-Za-z0-9._-]+$/` form satisfies.
- `..` (bare double-dot inside backticks or as a code span) — the worked-example input.
- `for the wrong reason` — the clause's load-bearing failure-mode framing.
- `PR #476` — the concrete trigger anchor.

### AC8 — Pattern 2 first clause dogfoods its own discipline (non-vacuous shape inline)

The "Real-decoy + byte-identity for path-safety probes" clause body must include a non-vacuous-shape demonstration *inline* — i.e., the seed-real-decoy-then-byte-identity test recipe must appear in the clause body, not merely be referred to. Concretely, the body contains a fenced code block (`````ts ... `````) or inline code spans showing the three-step shape: (1) seed a decoy file outside the protected directory, (2) call the guarded operation with the malicious ID, (3) assert byte-identity on the decoy file's contents.

**Falsifier (recipe present):** `awk '/^### Real-decoy + byte-identity for path-safety probes/{p=1;next} p && /^(### |## )/{exit} p' docs/ac-rigor-reference.md` returns body text in which **none** of the following literal substrings appear: `writeFileSync`, `readFileSync`, `expect(...).toBe(`, `decoyPath`. (At least one of those literals must appear so the recipe is demonstrably present, not paraphrased away. The implementer may pick the exact API surface — `writeFileSync` vs. `Bun.write` vs. `fs.promises.writeFile` — but the clause body must show the seed→call→read-and-assert shape concretely.)

### AC9 — Pattern 1 ↔ Pattern 2 cross-link

Pattern 1's new orchestration-patterns sub-pattern cross-links to one of the two new ac-rigor clauses — the first one (`Real-decoy + byte-identity for path-safety probes`) is the natural target since it carries the regression-test recipe that pairs with the production-guard rule. The cross-link form is either a markdown anchor (`[…](../ac-rigor-reference.md#real-decoy--byte-identity-for-path-safety-probes)`) or a prose reference whose literal text contains the clause title as a substring.

**Falsifier (cross-link target text appears in source doc):** `awk '/^### CLI guard checklist for file-mutating subcommands/{p=1;next} p && /^(### |## )/{exit} p' docs/orchestration-patterns.md | grep -F "Real-decoy + byte-identity"` returns no match.

**Falsifier (target heading still exists, unmodified):** `grep -F "### Real-decoy + byte-identity for path-safety probes" docs/ac-rigor-reference.md` returns no match. (The cited heading must survive the same commit; no rename, no relocation post-write.)

### AC10 — `worker-conventions.md` pointer update: Vacuous-harness family bullet picks up both new titles

In `skills/worker-conventions.md` § "AC verification rigor" (line 56 area), the **Vacuous-harness family** bullet's inline title list is amended to include both new clause titles. The new titles appear in the bullet in the order they appear in the doc (i.e., after `Sibling-mutation for cardinality probes` if the new clauses land after `Probe before cleanup`, or in whatever family-internal slot the implementer chose under AC5). The other two family bullets (`Falsifier-shape family:` and `Process-around-the-AC:`) are not touched.

**Falsifier (titles present in pointer):** Either of the following `grep -F` calls against `skills/worker-conventions.md` returns no match:

- `grep -F "Real-decoy + byte-identity for path-safety probes" skills/worker-conventions.md`
- `grep -F "Test inputs your guard accepts pass for the wrong reason" skills/worker-conventions.md`

**Falsifier (other bullets unchanged):** `grep -F "Falsifier-shape family:" skills/worker-conventions.md` or `grep -F "Process-around-the-AC:" skills/worker-conventions.md` returns no match. (The other two family bullets must survive verbatim — this task does not touch them.)

### AC11 — Preamble count update: current word + 2

The preamble line at `docs/ac-rigor-reference.md:5` (currently `"Today it covers twenty-two clauses across five thematic families; …"` on `origin/main` as of 2026-05-09) increments by 2. The implementer reads the live preamble at implementation time (any sibling task may land between proposal-write and implementation, e.g., the doc was at 19 clauses when the task body was drafted but at 22 when this proposal lands — see Re-grep coordination in the Approach section).

**Falsifier (count present, target = current+2):** After the edit, `grep -cF "<target_word> clauses across five thematic families" docs/ac-rigor-reference.md` returns `1`, where `<target_word>` is the cardinal English word for *current_count + 2*. On `origin/main` as of 2026-05-09 that target word is `twenty-four`; if a sibling task lands first, the implementer recomputes against the live count.

**Falsifier (old count absent):** The literal `<old_word> clauses across five thematic families` (the count word that was on disk before the edit) returns no match after the edit. The literal must be replaced, not left alongside.

**Falsifier (clause-count invariant):** `grep -cE '^### ' docs/ac-rigor-reference.md` equals the cardinal value of `<target_word>`. The preamble word and the actual `### ` count must agree.

### AC12 — Touched files: exactly four paths

`git diff --name-only main...HEAD` returns exactly the paths:

- `docs/orchestration-patterns.md` (Pattern 1).
- `docs/ac-rigor-reference.md` (Pattern 2's two clauses + preamble).
- `skills/worker-conventions.md` (pointer update).
- `docs/proposals/task-a1e55a19-cli-guard-and-path-safety-patterns.md` (this proposal, already committed by the orchestrator's worker step).

No source-code files (`src/**`, `scripts/**`, `templates/**`), no tests (`*.test.ts`), no schema files.

**Falsifier (scope invariant):** `git diff --name-only main...HEAD` returns any path under `src/`, `scripts/`, `templates/`, any `*.test.ts` file, any `*.json` schema, or any `docs/proposals/**` other than this proposal.

**Recovery if the proposal commit is already on `main` at implementation time.** When the orchestrator commits the proposal one or more rounds before the implementation phase begins, `main` may have advanced past the proposal commit by the time the implementation lands — `git diff --name-only main...HEAD` then returns only the three doc paths the implementation touches, and the proposal path is missing from the diff at the symmetric base. The recovery: include the proposal path in the diff by editing the proposal in the same commit (a falsifier-form clarification, an awk-range fix, an in-line recovery clause). The load-bearing invariant is **no source-code, no test files, no schema files** — that's what reviewers should reject on; the four-path enumeration is the snapshot expression of "exactly the docs scope, nothing else." See [`### Proposal-path enumeration goes stale when proposal commits to main first`](../ac-rigor-reference.md#proposal-path-enumeration-goes-stale-when-proposal-commits-to-main-first--anchor-to-scope-invariant) (Verification-evidence family) for the durable form.

## Context

The source retrospective is `task-a804cb4d` (PR #476, elaborate/stale workflow hardening, merged 2026-04-30 with 2 review rounds + 1 post-merge Codex finding). Round 2 surfaced a real path-traversal vulnerability in the freshly-shipped `tasks status` CLI subcommand — the new command mirrored `tasksSetPriority`'s shape but missed its `TASK_ID_RE` guard, so `ludics tasks status ../decoy/sibling ready` would have written to a file outside `tasks/`. Reviewer caught it in round 2; the fix added the guard plus a real-decoy regression test (commit `ef6814a`).

The retrospective surfaced four durable learnings split across two reference docs along the same lines as `task-9cd6cdb9`'s split (Pattern 1 → orchestration-patterns; Pattern 2 → ac-rigor). Pattern 1 captures the production-guard checklist; Pattern 2 captures the regression-test shape.

### Skipped suggestions (carried verbatim from task body)

The full retrospective surfaced 6 durable learnings; 2 were judged not substantive enough for a follow-up task:

- **Learning 5 ("Bun test discovery extends when a top-level test file is added")** — operational gotcha worth surfacing as a memory entry via `/ludics-learn`, not a task. Already filed out-of-band on 2026-05-09 at `~/.claude/projects/-Users-lukstafi-self-improve/memory/feedback_bun_test_discovery_drift.md`.
- **Learning 6 (".peer-sync/ is not committed")** — already implicit in existing worker conventions; the round-2 confusion was a one-off worker mis-step.

### Out of scope

- A *static linter* that enforces the `TASK_ID_RE`-before-join guard at every CLI case body (the kind of thing that would have prevented Pattern 1's recurrence directly). **Deferred until a third recurrence motivates it** (per Question 4 resolution 2026-05-09); Pattern 1's doc-level capture is sufficient for now. If a lint rule lands later, the new orchestration-patterns sub-pattern becomes a pointer to the rule.
- The **slotted-stale-abandon Codex finding** — the cross-tool review complementarity observation is too philosophical / already encoded as informal practice; reviewer-tool diversity doesn't need a memory entry (per Question 2 resolution 2026-05-09).
- The **Bun test discovery memory entry** — already filed out-of-band 2026-05-09 (per Question 3 resolution).
- Source-code changes, test additions, schema updates, lint-rule additions; restructuring family sections in `ac-rigor-reference.md`; renaming existing clauses; reflowing the preamble's `"five thematic families"` wording.
- Adding back-links from the existing ac-rigor clauses to the new ones (the cross-link from Pattern 1 → Pattern 2's first clause is sufficient under AC9; symmetric back-linking is a separate maintenance item).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The work is doc-only with three touched files. A natural single-commit shape:

1. **Pattern 1 → `docs/orchestration-patterns.md`.** Insert a new `### CLI guard checklist for file-mutating subcommands` subsection under `## Coding`, in the CLI / lint cluster (line 264 area, near `### CI drift files` and `### Lockstep contract-prose rewrite`). Body: 3–5 sentences. The rule sentence states the production-guard discipline (`join(tasksDir(), \`${id}.md\`)` is preceded by the `TASK_ID_RE` guard at the *start* of the case body, before the join). The framing sentence covers the mirroring-is-a-checklist principle (a diff between sibling and new case body should be approximately *only* the differences that name the new behaviour — input enum, error messages, value field; anything else is a guard you forgot to copy). The anchor sentence cites PR #476 round 2 (the `tasks status` path-traversal catch) and `tasksSetPriority` at `src/tasks/index.ts:657` as the reference shape. One closing sentence cross-links to the ac-rigor `### Real-decoy + byte-identity for path-safety probes` clause as the regression-test pair. Voice is the implementer's call — adjacent neighbours use both the `**Principle.**`/`**Why.**` form and the rule + one-sentence anchor form; pick whichever reads cleanly.

2. **Pattern 2 → `docs/ac-rigor-reference.md`, two adjacent clauses.** Insert two new `### ` clauses under `## Vacuous-harness family`, adjacent to each other. Natural placement is at the family's tail (after `### Probe before cleanup`), but somewhere internal to the family is also fine if a more natural slot presents itself (the clauses sit logically after `### Sibling-mutation for cardinality probes` because they extend the "concrete probe shape" theme).

   - **First clause: `### Real-decoy + byte-identity for path-safety probes`.** Body: 4–7 sentences. Cover the rule (`rejects.toThrow` is vacuous because it passes for "task not found" too), the non-vacuous recipe (seed real decoy file outside protected dir → call guarded operation with malicious ID → assert `expect(after).toBe(decoyContent)`), the mutation-test step (remove the guard, confirm the call writes via traversal), and the concrete trigger (PR #476 round 2). The body must dogfood its own discipline by carrying the seed-real-decoy-then-byte-identity recipe *inline* — at least one of `writeFileSync`, `readFileSync`, `expect(...).toBe(`, `decoyPath` appears as a literal so AC8 passes.
   - **Second clause: `### Test inputs your guard accepts pass for the wrong reason`.** Body: 3–5 sentences. Cover the rule (the malicious-set should be exactly what the guard *rejects*, not what "looks bad"), the worked example (bare `..` is accepted by `TASK_ID_RE = /^[A-Za-z0-9._-]+$/` because dots are in the char class — assertion fails for the wrong reason), the discipline (always check the regex's character class before deciding what's "rejected"), and the concrete trigger anchor (PR #476 round 2). The literal regex `[A-Za-z0-9._-]` (or the full form) must appear so a reader sees concretely *why* dots slip through.

3. **Preamble update in `docs/ac-rigor-reference.md`.** Read `docs/ac-rigor-reference.md:5` at implementation time. Replace the current cardinal English count word with the cardinal for *current count + 2*. On `origin/main` as of 2026-05-09 the live preamble reads `"Today it covers twenty-two clauses across five thematic families"`; the post-merge target is `twenty-four`. If a sibling task lands between proposal-write and implementation, the implementer recomputes the target word from the live count.

4. **`worker-conventions.md` pointer update.** In `skills/worker-conventions.md` § "AC verification rigor" Vacuous-harness family bullet (line 56 area), append both new clause titles in the order they appear in the doc. The bullet currently reads: `Vacuous-harness family: Vacuous test harness — assert on the artifact the AC names; Stash-prod mutation test — confirm your new test actually falsifies; Sibling-mutation for cardinality probes; Vacuous doc/config harness — same rule, doc artifacts; Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'; Mutation evidence — for test-shaped AC verification, …`. Append `; Real-decoy + byte-identity for path-safety probes; Test inputs your guard accepts pass for the wrong reason` (or splice them in family-internal order if the new clauses landed mid-family). Do **not** touch the `Falsifier-shape family:` or `Process-around-the-AC:` bullets.

### Sequencing note

AC3 (preamble count) is mechanical — it's the *last* edit in the commit, after the two new clauses have landed and the new total is determinate. AC10 (worker-conventions pointer) follows AC4–AC8 because its title list mirrors the new clause titles; if the implementer chooses different titles than this proposal's literals, both AC10 and the literals in AC4 / AC6 / AC7 / AC9 must be updated in the same commit so the contract and the verifier agree.

### Re-grep coordination

This proposal extends the AC-rigor doc; the count-bump (AC11) follows the same protocol as `task-4335d903` (which also bumped the preamble count): **re-grep the live count at landing time, bump from whatever the doc actually contains then.** Do not hardcode the literal "22 → 24" — at the moment this proposal is being drafted (2026-05-09 morning), the live doc reads "twenty-two clauses" because `task-4335d903` (PR #511) merged earlier today, but the original task body referenced "nineteen → twenty-one" because it was drafted before that merge. Treat the count as *current count + 2* throughout the AC verifier; the literal target word is whatever the implementer reads from `docs/ac-rigor-reference.md:5` at implementation time. The Pattern 2 clauses always add **+2** to the family count and **+2** to the doc-wide count regardless of intervening sibling tasks.

### Verify before committing

- `grep -F "### CLI guard checklist for file-mutating subcommands" docs/orchestration-patterns.md` → match (or whatever literal the implementer chose, with AC1 / AC9 updated).
- `grep -cF "### Real-decoy + byte-identity for path-safety probes" docs/ac-rigor-reference.md` → `1`.
- `grep -cF "### Test inputs your guard accepts pass for the wrong reason" docs/ac-rigor-reference.md` → `1`.
- `grep -cE '^### ' docs/ac-rigor-reference.md` → *current_count + 2* (= 24 if no sibling lands between draft and implementation).
- `grep -F "<target_word> clauses across five thematic families" docs/ac-rigor-reference.md` → match (with `<target_word>` = cardinal of *current_count + 2*).
- `grep -F "<old_word> clauses across five thematic families" docs/ac-rigor-reference.md` → no match (the literal must change, not be left alongside).
- Per-element literal phrases from AC3, AC6, AC7, AC8 each return at least one match in their respective new entries.
- `grep -F "Real-decoy + byte-identity for path-safety probes" skills/worker-conventions.md` → match.
- `grep -F "Test inputs your guard accepts pass for the wrong reason" skills/worker-conventions.md` → match.
- The cross-link target is intact: `grep -F "### Real-decoy + byte-identity for path-safety probes" docs/ac-rigor-reference.md` → match (already covered by AC4 but worth re-checking against AC9).
- `git diff --name-only main...HEAD` → exactly the four paths from AC12 (or three docs if the proposal commit landed on `main` ahead of the implementation branch — see AC12 recovery clause).

### Commit message style

Follows the `task-9cd6cdb9` / `task-4335d903` precedents:

> `docs: add CLI guard checklist + path-safety probe clauses (task-a1e55a19)`
>
> Two tactical workflow patterns from task-a804cb4d retrospective land in
> the two reference-layer docs. Pattern 1 (CLI guard checklist for
> file-mutating subcommands) under orchestration-patterns § Coding near
> the CLI / lint cluster — covers the production-guard discipline that
> PR #476 round 2 surfaced as a real path-traversal vulnerability in the
> tasks-status subcommand, and the mirroring-is-a-checklist framing for
> sibling CLI surfaces. Pattern 2 lands as two adjacent clauses under
> ac-rigor § Vacuous-harness family — Real-decoy + byte-identity for
> path-safety probes (the non-vacuous regression-test recipe) and Test
> inputs your guard accepts pass for the wrong reason (the
> false-positive-rejection failure mode). Bumps the AC-rigor preamble's
> clause count by 2 (twenty-two → twenty-four) and the worker-conventions
> Vacuous-harness pointer picks up both new titles.
>
> Refs: task-a1e55a19 (from task-a804cb4d round-2 retrospective, PR #476)

Use `git diff main...HEAD -- docs/ac-rigor-reference.md docs/orchestration-patterns.md skills/worker-conventions.md` (post-commit, symmetric) for verification evidence — not bare `git diff`.

This proposal is itself an AC-rigor exercise: the ACs use literal `grep -F` / `grep -cF` falsifiers, per-element decomposition (AC3, AC6, AC7), per-line-number relative-position invariants (AC2, AC5), post-commit-evidence framing (AC12), and the dogfood-the-discipline shape (AC8 — the new "real-decoy + byte-identity" clause body must carry its own recipe inline, mirroring the `Stash-prod mutation test` precedent of literal `git stash push --` in the clause body).

## Scope

**In scope:**

- Append `### CLI guard checklist for file-mutating subcommands` subsection (or implementer-chosen literal, with ACs updated) to `docs/orchestration-patterns.md` under `## Coding`, in the CLI / lint cluster.
- Append two new adjacent `### ` clauses (`### Real-decoy + byte-identity for path-safety probes` and `### Test inputs your guard accepts pass for the wrong reason`, or implementer-chosen literals) to `docs/ac-rigor-reference.md` under `## Vacuous-harness family`.
- Cross-link Pattern 1's new orchestration-patterns sub-pattern to one of the two new ac-rigor clauses (the first one is the natural target).
- Update the `docs/ac-rigor-reference.md` preamble: clause count word increments by 2 from the live count.
- Update `skills/worker-conventions.md` § "AC verification rigor" Vacuous-harness family bullet to include both new clause titles.

**Out of scope** (forwarded verbatim from the task body's resolved Out-of-scope list):

- Static linter (`lint:cli-path-guards`) that enforces the `TASK_ID_RE`-before-join discipline at every CLI case body — deferred until a third recurrence (per Q4 resolution 2026-05-09).
- Slotted-stale-abandon Codex memory entry / cross-tool review complementarity prose (per Q2 resolution 2026-05-09).
- Bun test discovery memory entry (already filed out-of-band 2026-05-09 per Q3 resolution).
- Updating the `Falsifier-shape family:` or `Process-around-the-AC:` bullets in `skills/worker-conventions.md` (they don't pick up new entries from this task).
- Restructuring family sections, renaming existing clauses, or reflowing the preamble's `"five thematic families"` wording (still accurate after this round).
- Adding back-links from the existing ac-rigor clauses to the new ones; symmetric back-linking is a separate maintenance item.
- Source-code changes, test additions, schema updates, lint-rule additions.

**Dependencies:**

- `blocked_by: []` — `task-4335d903` (the predecessor that landed the prior 3 AC-rigor refinements) merged via PR #511 on 2026-05-09; the doc is stable at 22 clauses pending this task's increment.
- `relates_to: [task-a804cb4d, task-4335d903, task-9cd6cdb9]` — source retrospective; predecessor that bumped the preamble; structural template for the two-doc landing split.
