# Lint: skill-markdown shell-variable references must resolve to defined or harness-inherited names

## Goal

Skill markdown bodies are read by humans and LLMs, not executed by a shell, so a
typo in a shell-variable reference (e.g. `$EVENTS_BASELINE_LINE` when the actual
derivation step output is `$EVENTS_LINES`) has zero runtime signal. The PR #493
retrospective on `task-a670cdbf` flagged this as a class of silently-rotting
references that careful reviewer reading is a weak catch-net for. A mechanical
lint over `skills/*.md` and friends — the same in-scope corpus that
`lint:skill-cli-refs` already polices — would catch the whole class at CI time.

## Acceptance Criteria

- [ ] `scripts/lint-skill-shell.ts` exists and exits non-zero when any in-scope
      file contains a shell-variable reference whose bare name is neither
      defined earlier in the same file's shell content nor present in the
      script's `HARNESS_INHERITED` set.
- [ ] In-scope file set matches `lint-skill-cli-refs`: the lint imports
      `IN_SCOPE_GLOBS` and `collectInScopeFiles` from
      `scripts/lint-skill-cli-refs.ts` (no parallel scope literal).
- [ ] Shell-context discrimination matches `lint-template-safety`: the lint
      imports `classifyLines`, `findFencedShellBlocks`, `findInlineShellSpans`,
      and `looksLikeShell` from `scripts/lint-template-safety.ts` (no parallel
      classifier). Only fenced ` ```sh / ```bash / ```shell ` blocks and inline
      backtick spans for which `looksLikeShell` returns true contribute either
      references or assignments.
- [ ] Reference detection covers both `$NAME` and `${NAME...}` forms, including
      the parameter-expansion variants `${VAR:-default}`, `${VAR:=default}`,
      `${VAR:?msg}`, `${VAR:+alt}`, `${VAR/pattern/repl}`, `${#VAR}`, `${!VAR}`,
      and `${VAR[i]}`. The bare name is what gets resolved; pattern, default,
      and index sub-tokens are not separately checked. `\$NAME` and `$$` do not
      count as references.
- [ ] Assignment detection covers, at minimum: bare `NAME=value` (line-anchored
      or after `;` / `&&` / `||` / `|`); `for NAME in …`; `read NAME [NAME …]`;
      `local`/`declare`/`export`/`readonly NAME=…`. Assignment scope is
      per-file: every shell span in a single skill markdown shares one
      assignment pool, so a name defined in one fence resolves references in a
      later fence of the same file. Cross-file scope is not supported.
- [ ] `HARNESS_INHERITED` is a hardcoded `Set<string>` constant in the script
      (no sidecar file, no inline-comment escape hatch for v1) seeded with at
      least: `LUDICS_STATE_PATH`, `LUDICS_RESULTS_DIR`, `LUDICS_REQUEST_ID`,
      `ARGUMENTS`, plus standard env / shell built-ins (`HOME`, `PATH`, `USER`,
      `SHELL`, `PWD`, `OLDPWD`, `TMPDIR`, `EDITOR`, `LANG`, `LC_ALL`, `IFS`).
      Shell special parameters (`$0`–`$9`, `$@`, `$*`, `$#`, `$?`, `$!`, `$$`,
      `$_`, `$-`) are handled by skipping non-`[A-Za-z_]` first characters
      before name extraction rather than by allowlist entries.
- [ ] `${VAR:-default}` with `VAR` neither defined in-file nor in
      `HARNESS_INHERITED` is flagged. The contract is "typo-class catch";
      bash's safe-default semantics is incidental.
- [ ] HEREDOC bodies are scanned uniformly as shell content; quoted-heredoc
      (`<<'EOF'`) suppression of interpolation is not special-cased in v1.
- [ ] `bash -c '…'` / `sh -c "…"` inner strings are treated as opaque in v1
      (no recursive scanning).
- [ ] On violation the script's stderr matches the shape of
      `lint-skill-cli-refs.ts` output: a `❌` summary line with the violation
      count, one `file:line $NAME (snippet)` row per violation, and a brief
      remediation prompt (define earlier in the file / add to
      `HARNESS_INHERITED` / fix the typo). Exit code is 1 on any violation, 0
      otherwise.
- [ ] `scripts/lint-skill-shell.test.ts` exercises the lint with at least
      these cases: a fabricated `$EVENTS_BASELINE_LINE`-style typo (flagged);
      `EVENTS_LINES=$(…)` followed by `$EVENTS_LINES` later in the same file
      (not flagged); bare `$LUDICS_STATE_PATH` with no in-file assignment
      (not flagged via `HARNESS_INHERITED`); `${VAR:-default}` flagged when
      `VAR` is otherwise unknown and not flagged when it is known; `$X` inside
      a ` ```ts ` fence (not flagged — non-shell context); `for NAME in …`
      followed by `$NAME` (not flagged — loop binding); `read NAME` followed
      by `$NAME` (not flagged); `$$` / `$?` / `$1` (not flagged — special
      parameters); and a smoke test that running the lint over the live in-
      scope corpus is clean.
- [ ] `package.json` declares `"lint:skill-shell": "bun run scripts/lint-skill-shell.ts"`
      adjacent to the existing `"lint:skill-cli-refs"` entry.
- [ ] `.github/workflows/ci.yml` adds a step `Lint skill body shell variables`
      running `bun run lint:skill-shell`, placed alongside the existing
      `Lint skill body CLI references` step.
- [ ] Running `bun run lint:skill-shell` against the current `main` corpus
      passes (zero violations) — i.e. the test refers to a fabricated typo
      under `/tmp` or via inline test fixtures rather than relying on a real
      regression in the live tree.

## Context

Existing infrastructure to mirror:

- `scripts/lint-skill-cli-refs.ts` — exports `IN_SCOPE_GLOBS` and
  `collectInScopeFiles`; defines the in-scope set as `skills/*.md`,
  `skills/orchestration/*.md`, `templates/harness/CLAUDE.md`, and
  `templates/mag/memory/*.md`. Its CLI entry shape (file walk → per-file lint
  → aggregated violations → `❌` summary line → exit 1) is what the new lint
  should mirror.
- `scripts/lint-template-safety.ts` — exports `classifyLines` (partitioned line
  classifier emitting `prose | fence-marker | fence-body{blockKind: "shell" |
  "other", indent}`), `findFencedShellBlocks`, `findInlineShellSpans`, and
  `looksLikeShell`. The partition guarantee
  (`classifyLines(lines).length === lines.length`) is what keeps a `$VAR`
  reference inside an inline backtick from being double-counted when that
  backtick lives inside a fenced span.
- `.github/workflows/ci.yml` — each skill/source lint is a separate `run:`
  step under the same job; the new step lands in the same block.
- `skills/orchestrator-conventions.md` § `Environment` and
  `skills/worker-conventions.md` § `Environment` are the canonical sources for
  the harness-inherited names; `$ARGUMENTS` is documented in
  `skills/worker-conventions.md` § `Argument Parsing`.
- `skills/ludics-health-check.md` is the post-PR-#493 example of correct
  derivation-then-reference shell flow (`EVENTS_LINES=$(…)` later read as
  `$EVENTS_LINES`); it should remain clean under the new lint and is a useful
  smoke target.

The historical typo from PR #493 has already been fixed in `main`; the test
must fabricate a synthetic typo input rather than depend on a checked-in
regression.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Create `scripts/lint-skill-shell.ts` importing `IN_SCOPE_GLOBS` and
   `collectInScopeFiles` from `lint-skill-cli-refs.ts`, and `classifyLines`,
   `findFencedShellBlocks`, `findInlineShellSpans`, `looksLikeShell` from
   `lint-template-safety.ts`.
2. Define `HARNESS_INHERITED: ReadonlySet<string>` with the seed list above.
3. For each in-scope file, derive `findFencedShellBlocks(lines) ∪
   findInlineShellSpans(lines)` and concatenate the bodies into a single
   per-file shell stream (preserving line numbers for diagnostics).
4. Walk the stream once to collect assignment names (per-file pool); walk it
   again to collect references; emit a violation for every reference whose
   bare name is in neither the per-file pool nor `HARNESS_INHERITED`.
5. Print the aggregated violations in `lint-skill-cli-refs` shape and exit 1
   on any violation.
6. Add `scripts/lint-skill-shell.test.ts` covering the cases enumerated in the
   ACs; structure tests as a mix of in-process calls (passing synthetic file
   contents) and one end-to-end smoke that walks the live corpus.
7. Wire `package.json` and `.github/workflows/ci.yml` adjacent to the
   `lint:skill-cli-refs` entries.

The reference-extraction regex needs care around `\$`, `$$`, command
substitution `$(…)`, and the parameter-expansion variants — Q3 in the task
elaboration confirmed the desired strictness for `${VAR:-default}`. The bare-
name extraction inside `${…}` should stop at the first non-name character
(`:`, `/`, `[`, `}`, `#`, `!`, `+`, `=`, `?`).

## Scope

In scope:

- New script `scripts/lint-skill-shell.ts` and its test `scripts/lint-skill-shell.test.ts`.
- `package.json` `lint:skill-shell` entry.
- `.github/workflows/ci.yml` step running `bun run lint:skill-shell`.
- Whatever minor edits to existing skill markdown the lint surfaces as it
  starts running clean — these are absorb-class fixes (typos / missed
  derivations) and should be made in the same PR rather than spawned off.

Out of scope:

- Inline-comment escape hatches (`# lint-skill-shell: allow …`) and sidecar
  allowlist files. The hardcoded `HARNESS_INHERITED` set is the only allowlist
  surface in v1.
- Recursive scanning of `bash -c '…'` / `sh -c "…"` inner strings.
- Quoted-HEREDOC (`<<'EOF'`) interpolation suppression. Bodies are scanned
  uniformly in v1.
- Cross-file assignment scope. Per-file is the unit.
- Any change to the `lint:skill-cli-refs` script — the new lint imports from
  it but does not rewrite its surface.

Dependencies: none blocking. The task relates to `task-a670cdbf` (the source
retrospective) but does not depend on any unmerged work.
