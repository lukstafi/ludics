# Harden lint-template-safety: shared ALWAYS_POPULATED + disjoint-region scanner + command-list drift test

## Goal

Three follow-up hardening items for `scripts/lint-template-safety.ts`, bundled per the neighbor-suggestions rule from the `task-3b906d0f` retrospective (`suggestRefactorSummary` items 1–3). Each item closes a specific drift / double-count class that nearly bit us during the original lint's review:

1. The hand-maintained `ALWAYS_POPULATED` set in `lint-template-safety.ts` will silently drift from the literal assignments in `buildSkillContext()` — a future always-populated key would be flagged as "unknown" by the lint.
2. The two-pass fence scanner (`findFencedShellBlocks` + `findFencedLines` consulted ad-hoc by `findInlineShellSpans`) has overlapping responsibility; the round-2 Codex catch (inline-shell-shaped backtick inside a `\`\`\`ts` fence) showed how easy it is for a future pass to forget to consult the skip-set.
3. `SHELL_COMMANDS` and `SHELL_KEYWORDS` will rot as templates begin using new tools (e.g. `helm`, `kubectl`) without anyone updating the static list.

Source: `task-3b906d0f` retrospective, PR #365 (initial lint landing).

## Acceptance Criteria

### Item 1 — Share ALWAYS_POPULATED with `buildSkillContext`

- [ ] `src/orchestration/skills.ts` exports a `ReadonlySet<string>` named `ALWAYS_POPULATED_KEYS` containing the same keys currently in `scripts/lint-template-safety.ts`'s `ALWAYS_POPULATED` constant. The constant is co-located with `buildSkillContext` (same file) so a maintainer adding a new always-populated assignment touches one file.
- [ ] An anchor comment immediately above the exported set names the CI-drift-pair partner test (e.g. "CI-drift-pair — see `scripts/lint-template-safety.test.ts` ALWAYS_POPULATED_KEYS drift test").
- [ ] `scripts/lint-template-safety.ts` imports `ALWAYS_POPULATED_KEYS` from `../src/orchestration/skills.ts` and re-exports it as `ALWAYS_POPULATED` (back-compat for existing test imports — see `scripts/lint-template-safety.test.ts` line 6).
- [ ] A new test in `scripts/lint-template-safety.test.ts` parses `src/orchestration/skills.ts` as text, locates the `result` object literal in `buildSkillContext()` (bounded by `const result: Record<string, string> = {` … matching `}`), and asserts both directions:
  - Every key assigned a non-empty string (string literal, `String(...)` of a known-number, or expression with non-empty default — i.e. not `?? ""`, not `: ""`) appears in `ALWAYS_POPULATED_KEYS`.
  - Every key in `ALWAYS_POPULATED_KEYS` appears as such an assignment in the `result` block.
- [ ] All existing `bun test scripts/lint-template-safety.test.ts` cases continue to pass with no churn beyond the import-path change.
- [ ] `bun run lint:template-safety` (or whatever invokes the script) keeps its existing exit semantics — no behavior change to the lint itself.

### Item 2 — Disjoint-region scanner via `classifyLines`

- [ ] `scripts/lint-template-safety.ts` exports a new function `classifyLines(lines: string[]): LineClass[]` returning a row-bucketed partition where each line index maps to exactly one classification:
  ```ts
  type LineClass =
    | { kind: "prose" }
    | { kind: "fence-marker"; blockKind: "shell" | "other" }
    | { kind: "fence-body";   blockKind: "shell" | "other"; indent: string };
  ```
  `classifyLines(lines).length === lines.length` is invariant.
- [ ] `findFencedShellBlocks` and `findFencedLines` are kept as derived back-compat exports (their public signatures, return shapes, and existing test coverage are unchanged). Internally they delegate to `classifyLines` (collapse `fence-body` rows with `blockKind: "shell"` for the former; collect `fence-marker` and `fence-body` rows of any kind for the latter).
- [ ] `findInlineShellSpans` iterates only rows where `classifyLines(lines)[i].kind === "prose"` (the partition replaces the ad-hoc skip-set lookup). The optional `fencedLines` parameter is preserved for back-compat callers but is no longer the load-bearing skip mechanism.
- [ ] A disjointness invariant test on a hand-crafted mixed corpus (prose + `\`\`\`sh` block + `\`\`\`ts` block + indented `\`\`\`bash` block in a numbered list) plus at least one real template read from `skills/orchestration/`, asserting `classifyLines(lines).length === lines.length` and each element is well-formed (one of the three kinds with the expected fields).
- [ ] A specific round-2 Codex regression test: a `\`\`\`ts` (non-shell) fence whose body contains a backtick span shaped like an inline shell command (e.g. `` `gh pr view 123` ``). Assertions: every line of the body classifies as `fence-body` with `blockKind: "other"`; `findInlineShellSpans` returns no span pointing into that body.

### Item 3 — Command-list drift meta-test

- [ ] A new `describe("SHELL_COMMANDS drift")` block in `scripts/lint-template-safety.test.ts` (NOT in the script — runtime vs. CI lint separation: this is a contract on the static lists, not a lint rule templates must pass at runtime).
- [ ] The meta-test enumerates `skills/orchestration/*.md` (reuse the same listing logic `runLint` uses), and for each template runs `findFencedShellBlocks`. For each shell-block body line, after stripping leading whitespace, leading `{{#IF VAR}}` / `{{/IF}}` tags, blank/comment/continuation-only lines, and the existing `ENV_ASSIGNMENT_PREFIX` regex match, it splits on `|`, `&&`, `||`, `;` segments and takes the first whitespace-separated token of each non-empty segment.
- [ ] The token is accepted if any of:
  - matches `^\$\(`, `^\[`, `^\{`, `^\(` — known shell dispatch form;
  - matches `^\{\{[A-Z0-9_]+\}\}` — variable-as-command (e.g. `{{TOOL}} ...`);
  - is in `SHELL_COMMANDS ∪ SHELL_KEYWORDS`.
- [ ] Otherwise the failure list collects `"{template}:{line}: unknown shell first-token \`{token}\`; add to SHELL_COMMANDS or document exemption"`. The test asserts the collected failures list is empty.
- [ ] The test passes against `skills/orchestration/*.md` as currently checked in. If the test discovers any unknown tokens during implementation, the implementer adds them to `SHELL_COMMANDS` (or `SHELL_KEYWORDS`) deliberately rather than weakening the meta-test.

## Context

### Files touched

- `scripts/lint-template-safety.ts` — new `classifyLines` export, refactored `findFencedShellBlocks` / `findFencedLines` / `findInlineShellSpans` derivations, replaced `ALWAYS_POPULATED` literal with re-exported import.
- `scripts/lint-template-safety.test.ts` — three new `describe` blocks: ALWAYS_POPULATED_KEYS drift, classifyLines disjointness + ts-fence regression, SHELL_COMMANDS drift meta-test.
- `src/orchestration/skills.ts` — add `ALWAYS_POPULATED_KEYS` export co-located with `buildSkillContext()` (above or adjacent to the `result` object literal), with the anchor comment referencing the partner test.

### Code pointers (by symbol; line numbers drift)

- `scripts/lint-template-safety.ts`:
  - `ALWAYS_POPULATED`: hand-maintained `ReadonlySet<string>` near the top of the file.
  - `findFencedShellBlocks`: shell-fence-only body spans.
  - `findFencedLines`: ANY fence, marker + body, used as skip-set.
  - `findInlineShellSpans`: per-line loop with early `continue` on `inFence.has(i)`.
  - `SHELL_COMMANDS` (~60 tokens) and `SHELL_KEYWORDS` (13 tokens).
  - `SHELL_COMMAND_PREFIX`, `ENV_ASSIGNMENT_PREFIX`, `SHELL_CHAIN` regexes.
- `src/orchestration/skills.ts::buildSkillContext()`:
  - The `const result: Record<string, string> = { ... }` literal-assignment block is the source of truth for which keys are guaranteed non-empty. Keys with `?? ""` or `: ""` fallback expressions are correctly excluded from `ALWAYS_POPULATED` today (`PROPOSAL_PATH`, `PROPOSAL_INSTRUCTION`, `PROPOSAL_FRESHNESS_WARNING`, `TASK_AC`, `VERIFICATION_CONTEXT`, `UPSTREAM_REPO`, `PEER_*` peer-conditional, all auto-injected `PROJECT_*`).
  - `TASK_SPEC` / `TASK_SPEC_BRIEF` are function calls (`taskSpecText`, `taskSpecBriefText`) but non-empty under the orchestrator's invariants — kept in the set per the existing pragmatic rule "has non-empty default at the assignment site = always populated".
- `scripts/lint-template-safety.test.ts`:
  - Already imports `ALWAYS_POPULATED` near the top (`bun:test` style).
  - Existing `describe("ALWAYS_POPULATED set", …)` block asserts membership/non-membership by hand — natural neighbor for the new drift test.
  - Existing `runLint` directory-sweep tests show the templates-on-disk pattern that Item 3's meta-test follows.

### Cross-import precedent

No `scripts/lint-*.ts` imports from `src/` today. TypeScript path resolution works fine under `bun` + `tsconfig.json` with `moduleResolution: "bundler"`. The relative path `"../src/orchestration/skills.ts"` (explicit `.ts` extension for bun) needs no `tsconfig` alias. This task introduces the pattern; one-time cost, then conventional going forward.

## Approach

*Suggested approach — agents may deviate if they find a better path. The Tentative Design in the task file resolves all three sub-decisions (export-site, partition granularity, meta-test placement); alternatives are noted but the defaults below are what landed in the proposal.*

### Item 1 sequencing

1. In `src/orchestration/skills.ts`, define and export `ALWAYS_POPULATED_KEYS` with the current 33 keys, anchored by the CI-drift-pair comment. Place it adjacent to (just above) the `buildSkillContext` definition so the visual coupling to the `result` literal is obvious.
2. In `scripts/lint-template-safety.ts`, replace the literal `ALWAYS_POPULATED` definition with `import { ALWAYS_POPULATED_KEYS } from "../src/orchestration/skills.ts"; export const ALWAYS_POPULATED = ALWAYS_POPULATED_KEYS;`.
3. Verify `bun test scripts/lint-template-safety.test.ts` passes unchanged.
4. Add the drift test in a new `describe("ALWAYS_POPULATED_KEYS drift", …)` block. Implementation hint: read `src/orchestration/skills.ts` via `readFileSync(import.meta.dir + "/../src/orchestration/skills.ts", "utf8")`, locate the start of `const result: Record<string, string> = {` and the matching closing `};` by brace depth, extract `^\s+(\w+):\s` keys, classify by whether the value expression contains `?? ""` or `: ""`, and assert the two-direction invariant against `ALWAYS_POPULATED_KEYS`.

### Item 2 sequencing

1. Implement `classifyLines` as a single-pass state machine: track open-fence state (none / open with kind+indent), emit one `LineClass` per input line. The state-transition table is small (5 transitions): prose-with-no-open-fence → `prose`; prose with shell-fence-open-marker → `fence-marker {blockKind: "shell"}`; prose with non-shell-fence-open-marker → `fence-marker {blockKind: "other"}`; in-fence with body line → `fence-body {blockKind, indent}`; in-fence with closing-fence-line → `fence-marker {blockKind}` (and reset state).
2. Reimplement `findFencedShellBlocks` over the partition: scan for runs of `fence-body` rows with `blockKind === "shell"` between two `fence-marker` rows, emit one `ShellSpan` per run with the same `startLine`/`endLine`/`startCol=0`/`endCol=lines[endLine].length`/`kind: "fenced"` shape as today.
3. Reimplement `findFencedLines` as `new Set(rows.map((c, i) => c.kind !== "prose" ? i : -1).filter(i => i >= 0))`.
4. Update `findInlineShellSpans` to iterate `rows.kind === "prose"` directly. Keep the optional `fencedLines` parameter for back-compat — if provided, fall back to the current behavior so any external caller is unaffected.
5. Add the disjointness test and the `\`\`\`ts` regression test. The hand-crafted corpus should mix all three fence kinds (`sh`, `bash`, `ts`) plus indented variants.

### Item 3 sequencing

1. In `scripts/lint-template-safety.test.ts`, add a `describe("SHELL_COMMANDS drift", …)` block. Reuse the existing template-listing helper that `runLint` uses (factor a tiny `listTemplates(dir)` if helpful; the task file notes this is fine).
2. Iterate every `.md` file in `skills/orchestration/`, run `findFencedShellBlocks`, walk body lines, tokenize per the rules in AC-3, accumulate failures, assert empty.
3. If the meta-test discovers any unknown first-tokens against the current templates, add the missing commands to `SHELL_COMMANDS` (or, rarely, `SHELL_KEYWORDS`) deliberately. The task expectation is zero or near-zero failures since the template audit already rounded up realistic commands; an unknown find is a useful surfacing, not a failure of the proposal.

### Notes on what NOT to do

- Don't introduce a separate `src/orchestration/skill-context-keys.ts` module for the exported set — co-location with `buildSkillContext` is the explicit choice (rejected alternative: standalone module). Splitting them invites new drift between exported set and literal assignments.
- Don't switch to char-offset partitioning in Item 2 — fences are line-aligned today and char-range partitioning is overkill and harder to invariant-test.
- Don't move the SHELL_COMMANDS drift check into the runtime lint script — keeping it in the test file preserves the runtime-vs-CI separation (lint = "templates must pass"; meta-test = "the lint's static lists must keep up with the templates").

## Scope

**In scope:** Items 1, 2, 3 above as a single PR.

**Out of scope:**
- `task-3b906d0f` retrospective `suggestRefactor` item 4 (positional-override pattern for CLI tests) — already applied; generalization is process guidance, not code.
- Item 5 (capture proposal-vs-tree deltas in AC-verification) — AC-authoring process lesson, not code.
- `{{#REQUIRE VAR}}` runtime directive / empty-variable runtime warnings — proposal approaches B/D deferred by design.
- Expanding `PR_CREATE_REPO_FLAG` computed-flag pattern to more variables — reactive only.
- `lint-test-isolation.ts` (sibling task-68fe7177) — different lint, different scope.

**Dependencies:** none. PR #365 (the original lint) has already landed. Sibling lint-test-isolation work is independent.
