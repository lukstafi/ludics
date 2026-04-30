# Orchestration Patterns

Agent-facing reference for recurring concerns in the pair-orchestration workflow (plan → work → review). Each template under `skills/orchestration/` states a *principle*; this doc carries the *specifics* — the worked example, the decision rule, and the boundaries of where the pattern applies.

Organized by workflow touchpoint. When a pattern applies at more than one touchpoint, it appears under the phase where it originates and is referenced from the others.

- [Planning](#planning)
- [Coding](#coding)
- [Reviewing](#reviewing)

The templates point here with short links of the form `see [pattern](../../docs/orchestration-patterns.md#<slug>)`. Slugs are lowercase and hyphen-separated (GitHub's default markdown anchor); they stay stable as long as headings don't rename.

If a new pattern needs to be added, it should pass the same bar the templates hold themselves to: *name the concern, state the principle, explain why it exists, show one concrete example, and describe when not to apply it*. Entries that can't pass that bar are rules masquerading as patterns and belong elsewhere — a CI lint, a runtime assertion, or simply nowhere.

---

## Planning

### Pre-existing failures baseline

**Principle.** Before planning code changes, record the exact names of tests failing on the base branch under a `## Pre-existing test failures (baseline)` section in the plan. Use `none` when all tests pass. List each failing test individually rather than summarizing.

**Why.** The reviewer uses this baseline to separate pre-existing noise from regressions introduced by this round. A summary ("a few dashboard tests fail") loses the discrimination a named list gives. Without a baseline, every failing test during review becomes a judgment call with no anchor.

**Decision rule the reviewer applies.** When a reviewer encounters a failing test during review:

1. If the test name is in the plan's baseline — non-blocking, unless the task's acceptance criteria call for fixing it.
2. If the test name is *not* in the baseline — blocking (regression introduced this round).
3. If the plan has no baseline section (older format or skipped planning) — treat as potentially blocking. Fall back to judgment against the base branch rather than accepting the failure on faith.
4. If the baseline notes planning was skipped — block only on failures clearly caused by this task's changes.

**Example section in a plan.**

```
## Pre-existing test failures (baseline)

1. `generateRecentlyCompleted shape guards > non-object event lines do not create false pr_merged state` (src/dashboard.test.ts)
2. `style.css contains pending-action-badge class > pending-action-badge uses amber/yellow color` (templates/dashboard/dashboard.test.ts)
```

**When not to apply.** For tasks that explicitly fix pre-existing failures, the baseline still gets recorded — but those named tests become the acceptance criterion, not the non-blocking backdrop.

### Exhaustive occurrence search

**Principle.** For every symbol, pattern, or function you plan to touch, run a project-wide grep/ripgrep and list occurrences in the plan with a disposition: *modify*, *skip with reason*, or *N/A*. Search for inline reimplementations too — regex patterns, copy-pasted logic, and string literals that duplicate the same behavior — because canonical-name search alone misses them.

**Why.** Code that looks like a single definition often has silent doppelgangers: a regex that implements the same rule in a different file, a string literal that duplicates a magic value, a copy-pasted validation helper. When you change only the canonical site, the doppelgangers keep the old behavior. The bug then looks like a partial fix and takes another round to diagnose.

**Example disposition list.**

```
## Occurrence sweep — `extractMagPaths`

1. `scripts/lint-config-helpers.ts` line ~191 — modify (canonical definition)
2. `src/config.ts` — skip (imports the canonical; no inline reimplementation)
3. `scripts/lint-config-reference.ts` — skip (calls the canonical)
4. `tests/fixtures/` — N/A (fixtures don't call it)
```

**When `skip with reason` is appropriate.** Any hit outside the intended blast radius — a fixture, a doc snippet, a deprecated module — gets a one-phrase reason. Leaving a hit unlabelled is the common failure mode; the disposition list forces the decision into the plan where the reviewer can see it.

**Single grep, double duty.** The same `grep -n <token> <files>` that enumerates the targets also catalogs the nearby out-of-scope hits — different modules, deprecated paths, fixtures — so one command produces both the modify list and the scope-boundary citation. Record the boundary calls inline in the disposition list rather than running a separate audit pass; the list is the natural home for them. The reviewer's "why didn't you also touch line N?" question then has a pre-written answer cited from the same evidence the modify list rests on.

**Boundary.** If the symbol is a primitive name collision (`type`, `handle`, `data`), the sweep is noisy and probably useless — swap the approach to "search for the specific call signature" or "search for the import path". The principle is exhaustiveness, not blind greps.

**The grep itself can lie.** Leading-anchor patterns like `^export function` or `^export const` miss `export { ... }` re-export blocks — a symbol can be publicly exposed without ever appearing as the head of a declaration line. `src/adapters/tmux-adapter.ts`'s trailing `export { ... }` block is the worked example: it re-exports `readTmuxSlotState`, `writeTmuxSlotState`, `removeTmuxSlotState`, and `agentPortRole` alongside the adapter object's own members, none of which a `^export function` grep would surface. Use a broader pattern — `grep -nE 'export[[:space:]]*\{'` (or `rg 'export\s*\{'`) — alongside the leading-anchor patterns when the question is "is this name publicly exposed?" rather than "where is it declared?". The leading `\{` only works in extended-regex mode; default `grep` is BRE and errors with `Unmatched \{`. See also gh-ludics-406 (the consumer-side sibling: lint scripts that regex-extract symbol references break silently on DRY refactors) — same family of regex-shape blind spot, opposite end of the import chain.

See also [post-edit-occurrence-recheck](#post-edit-occurrence-recheck) for running the same sweep *after* the edit, and in both directions (forward and inverse). See also [patterncount-enumeration-for-bulk-migrations](#patterncount-enumeration-for-bulk-migrations) for the durable form of the site enumeration this entry advocates.

### Pattern+count enumeration for bulk migrations

**Principle.** When a bulk migration touches more than a handful of sites, express the site set in the proposal as `grep -oF '<exact-pattern>' <path> | wc -l = N`, not as a line range. The same exact-pattern grep that *enumerates* the cohort is the one that *qualifies* it for `replace_all`.

Why `-oF | wc -l` rather than `grep -c`: `grep -c` counts *lines* containing a match (under-counting when two call sites share a line — minified code, chained calls, compressed fixtures), and treats the pattern as a regex by default (regex metacharacters like `.`, `(`, `[`, `?` would inflate or deflate the count). `-o` prints each match on its own line; `-F` reads the pattern as a fixed string. The pair `grep -oF | wc -l` therefore counts *occurrences* of a *literal* pattern — exactly the semantics this entry's "exact-pattern, character-identical" framing requires.

**Why.** Pattern+count is rebase-stable — exact-string counts survive unrelated commits the way line ranges don't — and mechanically verifiable: a reviewer or worker can re-run the same grep and compare to the proposal's stated count without a visual scan. A line-range proposal can match the stated bound and still miss sites that fall outside it; pattern+count cannot.

**Recipe.**

1. Pick the exact pattern that defines a site (the inline call shape, the regex, the string literal — whatever is character-identical across the cohort).
2. Record `grep -oF '<pattern>' <path> | wc -l = N` in the proposal, not a line range. If the migration spans multiple files, list one `grep -oF | wc -l` per file with its expected count.
3. At edit time, re-run the same `grep -oF | wc -l` invocation and confirm the count matches the proposal before starting. If it doesn't, the pattern set has drifted since the proposal — pause and reconcile.
4. If the pattern is character-identical across the cohort (verified by step 3's count matching), a single `Edit { replace_all: true }` collapses N edits into one operation; iterate site-by-site only on the residue.

**Worked example.** `task-95310454`'s dashboard console-silence migration. The original proposal said "12 sites in lines 241–565". The actual count was 13: a 13th site at the `startDashboardServer` wrapper (~line 615) sat outside the proposed line range and was caught only on a thorough sweep. A pattern+count enumeration — `grep -oF 'originalConsoleX(...args)' src/dashboard.ts | wc -l = 13` — would have surfaced the 13th site at proposal-write time, before any edit was attempted. 12 of the 13 sites then collapsed in one `Edit { replace_all: true }` because the inline pattern was character-identical; the 13th, with different surrounding context, iterated as a single follow-up edit.

**Boundary.** Pattern+count earns its keep on bulk migrations (≥3 sites). For 1–2 site changes, line refs (or symbol-name references — see [symbol-name-references](#symbol-name-references)) are still fine and shorter. `replace_all` is only safe under exact-pattern identity verified by `grep -oF | wc -l`: whitespace or indentation drift defeats the match, and subtle context differences (a different surrounding helper, an alternative cast) usually mean the cohort needs splitting into per-pattern sub-counts before any `replace_all` is attempted.

See also [exhaustive-occurrence-search](#exhaustive-occurrence-search), [post-edit-occurrence-recheck](#post-edit-occurrence-recheck).

### Data-shape consumer sweep

**Principle.** When a task changes data shapes — field extraction, JSON migration, section restructuring, type-signature changes — list every downstream consumer in the plan with a note on whether it needs updating.

**Why.** Shape changes silently break downstream code in ways TypeScript doesn't catch: destructuring with a default, `any`-typed call sites, sections read positionally from free text, round-tripped JSON that drops fields. The failures show up later, in a different context, as data-loss rather than a type error.

**What counts as a consumer.** Anything that reads the shape: direct accessors, destructuring, JSON parsers, template renderers, tests, fixtures, log-format regexes, dashboard displays. Grep the field name, the section header, the type name — all three, because any one of them can be the only mention.

**Example.** A plan adding an `effort` field to `TaskEntry` lists: the YAML parser, the serializer, the briefing renderer, the dashboard column, the `lint:config-reference` fixtures, every test that constructs a `TaskEntry` literal. Each gets a disposition.

### Read-boundary backfill for optional fields

**Principle.** When you add a new optional field to a persisted shape (a type that round-trips through JSON, YAML, or any disk/network serializer), populate it inside the existing read-boundary normalizer — `migrateState`, `parseTaskFrontmatter`, or the equivalent for the type — rather than chasing every construction site. One `state.foo ??= defaultFoo` line in (or immediately adjacent to) the read function uniformly handles three populations: production init, legacy on-disk state predating the field, and test-constructed literals. Construction-site population alone reaches only the production init path the author already knows about.

**Why.** Read functions are named, finite, and centralized — a maintainer can enumerate every read in seconds. Construction sites are diffuse: production init paths, test literal fixtures, HTTP-deserialized payloads, JSON loaded from disk that pre-dates the field. Backfilling at read covers all four classes; backfilling at construction covers only the production init path. Test fixtures that omit the new field then exercise the same backfill code path as legacy on-disk state — strictly more coverage, not less.

**Worked example.** PR #399 added `OrchestrationState.harnessDir` (an optional persisted field). The original plan populated it only at the two production init sites — the `persistState` calls in `src/adapters/t3code.ts` and `src/adapters/tmux-adapter.ts`. The reviewer pointed out this leaves legacy state files (no field, written before the field existed) and test-constructed `OrchestrationState` literals undefined. Adding `migrated.harnessDir ??= harnessDir` immediately after `migrateState` in `readOrchestrationState` (in `src/orchestration/state.ts`, in both the worker-cache and controller-harness branches) normalizes all three populations uniformly. Construction-site population was kept as defense-in-depth.

This codebase already carries two flavors of read-boundary normalizer:

1. **Explicit post-processor** — `migrateState` in `src/orchestration/state.ts`, called inside `readOrchestrationState`. Already performs the legacy `feature → taskId` rename; PR #399 layered the `harnessDir` backfill alongside it. Best when the type is large and producers shouldn't be forced to enumerate every field.
2. **Implicit destructuring with `??` defaults** — `parseTaskFrontmatter` in `src/tasks/markdown.ts`. Every parsed field carries a `?? default` (`status` defaults to `"ready"`, `priority` to `"B"`, dependency arrays to `[]`). New optional fields naturally accrete here as they're added to the type.

The two flavors are equivalent in effect; the choice is stylistic.

**When not to apply (and other boundary notes).**

1. *The default must be derivable at read time.* `harnessDir` works because `readOrchestrationState` already takes `harnessDir` as a parameter — there's a free value to assign. If the default is computed from other state fields the read site doesn't already see, the backfill belongs higher up the call graph instead.
2. *`??=` mutates in place.* That's fine when the read returns a fresh deserialized object (the case in every current ludics reader); it's a hazard if the read returns a shared/cached reference callers might already hold. Document the convention if you introduce a caching reader later.
3. *Additions, not renames.* The pattern handles *adding* an optional field. *Renaming* needs a different shape — `state.new ??= state.old; delete state.old` — same migrator function, distinct construct (see the `feature → taskId` rename in `migrateState`). Document them separately.
4. *Defense-in-depth at construction sites is cheap and worth keeping.* The rule is "always backfill at read", not "never set at construction." Belt-and-suspenders is fine; the principle just makes construction-site population non-load-bearing.
5. *No runtime lint enforces this.* "This field was added without a backfill" is too weak a signal to detect mechanically — there's no syntactic marker on a type definition that says "this field is on a persisted shape." Review-time guidance (the data-shape paragraph in `skills/orchestration/pair-reviewer-plan-review.md`) is the enforcement layer.

See also [data-shape consumer sweep](#data-shape-consumer-sweep) — both concern shape evolution; consumer sweep looks downstream at every read, while read-boundary backfill collapses the population responsibility into the read itself.

### Regression test per behaviour change

**Principle.** Each behaviour change this round needs a regression test named in the plan and landed in the **first implementation round**, not deferred to a follow-up.

**Why.** Deferred tests drift to abandonment. By the time a follow-up round happens, the original authors have moved on, the test's motivation has faded, and a later refactor breaks the uncovered behaviour without anything noticing.

**Common triggers.**

1. Changed serialization → a round-trip test (see [round-trip serialization fidelity](#round-trip-serialization-fidelity)).
2. New or changed template rendering → a test that exercises the new variable or output branch.
3. Modified validation → tests covering the new rule and its edge cases.
4. New CLI output or changed log line → a test asserting the exact string (or a shape-stable regex).

**When not to apply.** A pure refactor that doesn't change observable behaviour doesn't need a new regression test — the existing tests are the coverage. The judgment call is "did I change what a caller can observe?", not "did I change any code?" The no-new-test decision still owes the plan a citation: name the existing test (or test file) that already covers the touched call sites, so the refactor case leaves a reviewable artifact reviewers can point to instead of a silent skip.

See also [negative-case-regression-testing](#negative-case-regression-testing) for the stress-test discipline that keeps a new regression test honest.

### Wide table avoidance

**Principle.** Use numbered lists for structured data in plans and reviews. Avoid wide markdown tables.

**Why.** Agent-to-agent handoffs render templates through intermediaries that truncate wide tables, losing right-hand columns silently. Numbered lists survive the handoff because they reflow.

**When a table is still fine.** Narrow tables (2–3 short columns) render reliably. Reach for a table when the tabular structure is genuinely the point; reach for a list when the columns are a formatting accident.

### Scope declaration and salvage

**Principle.** Declare out-of-scope files in the plan and in the commit message. When something useful lands but falls outside the declared scope, salvage it into a needs-confirmation follow-up rather than expanding the current round or silently dropping it.

**Why.** Scope creep is corrosive to the plan-merge cycle: the reviewer's plan and the coder's plan can't be reconciled if either side is free to widen the field. A declared scope gives both sides a shared boundary; the salvage path gives useful incidental work a home without blowing the boundary.

**Reviewer discretion.** The reviewer can accept a small out-of-scope fix if it's genuinely incidental (a typo touched by a move, an obvious import reorder). They should REQUEST_CHANGES if the declaration was missing or the "salvage" is substantive enough that it needed its own plan.

**Procedure (diff commands).** When assessing scope on a feature branch, prefer the per-commit view over the cumulative view: the branch may be stale against its base. `git diff main..HEAD --stat` is cumulative and conflates main-side drift with this branch's own work — on a branch that forked hours ago while other PRs landed, it can attribute unrelated deletions and additions to this branch. `git log main..HEAD --stat` (per-commit summary across the branch) and `git diff <commit>^..<commit> --stat` (a single commit's actual change against its own parent) attribute changes to the branch's own commits. Rule: when `main..HEAD` shows large deletions but the per-commit diffs do not, that is main-side drift from a stale branch, not a scope violation — the remedy is `git rebase origin/main` and re-review, not scope pushback or manual restoration. The same logic applies to any base branch, not only `main`. Runner-side plan-entry stale-base detection (forward link to task-91667552's runner warning, when it lands) is the prevention layer; if a reviewer is staring at a suspicious cumulative diff, the warning either did not fire or was missed.

### Scope: floor, not ceiling

**Principle.** Acceptance criteria are a contract floor — every listed criterion must be satisfied. They are not a ceiling. A coder may absorb small adjacent fixes that the change made obvious without a separate plan, declaration, or follow-up task. A reviewer should accept silently-absorbed incidentals rather than demand they be reverted.

**Why.** Over-strict scope enforcement spawns a long tail of one-line follow-up tasks (typo fixes, stale comments, dead-code drops, one-line type tightenings) that cost more in coordination than they cost to land in the original PR. The "Scope declaration and salvage" pattern above is for the *substantive* expansions where shared-boundary discipline matters. It is not meant to gate every incidental fix.

**Boundary (absorb without ceremony).** All of these must hold:

- A few lines per fix, summing to a small fraction of the PR's diff.
- Same file as a real change, or its sibling test file.
- No new abstractions, no new imported modules, no new public surface.
- No data-shape, schema, or interface change.
- A reader of the PR would say "obviously this had to come along."

When all hold, the coder absorbs the fix. The commit message body may mention it ("Also fixes a stale comment in the same block") but no `scope-expansion:` trailer is required. The reviewer accepts.

**Boundary (declare or defer).** Reach for declare/salvage/follow-up when *any* of these hold: the fix is more than a few lines, it touches a file the change wouldn't otherwise have opened, it introduces a new abstraction, it materially broadens the PR's review surface, or a reasonable reviewer would want to evaluate it as its own change. Whole-file reformatting and unrelated refactors stay out — those are the proliferation risk.

**Reviewer posture.** Three tiers, not two:

- **Absorb silently** — the fix meets the boundary above. No comment, or one acknowledgement line. Do not request a revert.
- **Accept with note** — the expansion is borderline (e.g. ~10–20 lines, still same module). Note "scope: accepted" in the review body so the trail is visible.
- **Reject and ask for salvage** — only when the expansion is substantive enough that it would have warranted its own plan, or when it materially broadens the PR's review surface. Use the salvage procedure under "Scope declaration and salvage" above; do not just say "revert."

**For verifiers.** Loose ends that meet the absorb boundary above should not be enumerated as `followups` — note them in `evidence` instead. Reserve the `followups` array for items that need their own commit, their own test, or their own review surface. A single coherent cleanup follow-up beats three tiny ones; if multiple loose ends are related, combine them.

### Assumption drift

**Principle.** Mark unverified claims with `[UNVERIFIED]` in plans and proposals. Escalate substantive gaps between the proposal and the codebase with `⚠️ ASSUMPTION GAP: proposal assumes X but codebase has Y. Recommend <remediation>.` before proceeding. Treat proposals stale in storage as riskier than fresh ones — the commit count since the proposal was written is a freshness signal.

**Why.** Proposals are written at a specific point in the codebase's history. Between drafting and implementation, file paths move, APIs rename, intermediate refactors ship. If the implementer treats every proposal claim as still-true on faith, the first divergence becomes a silent bug instead of a flagged gap.

**Example.** A proposal says "`extractMagPathsFromSource` in `scripts/lint-config-helpers.ts` returns a `string[]`." The implementer greps and finds it now returns `Set<string>`. They either note `⚠️ ASSUMPTION GAP: proposal assumes string[] return, codebase returns Set<string>. Recommend minor adjustment in plan.` and proceed, or — if the shape change cascades — REQUEST_CHANGES back to the proposal author.

### Symbol-name references

**Principle.** Reference code by function, type, or symbol name rather than by line number.

**Why.** Line numbers drift between elaboration, planning, and implementation. A proposal that says "see `foo.ts` line 42" rots the moment someone inserts an import; a proposal that says "see `handleFoo` in `foo.ts`" survives routine churn.

**In-template home.** Worker templates (`skills/ludics-draft-proposal-worker.md`, `skills/ludics-elaborate-worker.md`, `skills/ludics-revise-proposal-worker.md`) already carry this principle in rationale-bearing form; this entry exists as the canonical reference point.

### Code-proposal alignment

**Principle.** Before merging independent plans, spot-check the proposal's code assumptions against the actual worktree: APIs exist, signatures match, data structures are as described, file paths are real, dependencies are available, prior-phase code is present.

**Why.** A proposal can be internally consistent and still assume a codebase state that no longer exists. The plan-merge step is the cheapest place to catch this — after both plans are written but before implementation has started.

**Decision rule.** Minor gaps (renamed method, identical behaviour) — document with `⚠️ ASSUMPTION GAP: ...` and proceed. Substantial gaps (missing API or module that would force rework) — reassign to the reviewer with REQUEST_CHANGES.

**In-template home.** `skills/orchestration/pair-coder-plan-merge.md` carries the "Code-Proposal Alignment Check" section. That section is the stylistic target for this doc and for the refactored heavy templates.

### No-regression AC framing

**Principle.** When an acceptance criterion references a repo-wide gate (`bun run lint`, `bun test`), frame it as "no regression from the base branch" rather than "the gate succeeds". Include the measurement recipe.

**Why.** If the base branch already fails the gate, an absolute AC is unfulfillable without out-of-scope work — forcing silent scope creep or a REQUEST_CHANGES loop the implementer can't resolve. Framing by diff-against-base keeps the AC decidable when the gate is noisy.

**Recipe.** Snapshot the baseline from the base branch, apply the change, compare *sets* (not counts):

```sh
# Task changes are normally already committed, so move HEAD — don't stash.
git checkout <base-ref>
<gate> 2>&1 | sort -u > /tmp/before
git checkout <task-branch>
<gate> 2>&1 | sort -u > /tmp/after
diff /tmp/before /tmp/after           # errors introduced vs. removed, not totals
```

`git stash` only toggles *uncommitted* changes — it does not move `HEAD` to the base. If the task's changes are committed (the common case), both runs execute on the same tree and the diff is empty even when the branch regresses. Prefer `git checkout <base-ref>` (or a separate `git worktree add` on the base ref) over stashing.

A matching error count with set drift is still a regression; only the diff tells you which.

### Proposal as traceability home

**Principle.** Traceability artefacts an AC mandates (scan logs, grep outputs, sweep summaries) belong in the proposal's Notes section or the PR body — not in the task file.

**Why.** Coder agents in this harness write to the public project repo but not to the private harness repo that holds task files. An AC that says "record the sweep output in the task file" is unfulfillable from the coder's scope. Landing the artefact in the same PR — where the reviewer can inspect it — preserves the evidence trail while staying inside the coder's write scope.

**What to commit as evidence.** The grep/scan output itself, not just the conclusion drawn from it. "I checked and it's fine" is not traceable; `rg -c '<pattern>' → 0 hits across src/` is.

### Nullable-predicate truth tables

**Principle.** When a branch conditions on a nullable value and the `null` case is deliberate (not "can't happen"), write the truth table as a comment next to the branch.

**Why.** The dangerous case isn't the null one you remembered — it's the `null × other-condition` cell you didn't think about. Writing the table forces enumeration of all cells; reviewers can see which cells the code actually covers.

**Example.** `currentBranch()` in `src/staging-ff.ts` returns `null` on detached HEAD. The fast-forward flow now enumerates the four cells of `(currentBranch ∈ {null, non-null}) × (target-branch match ∈ {true, false})` in a comment next to the branch, and captures a prior-HEAD-SHA so the detached case restores cleanly. The original code quietly assumed `currentBranch` was always a string; the truth table is what would have caught that.

### Template inventory grep

**Principle.** Before writing N new template variants for a new mode or role, grep the existing templates for role/mode tokens to see whether they are already role-agnostic. Reuse via the template fallback chain when they are.

**Example.** Before adding solo-mode templates, task-da8b6dff ran `grep -c "reviewer\|peer" skills/orchestration/pair-coder-<phase>.md` and found that `pr-create`, `update-docs`, and several other phases had zero hits — they were role-agnostic already and fell through the fallback chain without needing a solo override. Expected outcome: 1 new override per mode, not N.

---

## Coding

### CI drift files

**Principle.** Some documented interfaces drift when you edit the code behind them — configuration schemas drift from their reference docs, CLI USAGE strings drift from the README. When you change one side, update the other in the same round so CI can confirm the pair is consistent.

**Why.** CI lints catch drift post-merge, but post-merge is an expensive place to discover the omission. Catching it in the same PR keeps the documentation-as-tested-artifact model intact.

**Known drift pairs (as of 2026-04-22).**

1. `src/config.ts` (config types) ↔ `templates/config.reference.yaml` — enforced by `lint:config-reference` (`scripts/lint-config-reference.ts`).
2. `src/index.ts` USAGE (CLI command listings) ↔ README CLI Reference — enforced by `lint:cli-readme` (`scripts/lint-cli-readme.ts`).

**When not to apply.** If the change is purely internal (renaming a private helper, restructuring a module without exported-surface effects), neither drift pair fires. The principle is "documented interface changed", not "any file changed".

**Extending the list.** When a new lint-enforced doc pairing appears, add the pair here. Templates should point at this heading, not inline the pair.

### Multi-pattern symbol extraction

**Principle.** When extracting a symbol usage that can be written multiple ways in the codebase, union the matches from multiple regex patterns instead of relying on one.

**Why.** A single regex encodes one syntactic convention. The same concept often appears under different conventions — a local variable after a cast, an alternative variable name, an inline cast — and a single-pattern sweep silently misses the variants. The output set is only as complete as its pattern set.

**Worked example.** `extractMagPathsFromSource` in `scripts/lint-config-helpers.ts` (~line 191) extracts first-level `mag` config property accesses. It unions three patterns:

```ts
const p1 = /\bmag\?\.(\w+)/g;          // mag?.prop or (cast)?.prop after local binding
const p2 = /\bmag[A-Z]\w*\?\.(\w+)/g;  // magConfig?.prop, magCfg?.prop
const p3 = /\.mag\b[^;]*?\)\?\.(\w+)/g; // (config.mag as Type)?.prop inline
```

Each pattern alone would miss two of the three access styles. The union catches all three.

**When to stop adding patterns.** When a search of the codebase yields no new variants — i.e., you've enumerated the conventions actually in use, not every convention you can imagine. Speculative patterns bloat the extractor without catching anything real.

### Round-trip serialization fidelity

**Principle.** When changing a serializer or format-compat layer, add a round-trip test: serialize → deserialize → compare key fields. Land this test in the same round as the code change.

**Why.** Silent field omissions are the dominant failure mode for format-compat changes — a field goes missing on the return trip because a migration pass dropped it, or a new field wasn't added to both sides of the pair. Round-trip testing surfaces the asymmetry immediately.

**Minimal test shape.**

```ts
test("TaskEntry round-trips through YAML", () => {
  const original: TaskEntry = { /* all fields populated */ };
  const yaml = serialize(original);
  const restored = deserialize(yaml);
  expect(restored.id).toBe(original.id);
  expect(restored.effort).toBe(original.effort);
  expect(restored.dependencies).toEqual(original.dependencies);
  // ...one assert per field that matters on the return trip
});
```

**When not to apply.** One-way formats (logs, alerts, human-readable reports) don't need round-trip tests because there's no return trip. Asserting the outgoing shape is sufficient.

### Caller audit on signature change

**Principle.** When a function's return type or parameter shape changes, enumerate every caller — including destructuring call sites, casts, and `any`-typed callers — before landing the change.

**Why.** TypeScript catches call sites that use the value the way the type says it should. It misses the rest: destructuring with a default (`const { x = 0 } = foo()`), explicit casts (`foo() as OldShape`), `any`-typed intermediaries, and JSON-round-tripped values that lose their type at the boundary. A signature change lands, the compiler stays green, and the `any`-typed caller silently reads `undefined`.

**What "enumerate" means.**

1. `rg <functionName>` for the function name (all syntactic contexts).
2. For destructuring: scan hits for the property names the function returned — a caller that renames on destructure shows up here.
3. For casts: grep for the old type name alongside the function name.
4. For `any`: if the function's return flows through an `any` anywhere on the call graph, the callers downstream of the `any` need a manual check.

### AC self-check

**Principle.** Before signaling done, walk through each acceptance criterion explicitly and confirm the implementation satisfies it. Record the walk as a visible artifact (a checklist in the work log, a commit message note, the coder status write).

**Why.** AC drift is the long-tail failure mode of the pair-orchestration workflow: the code compiles, tests pass, the plan was followed — and one AC got forgotten between rounds. A visible walk forces the check into an artifact the reviewer can inspect.

**Example walk.** For each AC: `AC1: "round-trip test landed" — present in src/tasks/serialize.test.ts:roundTrip. ✓`. The check names the AC, names the evidence, marks it ✓ or ✗. Nothing fancier is required; the point is that the walk happened and left a trace.

**Invariant vs capability.** Each verification line must name the *invariant* the cited evidence enforces — the property that would fail to hold if the AC were violated — not the *capability* the referenced test or artifact merely exposes. "Serialization coverage confirmed" is a capability claim; the invariant claim names the concrete property that falsifying breaks.

*Before* (capability phrasing): `AC1: "serialization handoff has coverage" — EEXIST check in tests/lock-handoff.test.ts. ✓`. The EEXIST check proves a directory exists; it does not prove the retry-and-acquire handoff ordering.

*After* (invariant phrasing): `AC1: "parent releases before child acquires" — timestamps satisfy childAttemptTs < parentInsideCriticalSectionTs <= childAcquireTs, asserted in tests/lock-handoff.test.ts:handoffOrdering. ✓`. Falsifying the ordering breaks the assertion directly.

The sharpening question is: *what would fail if the AC were violated?* For a test-backed AC, that's an assertion; for a doc or config AC with no mechanical test, it's a structural property — a resolvable anchor, a consumer that still reads the field, a referenced symbol that still exists. If you can't name the falsifier, the evidence is probably only traversing the code path, not enforcing the invariant.

**Side-effect observability.** When an AC refers to a flag or option being passed or honored, the verification line must cite an observable downstream consequence (journal entry, remote-slot side effect, stderr output, exit code) — not the flag's presence in a call signature. A flag that never crosses an observable boundary is unobservable in-test even when the call signature looks correct. Example: `force: true` on `slotStop` is a remote-dispatch flag that is never read by the adapter; "adapter.stop received force:true" is unobservable, but "journal records the force-stop entry" or "remote slot's state file transitions to stopped" is. For flag-shaped ACs, document where the observable boundary is and cite the assertion that lives there.

**Composite evidence.** An AC that needs multiple assertion sources ("round-trip test + config-drift lint both pass") still phrases each element as the invariant that element enforces, not the capability it demonstrates. One line per element, each naming the invariant and the assertion; the composite is then the conjunction of invariants.

**Boundary.** The self-check is unconditional on proposal presence — tasks without a proposal still have an AC list in the task spec, and the walk applies there too.

### Harness instantiation

**Principle.** Every AC outcome — positive *and* negative — needs a test whose harness setup actually produces the condition the AC's wording targets. A test that never produces that condition cannot enforce the AC, no matter how invariant-phrased the verification line is.

**Why.** [AC self-check](#ac-self-check)'s `**Invariant vs capability.**` rule fixes the *phrasing* of the verification line. This rule closes the loop on the *test setup*: even an invariant-phrased line is vacuous if the harness never instantiates the case the invariant talks about. The two together — invariant phrasing plus harness instantiation — are what makes an AC line enforceable.

**Two AC shapes covered.**

1. **Negative-path** (`silently skips on X`, `no-ops when Y`). The harness must make X / Y *actually happen* during the test, and the assertion must measure what the AC forbids — not what it permits. A "silently-skips-on-X" AC needs a test that fails iff X is ignored, not a test that fails iff X blocks.
2. **N-outcome enumeration** (`returns A in case 1, B in case 2, …`). Each outcome needs a test whose harness instantiates *that* case. Neighbouring tests that traverse other branches do not bracket it; the no-self/no-leader fall-through, the absent-flag default, the empty-set return value all need their own assertion.

**Falsifier framing.** Ask: *what harness condition would I have to remove for this test to fail?* If the answer is `none` or `the assertion itself`, the test is vacuous on that AC line. This is the *dual* of the existing invariant-falsifier question (`what would fail if the AC were violated?`) — together they describe both sides of an enforceable AC line.

**Distinction from `**Invariant vs capability.**`.** Invariant phrasing is about how the verification *line* reads. Harness instantiation is about whether the test *setup* actually produces the case the invariant talks about. A line can be invariant-phrased and still vacuous if the setup never makes the relevant condition occur.

**Worked example (before / after).** From task-91667552 (stale-base warning). The AC said the warning skips on `git fetch` failure.

*Before* (capability-only setup, vacuous): `makeGitRepo` seeded `refs/remotes/origin/main` via `git update-ref` but never configured a fetchable origin URL. `git fetch origin main` failed with exit 128 in *every* test. The "skips on fetch failure" AC was vacuous: positive-path tests "passed" by measuring against cached refs after an *ignored* fetch failure; the code under review never read `fetched.exitCode`. The harness condition the AC needed (a *successful* fetch on the positive path) was not instantiated; the harness condition for the negative path (a *failed* fetch the code skips on) was instantiated for the wrong reason.

*After* (harness instantiates the case): an `addRealOrigin` helper configures a real bare `file://` origin and pushes, so the positive-path fetch actually succeeds; a separate broken-URL regression test asserts `countWarnings === 0` AND `staleBaseLastWarnedCount === undefined` when the fetch genuinely fails. Each test names the harness condition (`origin URL is fetchable` vs. `origin URL is broken`) the AC outcome depends on. Removing either harness condition would now flip the corresponding assertion.

**Boundary.** Applies to ACs whose evidence is a test or other executable check. Purely architectural ACs (`does not break X`) fall under the existing falsifier framing in [AC self-check](#ac-self-check). Doc/config ACs apply by analogy: the "harness condition" for a doc AC is the consumer that would break if the structural property were absent (an unresolvable anchor, a removed reader, a renamed symbol).

See also [negative-case-regression-testing](#negative-case-regression-testing) (the *dynamic* version of this discipline — deliberately break the behaviour and watch the test fail), [collapsed-branch-negative-tests](#collapsed-branch-negative-tests) (negative assertions for removed branches), and [ac-self-check](#ac-self-check) (the invariant-vs-capability rule this complements).

### Bail-out contract

**Principle.** When a task turns out to be already resolved on the base branch (upstream fix merged, no meaningful work left), don't make empty commits — signal bail-out instead. The reviewer independently verifies and confirms.

**Why.** Empty commits waste a full orchestration round and pollute git history. The bail-out contract lets both sides acknowledge the no-op cleanly.

**Coder shell block.**

```sh
printf 'bail-out|%s|<describe why task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

**Reviewer confirmation shell block.** If the reviewer agrees the task is obsolete (verified against the base branch):

```sh
printf 'bail-out-confirmed|%s|<describe why you agree task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

If the reviewer disagrees, they write `REQUEST_CHANGES` in the review file and explain what's still needed.

**When to bail vs finish normally.** Bail-out is for tasks where there is genuinely nothing to do — the fix landed elsewhere, the feature was superseded, the bug no longer reproduces. A partially-done task still finishes normally.

### Escalation contract

**Principle.** When an agent believes it's stuck in a contradictory or looping situation that ordinary progress can't escape — the reviewer keeps reversing on unchanged work, a parser misread keeps inverting the verdict, contradictory instructions in the spec can't be reconciled — it raises its hand with `bail-out: escalate`. The runner halts at the current phase without discarding work, flags the slot, and notifies Mag/the user. The human inspects the situation, applies a manual fix, and resumes via `ludics slot N resume` — the same command that recovers an interrupted slot.

**Why.** Round-count loop-detection is brittle (legitimate merge-round churn, plan-merge iterations, genuine disagreement-driven work cycles all trip a threshold) and fires late — N rounds of wasted agent time before the guardrail notices. Agents see the content (identical reviews, same coder output, contradictory reviewer guidance) and can detect the trap faster than any external counter. See task-4cd94043 and gh-ludics-310 (the 9-round loop that motivated this).

**Distinction from bail-out.** `bail-out` means *done, no work needed* — the phase advances to done. `escalate` means *not done, need a human* — the phase does NOT advance. Both are resumable; bail-out resumes as "next task," escalate resumes as "pick up where the agent raised its hand."

**Distinction from `interrupted`.** `interrupted` is a framework failure (setup error, orchestrator crash) — a passive signal. `escalated` is an agent-initiated collaborative ask — active signal. Both are cleared by the same `ludics slot N resume` command, but they preserve different provenance for retrospectives.

**Shell block (coder, reviewer, or solo coder — unilateral; no handshake needed).**

```sh
printf 'escalate|%s|<one-sentence reason>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

**Reason field.** Non-empty is strongly encouraged but not required. An empty reason is accepted (to avoid blocking the very escape hatch the action is meant to enable); the notification reads "(no reason provided)" and a warning is logged.

**What the runner does.** For each agent whose `.status` starts with `escalate`, emit an `escalation_requested` event with `{slot, task, phase, agent, reason}`. Fire a priority-5 `ludics notify outgoing` summarizing all raisers. Flip the slot's `liveness` to `"escalated"`. Persist state before and after the slot-json flip so a mid-halt crash leaves a consistent record. Return cleanly from `runOrchestration` — do **not** break (the outer loop would advance phase).

**What Mag does.** Nothing. Mag's auto-start / auto-unstick paths skip slots with `liveness === "escalated"` the same way they skip `"interrupted"`. Only explicit user action clears the marker.

**Resolution.** User reads the notification + peer-sync artifacts + PR state, applies whatever fix is needed (edit a review file, patch the code, `ludics orch skip`, etc.), then runs `ludics slot N resume`. Resume clears liveness back to `null` and re-enters the orchestrator at the preserved phase/round.

**When to use.** Primary triggers are (a) "I've had nothing meaningful to do for 2–3 rounds on unchanged input" (coder observing a no-op loop), (b) "the review content hasn't meaningfully changed across rounds on unchanged coder output" (reviewer observing the same loop from the other side), (c) "the instructions or environment contradict themselves and I can't pick a path." Do **not** use it for: recoverable review/work disagreement (use normal review/work-round channels), tasks that are genuinely done (use bail-out), legitimate multi-round churn (the point of multi-round is iteration).

### Injectable subprocess runners

**Principle.** When code reaches for `Bun.spawnSync` / `child_process`, accept an injectable runner type — `type RunGit = (args: string[], cwd: string) => RunGitResult` — with a production shim (`defaultRunGit`) and a test-side fake.

**Why.** Direct `spawnSync` calls force tests to either (a) build a real temp repo, which is slow and brittle, or (b) mock the global, which leaks across tests. An injected runner lets the test pass a `fakeGit(rules)` helper that dispatches on `args[0]` / `args[1]` and returns synthetic output — unit tests run in milliseconds against exact byte sequences.

**Worked example.** `src/briefing-lag.ts` exports `RunGit` and `defaultRunGit`; consumers in `src/staging-ff.ts` thread the runner through `hasRemote`, `worktreeClean`, `currentBranch`, `commitCount`. `src/briefing-lag.test.ts` and `src/staging-ff.test.ts` use `fakeGit(rules)` to cover 19+ cases without touching a real repo.

**When not to apply.** For one-shot scripts where the subprocess call runs once at startup and the output is logged rather than branched on, inlining `spawnSync` is fine — the injection only earns its keep when a test wants to vary subprocess output.

### Collapsed-branch negative tests

**Principle.** When collapsing an N-way split into unified handling, write N positive tests for the unified path AND one negative test asserting the removed branches' artifacts (events, writes, log lines, notifies) are absent.

**Why.** The positive tests pass when the unified handling is correct; they don't catch a rogue `emit("old-event")` that survived the collapse. The negative test — asserting the old emit is *not* produced — closes the gap.

**Recipe.** Before the change, `grep -n 'emit\|write\|notify' <files-being-simplified>` over every branch that will be removed. Each unique side-effect name becomes a negative assertion. Example: `src/staging-ff.test.ts` captures `emitEvent` calls and asserts the collapsed upstream-workflow branch produces none of the stale-event names that lived in the three pre-merge paths (commit `12e2fca`, PR #331).

See also [regression-test-per-behaviour-change](#regression-test-per-behaviour-change).

### rev-list direction comment

**Principle.** Every `git rev-list --left-right --count A...B` call site carries a one-line comment documenting which side means what.

**Why.** The `--left-right` output order follows the order of refs in the revision range, and that ref order is easy to flip-flop in a refactor. Without a comment next to the call, future readers have to re-derive the mapping from `git-rev-list`(1) every time.

**Recipe.** `src/briefing-lag.ts::parseLeftRightCount` parses `upstream/<u>...origin/<o>`; the comment in `src/briefing-lag.test.ts` records `left=behind-upstream, right=ahead-of-upstream`. That pair of words is enough context to re-derive the interpretation at any call site.

### Retained extension points need tests

**Principle.** A parameter or flag kept "for future use" gets a synthetic-consumer test that proves the override mechanism still functions. The test is the format contract the extension point commits to.

**Why.** "Kept for future use" parameters rot silently — the code path sits untested, the intended consumer never arrives, and the next refactor simplifies the branch away. A synthetic consumer exercised in tests keeps the path alive and documents what a real future consumer would look like.

**Worked example.** `resolveTemplatePath(phase, mode, role, hasUpstream?)` in `src/orchestration/skills.ts` checks `pair-<role>-upstream-<phase>.md` then `upstream-<phase>.md` when `hasUpstream` is truthy. The test in `src/orchestration/skills.test.ts` writes a temp `upstream-update-docs.md` and asserts `hasUpstream=true` resolves to the override while `false` falls back.

**When not to apply.** If the extension point's consumer shape isn't known yet (a plugin hook whose interface is speculative), a synthetic test may encode a wrong shape the real consumer later has to break. Label the extension as speculative and skip the test instead.

See also [regression-test-per-behaviour-change](#regression-test-per-behaviour-change), [ac-self-check](#ac-self-check).

### Top-level dispatch

**Principle.** When adding a new mode or variant to a state machine, dispatch at the top — `if (state.mode === "solo") return evaluateTransitionSolo(state);` — rather than sprinkling `if (solo) …` into each case body.

**Why.** Per-case short-circuits spray the new mode's logic across the existing switch, maximising merge conflicts with concurrent edits to the base cases and making the new mode hard to read in one place. A top-level dispatch has a small, mechanical blast radius: existing cases don't change, and the new mode lives in one function the reader can reach for by name.

**Worked example.** `task-da8b6dff` added solo-mode transitions by introducing an `evaluateTransitionSolo` dispatch at the top of `evaluateTransition`. Pair and duo cases are untouched; merges against concurrent case edits were mechanical.

**When not to apply.** If the new mode genuinely interacts with every existing case (shared setup, shared post-processing that legitimately differs per case), the per-case approach may be unavoidable. Top-level dispatch works best when the new mode is orthogonal to existing cases.

### Flag-name-keyed rejection

**Principle.** When a CLI parser rejects flags based on mode (e.g., reviewer-only flags in solo mode), track the offending flag *by name* — `offendingFlag: string | null`, set to the flag string on first encounter — not by inferring from whether a resulting variable was assigned.

**Why.** Shared flags (`--effort`) and role-specific flags (`--reviewer-effort`) often assign the same underlying variable. Variable-state inference after parsing ("was `reviewerEffort` set?") silently drops role-specific flags whose value happened to equal a default or was overwritten by a subsequent shared flag. Rejection must be keyed on *which flag was provided*, with an error message naming the offending flag so the caller knows which invocation-site to fix.

**Worked pattern.** `parseOrchestrationAdapterArgs` in `src/adapters/t3code.ts` uses `reviewerOnlyFlag: string | null`, set to the flag name the first time a reviewer-only flag is parsed. At the mode-gate, a non-null `reviewerOnlyFlag` in solo mode produces an error like `--reviewer-effort is not accepted in solo mode`. The error text carries the flag string, not a derived concept like "reviewer override".

See also [caller-audit-on-signature-change](#caller-audit-on-signature-change).

### Negative-case regression testing

**Principle.** After writing a regression test, run it once with the target behaviour deliberately broken to confirm the test *can* fail — then revert the break. A test that has never failed is unproven.

**Why.** A regression test that passes on first run could be passing for the wrong reason: a typo in the assertion, a fixture that doesn't exercise the path, a regex that silently skips the broken input. The stress-test proves the test is sensitive to the behaviour it claims to cover.

**Recipe.**

1. Write the regression test; confirm it passes against current code.
2. Break the behaviour under test (flip a boolean, null a value, delete an anchor, change a character class in the regex — whatever the test is checking).
3. Re-run the test. It must fail.
4. Revert the break; re-run; it passes again.

**Example.** `task-21b4c850`'s doc-link slug-resolution test passed round 1 but had two real bugs (phantom `##` anchors counted inside fenced code blocks; `[a-z0-9-]+` silently skipping malformed anchors). Both would have been caught by deliberately adding a link to a non-existent anchor, watching the test fail, then reverting.

See also [regression-test-per-behaviour-change](#regression-test-per-behaviour-change).

### Pre-assertion harness probe

**Principle.** When an AC's passing condition is a property of *the world* (the live template set, the real config tree, the actual filesystem) rather than a unit-level invariant, run a one-liner probe (`bun -e`, `bun --print`, `rg`, ad-hoc grep) against the live target *before* drafting the assertion. Print every would-fail item with debug context; only then build the assertion against a known target.

**Why.** Meta-tests like `this lint passes against the entire template set` are written at the level of *the world*, not at the level of one fixture. A speculative assertion about the world's state surfaces missing harness pieces only at test-run time, when the cost of fixing them is highest. A cheap upfront enumeration moves that surprise to plan time and lets the validator be shaped against real cases instead of imagined ones.

**Recipe.**

1. Identify the world the assertion targets (template set, config catalogue, fixture directory tree, generated file list).
2. Write a one-liner that walks the world and prints every item the assertion would judge — *every* item, with debug context, not just a count.
3. Decide what `pass` means based on the enumeration: which items belong, which don't, what shape the validator must learn to handle.
4. Write the assertion against the now-known target.

**Worked example.** From task-b435e58d (lint-template-safety): before drafting the meta-test for the env-stripper, the coder ran a `bun --print` script over `skills/orchestration/*.md` to enumerate first-tokens unknown to the parser. The probe surfaced `PR_URL=$(cat ...)` and `BASE=$(gh pr view ...)` cases — env-stripper gaps fixable *before* the assertion was written. Without the probe, the test would have been written, would have failed against the real world, and the gaps would have been diagnosed mid-test-debug instead of at plan time.

**When not to apply.** Trivial unit assertions (a function's return value for a literal input) don't need a probe — the world is the function and you can read it. ACs whose passing condition is a unit invariant rather than a property of external state likewise don't qualify. The probe earns its keep when the assertion is integration- or meta-flavoured, where the *target set* is what you're least sure about.

See also [negative-case-regression-testing](#negative-case-regression-testing) (the post-test stress check — same family, opposite end of the timeline) and [harness-instantiation](#harness-instantiation) (the AC-side companion: name the condition the assertion depends on).

---

## Reviewing

### Baseline cross-check reviewer

**Principle.** The reviewer runs `bun test` independently from their own worktree and compares the failure set against the coder's `## Pre-existing test failures (baseline)`. Mismatches usually indicate different merge bases; investigate before concluding the coder introduced a regression.

**Why.** A "new failure" that's actually pre-existing-but-visible-on-the-reviewer-base-only is a false alarm. A "pre-existing failure" that's actually introduced-by-the-coder's-branch is a missed regression. The cross-check distinguishes the two by making both sides' test runs observable.

**Procedure.**

1. Run `bun test` from the reviewer's worktree.
2. Diff against the coder's baseline.
3. Failures in both sets — pre-existing, non-blocking (unless AC calls for fixing them).
4. Failures only in the reviewer's set — investigate whether the merge bases differ; if they don't, this is a regression.
5. Failures only in the coder's baseline — investigate whether the coder's worktree has stale state; if not, the reviewer's merge base may be ahead.

**In-template home.** `skills/orchestration/pair-reviewer-gather.md` already carries the one-line principle ("mismatches usually come from different merge bases"). This entry exists as the decision-support expansion.

### Re-run reviewer repro

**Principle.** When the reviewer files a contract bug at a specific invocation (`parseOrchestrationAdapterArgs(<exact args>)`, `curl <exact URL>`, `bun run <exact script>`), the round-N+1 fix re-runs *that exact invocation* in addition to any new unit test.

**Why.** A new unit test encodes the author's interpretation of the bug. The reviewer's repro is the contract the author might have misread. Running both closes the interpretation gap: if the unit test passes but the reviewer's repro still fails, the fix targeted the wrong thing.

**Procedure.** Paste the reviewer's repro command into the work log, re-run it after the fix, and record the output alongside the unit-test result. Both must be green before signaling done.

### Cross-merge-round gap detection

**Principle.** Expect merge review to surface real gaps across multiple iterations; don't try to preempt them all in one pass. Treat the reviewer's grep anchors as reusable audit tools for the next similar change.

**Why.** Mode additions, schema migrations, and template-family expansions have surface area that isn't obvious from the primary diff. A reviewer running `rg -n '<well-chosen pattern>'` routinely finds a second call site, a doc enumeration, a fallback-order assumption — none of which a single coder-side pass reliably catches. Planning for N rounds rather than trying to ship N+0 rounds keeps the cycle honest.

**Example.** `task-da8b6dff` went through four merge iterations (merged-0 → merged-3). Each surfaced a real gap: tmux-adapter help text, `docs/ARCHITECTURE.md` enumerations, template fallback order, a second call site to `runner.ts::isPairBailedOut`. The reviewer's `rg -n 'mode: "duo" \| "pair"' docs` became a reusable audit tool for subsequent mode work.

### Post-edit occurrence recheck

**Principle.** After migrating N occurrences of pattern A to pattern B, run *both* greps: (a) `grep A` to confirm only expected residue remains (server endpoints, test guards), and (b) inverse `grep B` to audit the new sites for consistency. State the expected match set for both directions in the plan.

**Why.** The forward direction (residue check) catches sites the migration missed. The inverse direction (consistency check) catches sites where the migration landed but picked different escape/helper choices than its siblings — half-migrated patterns that compile, pass the local tests, but diverge stylistically or semantically from the rest of the new cohort.

**Recipe.**

1. Before the edit, enumerate `grep A` occurrences in the plan with dispositions (see [exhaustive-occurrence-search](#exhaustive-occurrence-search)).
2. After the edit, re-run `grep A` — confirm each remaining hit is on the expected residue list.
3. Also run `grep B` — inspect each hit for consistency (same escape helper? same encoding? same error handling?).
4. Diverged hits in step 3 are either half-migrated or genuine variants — the plan's expected match set disambiguates which.

**Example.** `task-c5937037`'s `task-files/` → `task.html?task=` migration touched three `dashboard.js` patterns and one `dashboard.ts` line. The inverse grep for `task.html?task=` caught an encoding inconsistency where one site used `encodeURIComponent` while the others used `escapeHtml` — the kind of half-migration the forward-direction grep doesn't see.

See also [exhaustive-occurrence-search](#exhaustive-occurrence-search). See also [patterncount-enumeration-for-bulk-migrations](#patterncount-enumeration-for-bulk-migrations) for the proposal-time enumeration that drives the post-edit recheck.
