# Lint: NUL-byte guard for tracked text files

## Goal

A `/^\0NEVER_MATCH/` literal in a TypeScript source file embeds a NUL byte and
flips git's text/binary detection: `git diff --numstat` reports `- -` and the
file becomes opaque in PR review. This already happened on
`docs/swe-textbook.shape.test.ts` and was fixed in `9f911db` ("fix(test):
remove literal NUL byte from docs/swe-textbook.shape.test.ts") via a
`sliceToEnd(body, opener)` helper. This task adds the regression guard that
would have caught the bug pre-merge so the post-fix invariant — *no NUL bytes
in tracked text files* — cannot regress silently.

Source: https://github.com/lukstafi/ludics/issues/503

## Acceptance Criteria

1. **New lint script** `scripts/lint-no-nul-bytes.ts` exists and:
   - Recursively walks the repo from a configurable root (default = repo root,
     overridable via positional CLI arg, matching the
     `lint-no-mock-module.ts` pattern for testability).
   - Scans every file whose extension is one of `.ts`, `.tsx`, `.md`, `.json`,
     `.yaml`, `.yml`.
   - Skips `node_modules/` and any build-output directory (`bin/`,
     `dist/` — whatever the existing lints skip; do not skip dot-directories,
     consistent with the GNU-grep semantics documented in
     `lint-no-mock-module.ts`).
   - Reports any scanned file containing one or more NUL bytes (`0x00`) by
     printing the repo-relative path on stderr.
   - Exits 0 when clean, 1 when one or more offenders are found.
   - Exposes a `runLint(root)` export returning `{ exitCode, offenders }` so
     the unit test can drive it directly.
2. **Companion test** `scripts/lint-no-nul-bytes.test.ts` exists and covers
   (test triple per state-migration memory pattern):
   - **Positive offender** — a tmp fixture file containing a NUL byte
     (written via `Buffer.from([0])` or equivalent — never as a literal NUL
     in the test source); lint must exit 1 and report that path.
   - **Clean baseline** — a tmp fixture with valid ASCII content; lint must
     exit 0 with empty offenders.
   - **Non-ASCII UTF-8 clean** — a tmp fixture containing valid multibyte
     UTF-8 (e.g. em-dash `—`, accented characters); lint must exit 0. This
     prevents an over-eager rewrite from drifting toward an ASCII-only check.
   - The CLI integration shape used by `lint-no-mock-module.test.ts`
     (spawning the script via `bun run` against tmp roots, plus a real-repo
     check that exits 0) is followed.
   - The test source itself contains zero NUL bytes (verifiable by the lint
     it ships with).
3. **`package.json`** has a new `lint:no-nul-bytes` script invoking
   `bun run scripts/lint-no-nul-bytes.ts`, slotted alongside the other
   `lint:*` entries.
4. **CI wiring** in `.github/workflows/ci.yml` adds a named step
   (`Lint — no NUL bytes` or similar) that runs `bun run lint:no-nul-bytes`,
   placed among the existing lint steps.
5. **Real-repo passes**: running the new lint against the current `main` exits
   0. `docs/swe-textbook.shape.test.ts` is part of the scanned set and is
   clean (verified today: 15767 bytes, 0 NUL bytes).
6. **Optional one-line addition** to `skills/orchestration/pair-coder-work.md`
   near the existing regex/inline-reimplementation note (line 15), reading
   approximately: "Avoid embedded control bytes in regex sentinels; if a
   closer's job is 'match nothing,' refactor to a `sliceToEnd`-style helper
   instead of a NUL-bearing literal." Keep it terse — reference-layer
   guidance, not a checklist item. May be omitted if the reviewer judges it
   bloat per the "Review scaffolding is sufficient" memory.

## Context

How things work now:

- **Sibling lints**: 13 single-purpose `lint:*` scripts under `scripts/` (e.g.
  `lint-no-mock-module.ts`, `lint-no-shadow-util.ts`, `lint-state-migration.ts`)
  each implement one byte/string-level invariant. Each has a paired
  `*.test.ts` driving tmp fixtures.
- **Closest template**: `scripts/lint-no-mock-module.ts` (~109 lines)
  exports `listTestFiles(dir)` + `runLint(root): { exitCode, offenders }`,
  walks recursively without skipping dot-dirs, prints offenders on stderr,
  and exits 1 on non-empty offender list. The companion test uses
  `mkdtempSync` + tmp-fixture writes and asserts both the exported
  `runLint` and the `import.meta.main` CLI integration (spawn via
  `bun run`).
- **Package script registration**: `package.json` lines 11-22 list every
  `lint:*` entry as `"lint:NAME": "bun run scripts/lint-NAME.ts"`.
- **CI step shape**: `.github/workflows/ci.yml` lines 28-59 wire each lint
  as a named step `- name: Lint <description>` running `bun run lint:NAME`.
  Order is roughly grouped by theme; alphabetical placement among
  `lint:no-mock-module` / `lint:no-shadow-util` is fine.
- **Pair-coder-work skill body**: existing line 15 in
  `skills/orchestration/pair-coder-work.md` already warns about regex
  pattern reimplementations — the optional NUL-byte one-liner sits in that
  paragraph or immediately after.
- **Historical offender**: commit `9f911db` introduced the
  `sliceToEnd(body, opener)` helper that replaced the NUL-bearing closer.
  `docs/swe-textbook.shape.test.ts` is the canonical clean exemplar; the
  lint asserts it stays clean.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Copy `scripts/lint-no-mock-module.ts` to `scripts/lint-no-nul-bytes.ts`
   and adapt:
   - Replace the regex-based predicate with a byte-level
     `Buffer.from(readFileSync(abs)).includes(0)` (or
     `readFileSync(abs).includes(0)` since `readFileSync` without an
     encoding returns a `Buffer`).
   - Replace `*.test.ts` filtering with extension-set filtering against
     `.ts`, `.tsx`, `.md`, `.json`, `.yaml`, `.yml`.
   - Walk from the repo root instead of `src/` + `templates/`, skipping
     `node_modules/`, `bin/`, `.git/` (do not skip dot-dirs in general,
     per the existing comment).
   - Header comment lists the rationale and the
     "update extension list when introducing a new tracked text extension"
     note.
2. Mirror `scripts/lint-no-mock-module.test.ts` for the companion test.
   Tmp fixtures must always write NUL bytes via `Buffer.from([0])` — never
   as a string literal in the test source. Add the non-ASCII UTF-8 clean
   case (em-dash, accented characters) explicitly.
3. Add the `package.json` entry alphabetically among the `lint:*` entries.
4. Add the CI step in `.github/workflows/ci.yml` near the other `lint:no-*`
   steps.
5. Optional: add the one-line note to `skills/orchestration/pair-coder-work.md`
   near line 15.

The check is one-line per file (`bytes.includes(0)`). No regex, no AST, no
path-aware logic. Cost is negligible (single byte-scan per file across a few
hundred files).

## Scope

In scope:

- New `scripts/lint-no-nul-bytes.ts` + `.test.ts` files.
- `package.json` `lint:no-nul-bytes` entry.
- CI step in `.github/workflows/ci.yml`.
- Optional one-liner in `skills/orchestration/pair-coder-work.md`.

Out of scope:

- CRLF, BOM, or encoding-validity checks beyond NUL-byte presence. The
  invariant is strictly "no NUL bytes" — valid UTF-8 with non-ASCII
  characters must pass.
- Pre-commit hook integration. CI step is sufficient; pre-commit is a
  separate concern.
- Folding into `lint:contracts`. That lint is field-name-drift between
  worker/orchestrator skill markdown — orthogonal. Single-purpose-per-script
  matches the convention used by every other `lint:*`.
- Extending the extension list to `.toml`, `.html`, etc. — easy follow-up
  if those file types become tracked text in the repo.
- Re-fixing `docs/swe-textbook.shape.test.ts`. Already clean on `main`.

Dependencies: none.
