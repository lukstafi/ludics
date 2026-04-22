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

**Boundary.** If the symbol is a primitive name collision (`type`, `handle`, `data`), the sweep is noisy and probably useless — swap the approach to "search for the specific call signature" or "search for the import path". The principle is exhaustiveness, not blind greps.

### Data-shape consumer sweep

**Principle.** When a task changes data shapes — field extraction, JSON migration, section restructuring, type-signature changes — list every downstream consumer in the plan with a note on whether it needs updating.

**Why.** Shape changes silently break downstream code in ways TypeScript doesn't catch: destructuring with a default, `any`-typed call sites, sections read positionally from free text, round-tripped JSON that drops fields. The failures show up later, in a different context, as data-loss rather than a type error.

**What counts as a consumer.** Anything that reads the shape: direct accessors, destructuring, JSON parsers, template renderers, tests, fixtures, log-format regexes, dashboard displays. Grep the field name, the section header, the type name — all three, because any one of them can be the only mention.

**Example.** A plan adding an `effort` field to `TaskEntry` lists: the YAML parser, the serializer, the briefing renderer, the dashboard column, the `lint:config-reference` fixtures, every test that constructs a `TaskEntry` literal. Each gets a disposition.

### Regression test per behaviour change

**Principle.** Each behaviour change this round needs a regression test named in the plan and landed in the **first implementation round**, not deferred to a follow-up.

**Why.** Deferred tests drift to abandonment. By the time a follow-up round happens, the original authors have moved on, the test's motivation has faded, and a later refactor breaks the uncovered behaviour without anything noticing.

**Common triggers.**

1. Changed serialization → a round-trip test (see [round-trip serialization fidelity](#round-trip-serialization-fidelity)).
2. New or changed template rendering → a test that exercises the new variable or output branch.
3. Modified validation → tests covering the new rule and its edge cases.
4. New CLI output or changed log line → a test asserting the exact string (or a shape-stable regex).

**When not to apply.** A pure refactor that doesn't change observable behaviour doesn't need a new regression test — the existing tests are the coverage. The judgment call is "did I change what a caller can observe?", not "did I change any code?"

### Wide table avoidance

**Principle.** Use numbered lists for structured data in plans and reviews. Avoid wide markdown tables.

**Why.** Agent-to-agent handoffs render templates through intermediaries that truncate wide tables, losing right-hand columns silently. Numbered lists survive the handoff because they reflow.

**When a table is still fine.** Narrow tables (2–3 short columns) render reliably. Reach for a table when the tabular structure is genuinely the point; reach for a list when the columns are a formatting accident.

### Scope declaration and salvage

**Principle.** Declare out-of-scope files in the plan and in the commit message. When something useful lands but falls outside the declared scope, salvage it into a needs-confirmation follow-up rather than expanding the current round or silently dropping it.

**Why.** Scope creep is corrosive to the plan-merge cycle: the reviewer's plan and the coder's plan can't be reconciled if either side is free to widen the field. A declared scope gives both sides a shared boundary; the salvage path gives useful incidental work a home without blowing the boundary.

**Reviewer discretion.** The reviewer can accept a small out-of-scope fix if it's genuinely incidental (a typo touched by a move, an obvious import reorder). They should REQUEST_CHANGES if the declaration was missing or the "salvage" is substantive enough that it needed its own plan.

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

**Boundary.** The self-check is unconditional on proposal presence — tasks without a proposal still have an AC list in the task spec, and the walk applies there too.

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
