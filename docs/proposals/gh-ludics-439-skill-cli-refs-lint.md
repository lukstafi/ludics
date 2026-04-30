# Skill body CLI references: lint against dispatchers + worker-conventions guidance

## Goal

Close the cross-artifact drift gap where skill markdown bodies (`skills/*.md`,
`skills/orchestration/*.md`) and template files (`templates/harness/CLAUDE.md`,
`templates/mag/memory/*.md`) cite `ludics <verb> <sub>` invocations in code
formatting that don't actually resolve to a real dispatcher. Skill bodies are
**executable specs** — Mag (and humans following the skill) literally run the
commands they cite. The frontmatter (`queue-action: ...`) is auto-registered by
the harness, but the prose body is plain text and is currently validated only
by reviewer eyeballs at PR time.

The triggering case (task-7ae99643 round 2) caught two dangling references in
a single new skill — `ludics mag verify-container-completion <id>` (no
dispatcher case existed) AND `ludics tasks list --json` (no `--json` flag).
Both surfaced only at PR review.

This task ships the prophylactic lint that 438's `extractDispatcherSubCommands`
helper enables: a `lint:skill-cli-refs` script that scans skill/template
markdown bodies for backtick- or code-fence-scoped `ludics <verb> <sub>`
references and verifies each one resolves against USAGE plus the relevant
sub-dispatcher's recognized cases.

Issue: https://github.com/lukstafi/ludics/issues/439

**Dependency chain:** gh-ludics-406 (regex-extractor floor counts) →
gh-ludics-438 (sub-command CLI drift lint + `extractDispatcherSubCommands`
helper) → gh-ludics-439 (this task — consumes 438's helper).

## Acceptance Criteria

1. **New lint script** at `scripts/lint-skill-cli-refs.ts` runs as
   `bun run lint:skill-cli-refs` and fails CI with a non-zero exit when any
   backtick- or code-fence-scoped `ludics <verb> <sub>` reference in the
   in-scope markdown set fails to resolve against the live dispatcher surface.

2. **In-scope file set** (Q1 resolved — all three scopes included):
   - `skills/*.md`
   - `skills/orchestration/*.md`
   - `templates/harness/CLAUDE.md`
   - `templates/mag/memory/*.md`

   Use a glob list maintained inline in the script (e.g.
   `["skills/*.md", "skills/orchestration/*.md", "templates/harness/CLAUDE.md",
   "templates/mag/memory/*.md"]`). Other markdown under `docs/` and
   `retrospectives/` is explicitly out of scope (those files are commentary,
   not executable specs).

3. **Detection rule** (Q2 resolved — backtick/code-fence inclusive): the lint
   considers a `ludics <verb>...` reference flaggable only when it appears
   inside one of:
   - An inline backtick span (`` `ludics x y` ``).
   - A fenced code block (delimited by ```` ``` ```` or ```` ```bash ````,
     ```` ```sh ````, ```` ```text ```` etc.; no language requirement).

   Prose mentions like *"the ludics harness directory"* or *"the ludics repo"*
   outside any code formatting are intentionally not flagged.

4. **Per-reference resolution rule**: for each in-scope reference matching
   `\bludics\s+([a-z][a-z0-9-]*)\b(?:\s+([a-z][a-z0-9-]*))?` (the "verb" and
   optional first "sub" tokens):
   - The verb MUST appear in `extractUsageCommands(src/index.ts)` from
     `lint-cli-readme.ts`. If not — emit `unknown top-level command:
     ludics <verb> (<file>:<line>)` and fail.
   - If a sub token follows AND the verb has a known sub-dispatcher (the
     8 covered by 438: `mag`, `flow`, `tasks`, `triggers`, `notify`, `cluster`,
     `dashboard`, `orch`/`orchestration`), the sub MUST appear in
     `extractDispatcherSubCommands(<file>, <fnName>)` (438's helper) for that
     prefix, modulo 438's allow-list. If not — emit
     `unknown sub-command: ludics <verb> <sub> (<file>:<line>)` and fail.
   - References whose verb has no sub-dispatcher (e.g. `ludics briefing`,
     `ludics doctor`, `ludics status`, `ludics quote`) pass after the
     top-level check — no sub validation attempted.

5. **Dynamic-prefix special-case**: the `slot` verb takes a slot identifier
   (digit or literal placeholder `N`/`$N`), not a sub-command, before its
   real sub-command. The lint recognizes `slot` as a dynamic prefix and
   matches `ludics slot (\d+|N|\$\w+) <sub>` instead of treating the next
   token as the sub. Verify `<sub>` against the slot dispatcher's recognized
   set (the cases inside `runSlot` or whatever the slot entrypoint is named).
   If 438 does not include the slot dispatcher in its 8 sites, the lint
   inlines the slot-sub extraction with a TODO to consolidate after 438's
   helper grows to cover slot.

6. **Skill-name false-positive guard**: references like `` `ludics-elaborate` ``
   or `` `ludics-draft-proposal` `` (skill names with a hyphen *immediately
   after* `ludics`, no space) are NOT flagged. The match anchor is
   `\bludics\s+` — the explicit space requirement excludes hyphen-suffixed
   skill names.

7. **Hyphenated verbs and subs are accepted**: regex character class
   `[a-z][a-z0-9-]*` matches verbs like `auto-start-evaluate`,
   `revise-proposal`, `queue-pop`, `verify-container-completion`. (See 438's
   alias list for the canonical/alias mapping.)

8. **Allow-list reuse**: 438's alias allow-list is shared (e.g. via the
   common `scripts/lib/cli-surface.ts` module 438 may extract, or by direct
   import from `lint-cli-subcommands.ts`). Aliases like
   `triggers pause`/`triggers disable` resolve cleanly on either name.

9. **Floor-count meta-test** (per gh-ludics-406's convention): the lint's
   test file asserts that the count of distinct
   `(verb, sub)` references extracted from the in-scope file set is at least
   a conservative floor (e.g. ≥ 30 — current corpus has ~50–80 distinct
   references). If a future DRY refactor consolidates skill prose behind a
   partials/include mechanism, the floor-count meta-test trips.

10. **Test coverage** at `scripts/lint-skill-cli-refs.test.ts`:
    - Unit test for the code-context extractor (backtick + fenced-block
      detection) using small markdown fixtures.
    - Unit test that prose mentions outside code formatting are NOT flagged.
    - Unit test that hyphen-suffixed skill names (`` `ludics-elaborate` ``)
      are NOT flagged.
    - Unit test for `slot N <sub>` dynamic-prefix handling (passes when
      `<sub>` is recognized; fails when it isn't).
    - Negative-fixture test: a markdown string with a known-bogus reference
      (e.g. `` `ludics mag does-not-exist` ``) yields one resolution error.
    - Integration test against the real in-scope file set on `main` —
      should pass (no live drift expected today).
    - Floor-count meta-test on the extracted reference set.

11. **CI wiring**: `lint:skill-cli-refs` is added to `package.json` scripts
    parallel to `lint:cli-readme` and `lint:cli-subcommands` (438's lint).
    Whatever umbrella script CI runs to aggregate lints picks it up.

12. **Worker-conventions guidance** (Q4 resolved — option (a), guidance only,
    no enforcement): a short paragraph is added to
    `skills/worker-conventions.md` advising skill authors:
    - Every literal `ludics <verb> <sub>` written in backticks or fenced
      blocks must resolve to a real dispatcher case + USAGE entry.
    - The `lint:skill-cli-refs` script catches drift, but author should
      sanity-check before PR (`bun run lint:skill-cli-refs`).
    - **Prefer direct tools where an equivalent exists** — `Read`, `Glob`,
      and `Bash` are validated by the agent harness and compose better than
      shelling to `ludics tasks list --json`. This is guidance only; firing
      `ludics notify`, `ludics slot N assign`, etc. remains entirely fine
      where there is no equivalent direct path.

13. **Day-one clean run**: the lint passes on `main` immediately after
    landing. If implementation discovers any genuine drift (a backticked
    reference today that doesn't resolve), the fix is part of the same PR —
    either correct the reference, add the missing dispatcher case, or
    rewrite the prose to escape the code-format detection (e.g. drop the
    backticks if the mention is intentionally prose).

## Context

### How things work now

- **`scripts/lint-cli-readme.ts`** (the precedent): `extractUsageBlock` reads
  the `USAGE` template literal in `src/index.ts` with a backtick-aware regex
  (the gh-ludics-431 fix); `extractUsageCommands` returns the top-level
  command set (`Set<string>`); `extractCliReferenceSection` slices the README
  CLI Reference; `extractReadmeCommands` returns commands from fenced
  `ludics ...` lines. The 439 lint reuses `extractUsageBlock` and
  `extractUsageCommands` directly.

- **`scripts/lint-cli-subcommands.ts`** (gh-ludics-438, drafted but not yet
  landed): introduces `extractDispatcherSubCommands(file, fnName)` to scan a
  given dispatcher (`runMag`, `runTasks`, `runFlow`, `runTriggers`,
  `runNotify`, `runCluster`, `runDashboard`, `runOrchestrationCli`) for
  `case "X":` literals (or registry keys, post-`runMag` refactor) inside the
  function body, plus the 438 alias allow-list. 439 consumes this helper;
  see `blocked_by` below.

- **In-scope skill/template corpus**:
  - `skills/*.md` — 23 user-invocable / orchestrator skill files.
  - `skills/orchestration/*.md` — 22 sub-skills (`pair-coder-*`,
    `pair-reviewer-*`, `merge-*`, `pr-*`, `solo-work`, `update-docs`,
    `suggest-refactor`, `final-merge`).
  - `templates/harness/CLAUDE.md` — shipped by `ludics init` into user
    harnesses.
  - `templates/mag/memory/*.md` — `corrections.md`, `tools.md`,
    `workflows.md`; same template ship.

  Quick survey today: 49 backticked `` `ludics <verb>` `` matches across the
  in-scope set, plus a number of fenced-block multi-line examples. Mostly
  `ludics mag …`, `ludics tasks …`, `ludics slot N …`, `ludics notify …`,
  `ludics flow …`, `ludics briefing`. Spot-check shows no live drift today
  (post-task-7ae99643 fix) — 439 is forward-looking.

- **Dynamic-prefix shape**: `ludics slot N <sub>` appears literally in
  multiple skills (e.g. `skills/ludics-adopt-sessions.md` lines 66, 82, 96,
  102, 116, 179) using the literal placeholder `N`. The lint must accept
  `\d+`, the bareword `N`, and shell-variable forms `$N`/`${N}`.

- **Skill names colliding with the verb**: backticked references like
  `` `ludics-elaborate` `` (a skill identifier) start with `ludics-` (hyphen
  immediately after, no space). The detection regex anchors on
  `\bludics\s+` so the hyphen form is naturally excluded.

- **Code-fence detection**: the lint walks each markdown file line-by-line
  tracking fence state — a line that starts with ```` ``` ```` (any language
  tag) toggles the fence flag. Inline-backtick detection uses a per-line
  scan over balanced single-backtick spans (skipping triple-backtick fence
  delimiters). Backslash-line-continuation (`\` at end of line in a code
  fence) joins to the next line for the regex pass — so multi-line shell
  invocations match correctly.

### Code pointers

- `~/ludics/scripts/lint-cli-readme.ts` — reuse `extractUsageBlock`,
  `extractUsageCommands`.
- `~/ludics/scripts/lint-cli-subcommands.ts` (post-438) — consume
  `extractDispatcherSubCommands(file, fnName)` + alias allow-list.
- `~/ludics/scripts/lib/cli-surface.ts` (likely created by 438 as the
  shared module) — preferred import location.
- `~/ludics/src/index.ts` — `USAGE`, `MIGRATED_COMMANDS`. The lint reads
  USAGE via `extractUsageCommands` (already handles backtick-aware parse).
- `~/ludics/src/mag.ts`, `src/tasks/index.ts`, `src/flow.ts`,
  `src/triggers.ts`, `src/notify.ts`, `src/cluster.ts`, `src/dashboard.ts`,
  `src/orchestration/index.ts` — sub-dispatchers consumed via
  `extractDispatcherSubCommands`.
- `~/ludics/skills/worker-conventions.md` — guidance paragraph lands here
  (Q4).
- `~/ludics/package.json` — `scripts.lint:skill-cli-refs` entry.

### Why this is not a duplicate

- **gh-ludics-406**: regex-source extractors going empty after DRY refactors
  → fix is floor-count assertions on existing extractors. 439 is itself a
  fifth regex-source extractor and adopts 406's floor-count convention from
  day one (AC #9).
- **gh-ludics-438**: in-codebase invariant — `case "x":` ⇄ USAGE ⇄ default
  listing for sub-dispatchers in `src/`. Surface: TypeScript dispatcher
  files. 438's lint introduces `extractDispatcherSubCommands` which 439
  consumes.
- **gh-ludics-439** (this task): cross-artifact invariant — every
  `ludics <verb> <sub>` literal in markdown bodies under `skills/` and
  `templates/` must resolve to a real dispatcher case. Surface: markdown.
  Different file set, different extraction pipeline, complementary lint.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Phase 0: confirm gh-ludics-438 is merged

If 438 has not yet landed by the time implementation starts, **do not
start** — wait for the merge. 439's lint imports
`extractDispatcherSubCommands` (and the alias allow-list) from 438's shared
module. Merging in the wrong order risks duplicating the helper. (See
`blocked_by` in frontmatter.)

The chain is gh-ludics-406 (in-progress) → gh-ludics-438 (queued, blocked
by 406) → gh-ludics-439 (this task, blocked by 438). 439's PR is drafted
once 438 merges.

### Phase 1: write the markdown extractor

Create `scripts/lint-skill-cli-refs.ts` with the following pure helpers
(exported for testing):

```ts
// Walk markdown line-by-line, tracking fence state. Return an array of
// { file, line, col, span } where span is a contiguous code-formatted
// region (inline-backtick span OR fenced-block line content). Comments in
// fences are kept verbatim.
export interface CodeSpan {
  file: string;
  line: number;
  text: string;
}
export function extractCodeSpans(file: string, source: string): CodeSpan[];

// Within a CodeSpan, find `ludics\s+<verb>(?:\s+<sub>)?` matches. Returns
// { verb, sub|null, file, line }. Anchored on `\bludics\s+` (the explicit
// space excludes `ludics-foo` skill names). Hyphen-internal verbs/subs OK.
export interface CliRef {
  verb: string;
  sub: string | null;
  slotPlaceholder: string | null; // for `ludics slot N <sub>` — the N token
  file: string;
  line: number;
}
export function extractCliRefs(spans: CodeSpan[]): CliRef[];
```

Markdown parser is hand-rolled — no `marked` import — same shape as
`lint-cli-readme.ts`'s top-level extractor.

### Phase 2: wire to 438's helper

```ts
import { extractUsageCommands } from "./lint-cli-readme.ts";
import {
  extractDispatcherSubCommands,
  DISPATCHERS,        // 438's 8-site descriptor array
  ALIASES,            // 438's alias allow-list
} from "./lint-cli-subcommands.ts"; // or shared "./lib/cli-surface.ts"

interface ResolutionError {
  ref: CliRef;
  kind: "unknown-verb" | "unknown-sub";
  message: string;
}

export function resolveCliRefs(
  refs: CliRef[],
  topLevelCommands: Set<string>,
  subCommandsByPrefix: Map<string, Set<string>>,
): ResolutionError[];
```

Special-case the `slot` prefix: when `verb === "slot"` and
`slotPlaceholder !== null`, validate the *next* token (currently held in
`sub`, but conceptually the post-N sub-command) against the slot dispatcher.
If 438 doesn't yet cover slot, inline a small extractor in 439's script
with a TODO comment to upstream into 438's `DISPATCHERS` array.

### Phase 3: CLI entry point

Mirror `lint-cli-readme.ts`'s `if (import.meta.main)` block:

```ts
if (import.meta.main) {
  const inScopeGlobs = [
    "skills/*.md",
    "skills/orchestration/*.md",
    "templates/harness/CLAUDE.md",
    "templates/mag/memory/*.md",
  ];
  // Use Bun.glob or similar; collect files; scan; resolve; report.
  const errors = lintSkillCliRefs(/* ... */);
  if (errors.length > 0) {
    console.error(`\n❌  Skill body CLI refs do not resolve to live dispatchers:`);
    for (const e of errors) {
      console.error(`     ${e.message}`);
    }
    process.exit(1);
  }
  console.log("✅  All skill/template CLI refs resolve.");
}
```

Error-message format matches `lint-cli-readme.ts`'s style (red ❌ block on
failure, green ✅ on success).

### Phase 4: tests at `scripts/lint-skill-cli-refs.test.ts`

Mirror the structure of `scripts/lint-cli-readme.test.ts`:

- Unit tests for `extractCodeSpans` (inline backticks, fenced blocks, mixed,
  nested, escape sequences).
- Unit tests for `extractCliRefs` (verb-only, verb+sub, hyphenated tokens,
  `slot N <sub>` shape, hyphen-suffix skill names rejected, prose-mention
  rejected).
- Unit tests for `resolveCliRefs` (positive and negative fixtures with a
  hand-constructed dispatcher map).
- Integration test against the real `src/` and the real in-scope markdown
  set: `lintSkillCliRefs()` returns `[]` (no errors) on `main`.
- Floor-count meta-test: the integration `extractCliRefs` result has
  `.length >= 30` (conservative — current corpus is ~50–80).

### Phase 5: worker-conventions paragraph

Add a paragraph to `skills/worker-conventions.md` (placement: near the
existing CLI guidance, or as a new short subsection if none exists). Draft:

> ### Skill body CLI references
>
> Skill markdown bodies are executable specs — Mag and human readers
> literally run the `ludics ...` commands cited in code formatting. Every
> literal `ludics <verb> <sub>` written inside backticks or a fenced code
> block must resolve to a real dispatcher case and a USAGE entry in
> `src/index.ts`. The `lint:skill-cli-refs` script catches drift in CI;
> sanity-check locally before opening a PR with `bun run
> lint:skill-cli-refs`. **Prefer direct tools where an equivalent exists**
> (`Read`, `Glob`, `Bash` are validated by the agent harness and compose
> better than shelling to `ludics tasks list --json`); fire `ludics ...`
> when there is no equivalent direct path (e.g. `ludics notify`,
> `ludics slot N assign`).

(Final wording adjustable to match doc voice — coder may reflow.)

### Phase 6: package.json + CI

```jsonc
"scripts": {
  // ...
  "lint:cli-readme": "bun run scripts/lint-cli-readme.ts",
  "lint:cli-subcommands": "bun run scripts/lint-cli-subcommands.ts",
  "lint:skill-cli-refs": "bun run scripts/lint-skill-cli-refs.ts",
  // ...
}
```

If an umbrella `lint:all` (or similar aggregator) is added by 438, append
`lint:skill-cli-refs` to it. Otherwise mirror 438's CI wiring.

## Scope

**In scope:**
- New script `scripts/lint-skill-cli-refs.ts` with the extractor, resolver,
  and CLI entry point.
- Tests at `scripts/lint-skill-cli-refs.test.ts` covering the cases listed
  in AC #10.
- Worker-conventions paragraph (AC #12).
- `package.json` script entry + CI wiring (AC #11).
- Floor-count meta-test (AC #9).
- Any genuine drift discovered during day-one audit — fix in the same PR
  (AC #13).

**Out of scope:**
- **Multi-word nested sub-commands** (e.g. `ludics mag queue pop one`,
  `ludics mag queue pop all`). Per 438's stance, nested cases are not
  validated; 439 mirrors that — verifying that `mag queue` resolves is
  enough.
- **AST-based markdown parsing**. Hand-rolled fence/backtick walker is
  sufficient for the current corpus; if false-positive rate becomes a real
  problem later, follow up with `marked` or similar.
- **Hard policy on suggestion 3** (no `ludics ...` in skills). Q4 resolved
  to guidance-only — no enforcement code, just one paragraph in
  worker-conventions.
- **Linting `docs/` and `retrospectives/`**. Those are commentary, not
  executable specs. Authors are free to write `ludics whatever-stale` as
  historical reference without tripping CI.
- **Linting historical commit messages or PR descriptions**. Out of scope
  by file-set.
- **Refactoring skills to use direct tool calls instead of `ludics ...`**.
  No mass rewrite — guidance applies to new skills going forward.

**Dependencies:**
- `blocked_by: gh-ludics-438` — wait for 438 to merge before starting
  implementation. 439's lint imports
  `extractDispatcherSubCommands` and the alias allow-list from 438's
  shared module. Note the chain: gh-ludics-406 → gh-ludics-438 →
  gh-ludics-439. 406 is in-progress on slot 6; 438 is queued and
  blocked-by 406; 439 (this proposal) drafts now and starts when 438
  merges.
- `relates_to: gh-ludics-406` (the floor-count convention 439 adopts)
  and `gh-ludics-438` (the helper 439 consumes).
