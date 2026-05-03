# AC verification rigor

Reference documentation for writing and verifying acceptance criteria (ACs) on tasks whose contract is unusually heavy. Each section captures one durable learning from a reviewer round where an AC line passed mechanically while still failing to enforce the property the AC named. The doc is project-agnostic: workers consult it when the AC ledger calls for extra rigor, then return to the task at hand.

This doc grows over time. Today it covers sixteen clauses across five thematic families; further reviewer-flagged learnings (closed-set / cardinality probes, and others) are expected to land as additional `### ` subsections under the same families or new sibling families.

→ See also: [`orchestration-patterns.md` § AC self-check](orchestration-patterns.md#ac-self-check) for the *invariant-vs-capability* phrasing rule, and [`orchestration-patterns.md` § Harness instantiation](orchestration-patterns.md#harness-instantiation) for the *falsifier-framing* rule. The two together describe both sides of an enforceable AC line; the clauses below extend them to specific recurring failure modes.

**Vocabulary.** The doc uses three terms in the same sense as the cross-linked sections above. **AC** — an acceptance criterion: one bullet on the proposal's contract list, named by an invariant the implementation must satisfy. **Harness condition** — the concrete setup state that makes a verification probe (test, grep, file read) actually exercise the AC's case rather than merely traversing the surrounding code path; a test that passes whether or not the harness condition holds does not enforce its AC. **Falsifier** — the answer to *what would fail if the AC were violated?* For a test-backed AC, that's the assertion line that flips; for a doc/config AC, it's the structural property (a resolvable anchor, a consumer that still reads the field, a referenced symbol that still exists) whose absence the AC is asserting against.

**Thematic table of contents.** [Vacuous-harness family](#vacuous-harness-family) — assertions that traverse but don't enforce. [Proposal-as-canonical family](#proposal-as-canonical-family) — the proposal is the contract; the task file isn't. [Falsifier-shape family](#falsifier-shape-family) — picking a probe whose negative outcome is reachable by violating the AC. [Verification-evidence family](#verification-evidence-family) — evidence must survive the commit boundary. [Baseline-aware framing family](#baseline-aware-framing-family) — gate-passing ACs need no-regression framing when the baseline is red.

## Vacuous-harness family

The shared rule: an AC verification line is vacuous when the only edit needed to falsify it is the assertion sentence itself. The harness condition must be paired with a probe that reads the artifact the AC names — whether that artifact is a journal file, a rendered string, or a doc heading.

### Vacuous test harness — assert on the artifact the AC names

A test that traverses an AC's code path doesn't enforce its invariant. The harness condition must be paired with an assertion that reads the artifact the AC names — the journal file, the rendered output, the on-disk state — not just "the surrounding code path runs." If removing the assertion is the only edit needed to falsify the AC, the test is vacuous on that AC line. Pair every invariant-phrased verification line with an assertion whose negative outcome is reachable by *violating the AC*, not by *editing the test*.

### Stash-prod mutation test — confirm your new test actually falsifies

A regression test that traverses the production change without enforcing it is vacuous on its own AC: it passes whether or not the production fix is present. Mutation-test the new regression test by stashing the production change — `git stash push -- <production-file>` reverts only the lint/bug fix while leaving the new test in place; the test runner (`bun test`, `pytest`, whatever) then surfaces the assertion that fires under regression, and `git stash pop` restores in one step. This beats editing the test fixture or temporarily breaking the production code in-place — cheaper, less error-prone, and robust to multi-file stash sets when scoped via the path argument. Same toolset as the **No-regression framing when the gate baseline is red** clause (Baseline-aware framing family) but a distinct probe: stash-and-rerun answers *"is this failure pre-existing in main?"*, while stash-prod answers *"does my new test actually exercise my new code?"* — a reader landing on either clause should follow the cross-link to find the other. The clause body itself names the literal `git stash push --` command form so a verification probe can assert this clause is non-stub — the kind of mutation-testable assertion the clause prescribes.

### Vacuous doc/config harness — same rule, doc artifacts

The vacuous-harness rule applies equally to doc and config-shape ACs. Verification lines like "a reader can identify all five elements" or "removing the heading would break the entry" are vacuous: the only edit needed to falsify them is the assertion sentence itself. The non-vacuous shape for a doc AC is a concrete `body.includes("<literal>")` or `grep -F` check whose `false` outcome is naturally produced by removing the AC's required content. Every AC verification line — even for doc artifacts — must name a probe whose negative outcome is reachable by *violating the AC*, not by *editing the verification sentence*.

### Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'

A probe that runs after the implementation's automatic cleanup completes — SIGINT handler, atexit, defer, finally — is vacuous on the runtime artefact: it returns the same empty/missing result whether the AC was honoured or violated. Run probes against runtime state (filesystem entries, processes, ports) *before cleanup* fires, so the negative outcome distinguishes "AC violated" from "cleanup raced ahead." When cleanup is automatic, add a `--keep` flag, a debugger pause, or run the probe inside the implementation's own lifetime (a child process that probes then signals the parent). This extends the doc/config-harness clause to runtime-cleanup state — same shape failure: the assertion's `false` outcome must be reachable by violating the AC, not produced unconditionally by the harness.

## Proposal-as-canonical family

When the task file and the elaborated proposal disagree, the proposal is the contract. AC verification walks the proposal's bullets, and a probe that contradicts an AC's literal text is a request to revise the proposal — not a license to amend the contract from the verification narrative.

### Proposal beats task file when AC counts diverge

AC verification walks the *proposal*, not the *task file*. When the two diverge in AC count, the proposal wins — it resolves elaboration ambiguities the task-file bullet may have lumped or dropped. Before writing the AC verification section, count the AC bullets in the proposal file and use that number as the section's checklist length. A missing AC entry blocks the round even when the implementation is correct.

### Self-contradicting AC literal probe — revise the AC, not the verification narrative

When an AC's literal probe ("removing branch X makes test Y fail") is empirically a no-op because the world doesn't exercise X, revise the AC text in the proposal — don't substitute a proxy probe in the verification narrative. Substituting a proxy in workflow-feedback looks like AC verification but is actually doing AC-revision in a place reviewers can't see as a change. If you would have to write "the AC's literal text is unsatisfiable" in your verification line, edit the proposal AC instead — the proposal is the contract; the verification narrative isn't a side channel for amending it. Revising in the same PR keeps the contract honest and the review surface visible.

## Falsifier-shape family

The shared rule: pick a probe whose negative outcome is naturally produced by violating the AC, and decompose multi-element ACs so each element has its own falsifier. Literal-grep ACs, enumerated-element ACs, byte-pinned assertions on rendered output, and prose-only templates each fail this shape in characteristic ways.

### Literal-grep AC — relocate the literal, don't keep it under a new rule

When an AC's verifier is a literal `grep -F` against a target file, *any* match in that file falsifies the AC — even if the surviving occurrence is the rule that supersedes the legacy use sites. The reviewer reads the AC as written; "the four call sites are gone" is a paraphrase, not the contract. Build the replacement so the literal lives in a different file, or relocate it via a helper whose import surface the AC's grep doesn't traverse. Reread the AC's verify step verbatim before signalling done.

### Per-element assertions for enumerated-element ACs

"Failure message names X, Y, Z" ACs need one toContain per element, not one composite assertion. A single composite check passes even if a required element is silently dropped; separate `toContain` clauses — one per required element — guarantee that dropping any element fails a specific, named assertion. The required elements aren't a set, they're a checklist; the assertion shape should reflect that. Composite regexes also tend to false-pass on whitespace-and-ordering changes humans would consider regressions.

### Byte-pinned assertions on rendered or normalised output

Byte-identity assertions are an unmarked contract surface that migrations and library bumps will violate. Tests that interpolate a runtime field into a literal-string equality — `toBe` (not `toContain`) on a template like `${runtime.statusEpoch}|...`, regex with HTML attribute order baked in, RGB literals from a proposal the implementation switched to CSS variables — pin byte-identity by construction and break across whatever boundary the migration straddles. When the AC's harness asserts on rendered or normalised output, decompose by property (per-attribute presence, per-field invariant) rather than by per-byte equality. After a migration, re-grep the *output format* the touched helper produces, not just its call sites.

### Prose-only template instructions are unverifiable

AC-bearing side effects must appear as actual shell commands in the rendered template, not as agent-readable prose. When an AC asserts a side effect (file written, marker created, env var set), the side effect must appear as a *shell command* in the rendered template; agent-readable prose ("On success, create `{{MARKER}}`") cannot be pinned by a string-match test, so a regression in agent behaviour slips past CI. Default to encoding AC-bearing side effects as actual shell commands inside the same fenced block as their precondition; reserve prose for context the agent is expected to *interpret*, not *execute*. Tests then assert against the rendered template via literal-string match (`toContain('touch "...MARKER..."')`) rather than fuzzy "the agent should do this" verification.

### Time-since-X ACs need two boundary fixtures

A `time-since-X` AC ("quiet > N seconds resets the counter", "throttle when last action < N seconds ago") whose verification seeds a single timestamp passes vacuously whenever a *different* candidate timestamp would also satisfy the gate. The harness condition has to distinguish the AC's named timestamp from any plausible single-timestamp mutation. Worked example: a "quiet > 5 min resets the restart counter" test seeded `firstRestartAt = now - 301s` and asserted the reset, but the gate was meant to read `now - lastRestartAt > 300s` — the test passed under both the correct gate (with legacy-record fallback to `firstRestartAt`) and the buggy gate (gating on `firstRestartAt` directly), because the two timestamps coincided in the fixture. The reviewer caught it only by hand-writing a falsifier with `firstRestartAt` and `lastRestartAt` set to *different* values. Diff-anchor: any test for `now - X > N` must have a sibling test where the OTHER plausible timestamp would also satisfy the gate but `X` does not — two fixtures, two diverging timestamps, only the AC's named timestamp drives the assertion.

### 'X unchanged' ACs need structural snapshot, not single-field check

When an AC asserts that a structured record (slot JSON, config file, persisted state) is unchanged by an operation, snapshot the bytes of the whole record before the call and assert byte-identity afterwards — a single-field assertion like `expect(readSlotJson(1).task).toBe(...)` leaves every sibling field unprotected, so a regression that mutates `process`, `liveness`, or `session` while preserving the named field passes silently. Worked example from `task-ad39a394` round 2: the slot JSON harness captures `const slotBefore = readFileSync(slotFile, "utf-8")` before the operation, then asserts `expect(readFileSync(slotFile, "utf-8")).toBe(slotBefore)` after, with the fixture seeded so the byte-identity check actually bites. The "populate non-default values" sub-rule is non-optional: the harness must seed non-default values for the unnamed sibling fields (e.g., `process: "tmux:s1"`, `liveness: "alive"`, `session: "sess-..."`), because a snapshot of a default/empty record is vacuous on those fields by coincidence. This clause is compatible — not contradictory — with **Byte-pinned assertions on rendered or normalised output**: byte-identity is the *right* shape for persisted state files whose contract is *no field changed*, while the byte-pinned warning targets *rendered output* whose format an unrelated library bump or template migration will violate (different artifacts, different invariants, both clauses simultaneously hold). Caveat: byte-identity is sensitive to serialiser key order, so round-trip through a canonical `JSON.stringify` if the artifact's writer doesn't pin order; if a field is *expected* to update (a `lastModified` timestamp, a monotonic counter), exclude it from the snapshot via a normalised projection or freeze it before the operation.

### Literal paths in ACs are literal — don't substitute the platform abstraction

When an AC names a specific filesystem path (`/tmp/...`, `~/.config/...`, `/var/log/...`), treat the literal as a contract surface, not a hint. Substituting a "portable" temp helper — `mkdtempSync(join(tmpdir(), "..."))`, `os.tmpdir()`, `process.env.TMPDIR` — coincides with `/tmp/` on Linux but resolves to `/var/folders/<user>/<random>/T/...` on macOS, so the AC silently fails one platform while passing the other. Before signalling done, grep the implementation for `tmpdir`, `os.tmpdir`, or any `path.join` wrapping a portable temp helper; any hit against the AC's literal-path prefix is a divergence. Use `mkdtempSync("<literal-prefix>")` with the AC's literal prefix instead, so the cross-platform behaviour matches the contract verbatim.

## Verification-evidence family

Verification evidence is read by the reviewer *after* the commit lands. Evidence formats that depend on the working tree (bare `git diff`, transient `/tmp/` paths) silently go empty once the work is committed.

### AC verification evidence must survive the commit boundary

AC verification evidence must survive the commit boundary — citing bare `git diff` (no range) or `git diff HEAD` reads as "diff against the working tree" and goes empty once the change is committed. The reviewer reads the ledger after the commit lands, so pre-commit-only evidence stops instantiating its claim. Use either a symmetric `git diff main...HEAD -- <paths>` cross-check (stable across rebases of the topic branch) or line-numbered direct source reads on the post-commit tree (`file.ts:LINE` with the structural property quoted). An AC line citing bare `git diff` is a *form* defect (re-derive evidence) rather than an *implementation* defect — don't issue REQUEST_CHANGES on the underlying code if the assertion still holds via another harness.

### Diff-enumerated verification lines go stale — anchor to invariants, not snapshots

AC verification entries that enumerate observable artefacts (file lists, line counts, test counts, commit lists) are diff-coupled — they must be refreshed in the same turn as any commit that changes the things they enumerate. A verification line like "no edits to any test file" or "five files in diff" is correct at the moment it's written and silently wrong after the next commit lands a sibling test file or refactors a hunk. Anchor each verification line to the AC's invariant ("no `src/` paths in diff", "no pre-existing test files modified") rather than to a snapshot of the file list at that moment. The invariant is stable across rounds; the file list isn't, and a stale enumeration reads as evidence that no longer instantiates its claim.

## Baseline-aware framing family

When an AC names a repo-wide gate but the base branch is already red on that gate, "gate passes" is unsatisfiable by any task smaller than "fix all the debt." The framing has to shift to no-regression-from-baseline; the verification has to count errors before and after, not assert success.

### No-regression framing when the gate baseline is red

When an AC references a repo-wide gate (lint, typecheck, full test suite) and the base branch is already red on that gate, "gate passes" is unfulfillable by any task scoped smaller than "fix all the debt." The correct framing is **no regression from the base** branch, measured by counting errors/failures before and after — `git stash && <gate> | count-errors` baseline, then re-run after edits and compare. When a test fails mid-work that the baseline didn't list, run `git stash && bun test <file> && git stash pop` — about ten seconds, definitive disproof of "must be pre-existing." Cheap stash-and-rerun beats reading the diff and guessing.
