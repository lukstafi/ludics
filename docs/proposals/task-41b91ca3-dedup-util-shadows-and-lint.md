# Dedup remaining `isoNow`/`makeId` shadows and add `lint:no-shadow-util`

## Goal

Three files still carry file-private copies of helpers that already live in
`src/orchestration/util.ts` — leftovers from `task-fc8f0e2b`, which scoped
its dedup narrowly to `src/t3code/server.ts`. Remove the remaining shadows
so the canonical `util.ts` is the single source of truth, and add a small
lint script that fails CI when any future file redefines one of `util.ts`'s
exported helper names. The lint is the durable part: it would have caught
all four of these shadows automatically and prevents the same drift from
recurring.

Related task (predecessor that established the pattern): `task-fc8f0e2b`.

## Acceptance Criteria

- [ ] `src/t3code/index.ts` no longer defines `function isoNow` or
      `function makeId`. Both names are imported from
      `../orchestration/util.ts` and all existing call sites resolve to
      the imported versions (no behavior change).
- [ ] `src/sessions/sweep.ts` no longer defines `function isoNow`. The
      name is imported from `../orchestration/util.ts` (or a
      sibling-relative path that resolves there) and all existing call
      sites resolve to the imported version.
- [ ] `src/sessions/sweep-state.ts` no longer defines `function isoNow`.
      The name is imported from `../orchestration/util.ts` (or
      sibling-relative equivalent) and all existing call sites resolve
      to the imported version.
- [ ] Before each deletion, the file-private body is verified to be
      byte-identical to the corresponding `util.ts` body (recorded in
      the PR description or a commit-message note). If any body diverges,
      stop and surface the divergence — do not silently "normalize."
- [ ] A new `scripts/lint-no-shadow-util.ts` exists, structured like the
      sibling lint scripts (`scripts/lint-contracts.ts`,
      `scripts/lint-template-safety.ts`, `scripts/lint-test-isolation.ts`):
      `#!/usr/bin/env bun` shebang, exported pure helpers, an
      `if (import.meta.main) process.exit(runCli().exitCode)` entry point,
      and a sibling `*.test.ts` covering positive and negative cases.
- [ ] The lint reads the canonical helper-name set **dynamically** from
      `src/orchestration/util.ts` by parsing `^export function NAME` lines
      — it does not hard-code the list. Adding an eighth helper to
      `util.ts` automatically extends the lint's coverage.
- [ ] The lint flags any file outside `src/orchestration/util.ts` whose
      source contains `^(export\s+)?function\s+NAME\s*\(` for one of those
      names, prints `path:line` for each offense, and exits non-zero on
      any offense. `src/orchestration/util.ts` itself, and `*.test.ts`
      files, are excluded (test files commonly redefine helpers in
      fixtures and shouldn't trip the rule).
- [ ] `package.json` has a `lint:no-shadow-util` script entry that runs
      `bun run scripts/lint-no-shadow-util.ts`, matching the pattern of
      the existing `lint:cli-readme`, `lint:contracts`,
      `lint:template-safety`, and `lint:config-reference` entries.
- [ ] `.github/workflows/ci.yml` invokes `bun run lint:no-shadow-util` as
      a separate CI step, alongside the other `lint:*` steps. (The
      top-level `lint` script remains eslint-only — the orphan-tier
      pattern is intentional and not what this task changes.)
- [ ] After all of the above, the full local verification passes:
      `bun run typecheck && bun run lint && bun run lint:no-shadow-util && bun run build && bun test`.
      The new `lint:no-shadow-util` exits 0 on the cleaned tree.

## Context

**Canonical module.** `src/orchestration/util.ts` exports seven helper
functions via `export function`:

```
isoNow, nowEpoch, makeId, slugify, ludicsSelfCommand, sleepMs, setsidWrap
```

It also re-exports `readJsonFile`/`writeJsonFile` from `../json.ts` via
`export { ... } from`, but those aren't `function` declarations and are
out of scope for the lint.

**Shadow sites verified today** (`grep -n "function isoNow\|function makeId"`):

- `src/t3code/index.ts:15` — `function isoNow` (bytes match `util.ts`).
- `src/t3code/index.ts:19` — `function makeId` (bytes match `util.ts`).
- `src/sessions/sweep.ts:31` — `function isoNow` (bytes match `util.ts`).
- `src/sessions/sweep-state.ts:45` — `function isoNow` (bytes match
  `util.ts`).

None of the three files currently imports from
`../orchestration/util.ts`, so each one needs a *new* import line — the
predecessor task's "extend the existing util.ts import" wording was stale.
`src/t3code/index.ts` already has a constellation of relative imports at
the top; the new line slots in there. `src/sessions/sweep.ts` and
`src/sessions/sweep-state.ts` likewise.

**No collisions.** None of the three target files imports any other
symbol named `isoNow` or `makeId`, so adding the canonical import is a
safe insertion.

**Lint-script reference.** `scripts/lint-test-isolation.ts` is the
closest structural template — pure-function `runCli` returning
`{ exitCode, errorCount, warningCount, issues }`, `import.meta.main`
entry point, `*.test.ts` companion. `scripts/lint-contracts.ts` is
similar and is wired into CI; either is fine to mirror.

**`package.json` lint scripts today:**

```
"lint":                  "bun run --bun eslint \"src/**/*.ts\" --max-warnings=0",
"lint:fix":              "bun run --bun eslint \"src/**/*.ts\" --fix",
"lint:cli-readme":       "bun run scripts/lint-cli-readme.ts",
"lint:config-reference": "bun run scripts/lint-config-reference.ts",
"lint:contracts":        "bun run scripts/lint-contracts.ts",
"lint:template-safety":  "bun run scripts/lint-template-safety.ts",
"lint:test-isolation":   "bun run scripts/lint-test-isolation.ts",
"lint:no-mock-module":   "! grep -r 'mock\\.module(' src/ templates/ --include='*.test.ts' -l"
```

The `lint:*` scripts are **not** chained into the top-level `lint` —
each is invoked as its own CI step in `.github/workflows/ci.yml`. The
new entry follows the same convention.

**CI today.** `.github/workflows/ci.yml` invokes these as separate steps:
`lint:cli-readme`, `lint:config-reference`, `lint:template-safety`,
`lint:no-mock-module`, `lint:contracts`, then `lint` (eslint). Note that
`lint:test-isolation` is *not* currently in CI — that's a known gap,
out of scope here (do not "fix" it as part of this task; flag it as a
follow-up if appropriate). The new `lint:no-shadow-util` step *must* be
added to CI, otherwise the lint provides no regression protection.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

This is a structural twin of `task-fc8f0e2b` plus a small new lint script.

**Dedup phase** (one commit, or one per file — coder's choice):

1. For each of the three target files: confirm the file-private body is
   byte-identical to `util.ts`'s version (e.g.,
   `diff <(sed -n 'A,Bp' src/.../target.ts) <(sed -n 'C,Dp' src/orchestration/util.ts)`),
   delete the local definition, and add (or extend) an import line:
   `import { isoNow } from "../orchestration/util.ts";` — or
   `{ isoNow, makeId }` for `t3code/index.ts`.
2. No call-site changes needed: the names stay identical.

**Lint phase** (separate commit, structurally a new lint):

1. Create `scripts/lint-no-shadow-util.ts`. Recommended structure:
   - Export `extractCanonicalNames(utilSource: string): Set<string>` that
     returns the names matched by `^export function (\w+)\s*\(`m.
   - Export `findShadowsInFile(source: string, names: Set<string>): { line: number, name: string }[]`
     that scans `^(export\s+)?function\s+(\w+)\s*\(` line-by-line and
     reports matches against the canonical set.
   - Export `runCli(opts?)` that walks `src/**/*.ts` (use `readdirSync`
     with a `walk` helper, mirroring `lint-test-isolation.ts`), excludes
     `src/orchestration/util.ts` and any path ending in `.test.ts`,
     reads each file once, and prints `path:line  function NAME shadows util.ts`
     per offense.
   - Exit 0 with a green summary on a clean tree; exit 1 with a count
     line on offenses.
   - `if (import.meta.main) process.exit(runCli().exitCode);` entry.
2. Create `scripts/lint-no-shadow-util.test.ts` covering at minimum:
   - `extractCanonicalNames` returns the seven canonical names from a
     synthetic util.ts fixture.
   - `findShadowsInFile` flags `function isoNow(` and `export function makeId(`,
     does not flag `obj.isoNow = ...` or `// function isoNow` in comments.
   - `runCli` on a temp dir with a planted shadow file exits 1 and
     reports the right `path:line`.
   - `runCli` on a temp dir whose only definition is in
     `src/orchestration/util.ts` exits 0.
3. Add the `package.json` entry:
   `"lint:no-shadow-util": "bun run scripts/lint-no-shadow-util.ts"`
   (insert alphabetically among the other `lint:*` entries).
4. Add the CI step to `.github/workflows/ci.yml`, mirroring an existing
   step's shape (e.g., right after `Lint worker/orchestrator contracts`):

   ```yaml
   - name: Lint — no util.ts function shadows
     run: bun run lint:no-shadow-util
   ```

**Order matters slightly:** delete the shadows first, then add the lint —
otherwise the lint would fail in CI on the very PR that introduces it.
A single PR with both commits in that order is fine; CI only sees the
final state of the branch tip per push.

## Scope

**In scope.** The three named files; the new lint script and its test;
the `package.json` entry; the new CI step.

**Out of scope.**
- Any duplications beyond the canonical seven `util.ts` exports.
- Refactoring `util.ts` itself (boundary, exports, naming).
- Rewiring orphan `lint:*` scripts (e.g., adding `lint:test-isolation`
  to CI). That's a separate hygiene task — flag as a follow-up if the
  coder wants to surface it, but do not absorb.
- Class methods or arrow-function shadows (`obj.isoNow = (...) => ...`).
  The MVP regex catches `function NAME` only; broader detection is a
  separate enhancement if it ever proves needed.

**Dependencies.** None blocking. Predecessor `task-fc8f0e2b` already
merged.
