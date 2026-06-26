# Tests must not mutate production state: isolate the real `bun install` seam in the suite

## Goal

A whole-suite `bun test` run must never mutate real, shared system state — in
particular the live `node_modules/` and `bun.lock`. Today it can: one test
shells out to a real `bun install --frozen-lockfile` against the repo's own
checkout. When the suite runs on a machine that also serves production (the
console/dashboard host), or when two whole-suite runs overlap, that real
install races to link packages into the shared `node_modules`/Bun cache and
fails (`error: Failed to link marked: EEXIST`, also `tldts`, `typescript`),
corrupting the install and false-failing unrelated tests.

This is the production-safety prong of GitHub issue
[lukstafi/ludics#615](https://github.com/lukstafi/ludics/issues/615): *tests
must not be able to break production.* The same-day decision to disable worker
slots on the console machine has the same motive — a test suite running where
the live dashboard runs must not corrupt the live system.

> "focus on the prong of the web server fix where we don't allow tests to break
> production." — user, 2026-06-26

The broader concurrency-false-fail class (the ~15 `join(import.meta.dir,
".test-tmp-…")` fixture files that make tests break *each other* under
concurrency) is explicitly **out of scope** here — see Scope / Non-Goals.

## Acceptance Criteria

Criteria express intent (the invariant), not a mechanism. The implementer
chooses how to satisfy them.

1. **No production dependency mutation from the suite.** Running the whole
   `bun test` suite does not spawn a real `bun install` (or any command that
   writes/relinks) against the repository's real, shared `node_modules/` or
   `bun.lock`. The install seam currently driven by
   `scripts/lint-vendor-sync.test.ts`'s `CLI integration > exits 0 against the
   current repo (vendored copies match upstream)` test is isolated so it can no
   longer touch the shared install.

2. **Concurrency-safe at this seam.** Two whole-suite `bun test` runs executing
   concurrently do not corrupt each other through this install seam — neither
   run produces an `EEXIST`/link failure (or a downstream dynamic-import
   failure) attributable to the vendor-sync freshen racing the shared
   `node_modules/`.

3. **Coverage of the real freshen behavior is preserved.** The production gate
   that the vendor-sync lint already enforces — that `bun install
   --frozen-lockfile` runs before the byte-compare when neither `argRoot` nor
   `CI` is set, is skipped when either is set, and hard-fails (without reaching
   `checkPairs`) when the install fails — remains verified. The existing
   `PATH`-shim / fake-`bun` tests in `scripts/lint-vendor-sync.test.ts` already
   exercise these paths hermetically; isolating AC-1's seam must not weaken
   them.

4. **The fix is observable at the seam.** A regression that reintroduces a real
   shared-`node_modules` install from the suite is caught — either because the
   isolated test would visibly fail/race again, or via the optional guardrail
   (see Scope). The implementer states, in the test or a comment, the invariant
   being protected ("this test must not run a real `bun install` against the
   shared `node_modules`").

## Context

**The seam.** `scripts/lint-vendor-sync.ts`'s `import.meta.main` block computes
`shouldFreshen = !argRoot && !process.env.CI`; when true it calls
`freshenNodeModules(repoRoot)`, which `Bun.spawnSync`s `["bun", "install",
"--frozen-lockfile"]` with `cwd = repoRoot` — the **real repo root**, mutating
the real shared `node_modules/`. The gate deliberately has no production knob:
only `argRoot` or `CI` suppress the freshen.

**The one test that trips it.** `scripts/lint-vendor-sync.test.ts` →
`describe("CLI integration")` → `test("exits 0 against the current repo
(vendored copies match upstream)")` spawns `bun run lint-vendor-sync.ts` with
**no positional arg** and **no `CI` override / no `PATH` shim**, `cwd` = repo
root. So under a normal local/agent run (`CI` unset), it executes the real
`bun install --frozen-lockfile` against the live install. This is the only
suite seam that mutates real shared dependency state; a repo-wide check
confirms no other test shells out to a real `bun install`, global git config,
or the real `$HOME`.

**The freshen is already hermetically covered.** The same file's later tests
(`bare no-argRoot CLI freshens with 'bun install --frozen-lockfile' before
checkPairs`, the hard-fail-ordering test, and the `argRoot`/`CI` gate-proof
tests) drive the freshen path through a `PATH`-shimmed fake `bun`
(`makeFakeBun`) that records argv to a sentinel or fails with a sentinel
stderr — **never touching the host's `node_modules/`**. So the real install in
the `exits 0 against the current repo` test is redundant production coverage,
not the load-bearing proof of the freshen contract. This is why the fix is
expected to be small.

**Related but separate.** This descends from the same feedback as
`task-61b5ace9` / PR #614 (the `worktrees.test.ts` `mkdtempSync` fix) but is a
different vector: #614 isolated a per-process temp dir; this isolates a
real-shared-resource mutation, which a per-process temp dir cannot fix.

Key files:
- `scripts/lint-vendor-sync.ts` — `freshenNodeModules`, the `import.meta.main`
  `shouldFreshen` gate, `DEFAULT_FRESHEN_CMD`.
- `scripts/lint-vendor-sync.test.ts` — the offending `exits 0 against the
  current repo` test; the existing `makeFakeBun` `PATH`-shim infrastructure to
  mirror if an isolated install is chosen.
- `scripts/lint-test-spawn-coverage.ts`, `scripts/lint-test-isolation.ts` —
  existing test-hygiene lints (precedent/home for the optional guardrail).
- `docs/testing-patterns.md#harness-isolation` — isolation doctrine.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The two treatments the user pre-approved (issue Q2):

- **(b) Skip the real freshen for the suite, keep one dedicated proof.**
  Make the `exits 0 against the current repo` test invoke the CLI with a marker
  that suppresses the freshen — pass the existing gate (e.g. set `CI` in that
  test's `env`, or thread a dedicated skip marker), so it only byte-compares
  the already-present `node_modules/` (which is what that test actually
  asserts). The freshen *behavior* stays covered by the existing hermetic
  `PATH`-shim tests, so no coverage is lost. This is the cheapest path and is
  expected to suffice.

- **(c) Per-process isolated install.** If a test genuinely must exercise a
  real install, point it at a throwaway copy of the repo layout (mirroring the
  `makeFakeBun` / `mkdtempSync` pattern already in the file) with `cwd` set to
  that copy, so the install can never reach the shared `node_modules/`.

Prefer **(b)**: the freshen contract is already independently and hermetically
proven, making the real install in this one test redundant rather than
load-bearing. Pick (c) only if a real end-to-end install assertion is judged
worth keeping.

## Scope / Non-Goals

**In scope (must-ship):** isolating the single real-`bun install` seam so the
whole-suite `bun test` cannot mutate the shared `node_modules`/lockfile
(Vector B), while preserving the existing hermetic freshen-gate coverage.

**Optional guardrail (include only if small):** a lint — most naturally an
extension of `scripts/lint-test-isolation.ts` or a sibling of
`scripts/lint-test-spawn-coverage.ts` — that flags a test shelling out to a
real `bun install` (or writing the real `node_modules` / global git config /
real `$HOME`) without isolation. This targets the **production** class, not the
`.test-tmp` class. If it is more than a small add, **defer it** to its own
task; the Vector B isolation is the must-ship deliverable and must not be held
up by the lint.

**Out of scope (deferred to a separate follow-up task):**

- The broad sweep of the ~15 `join(import.meta.dir, ".test-tmp-…")` fixed
  in-source fixture directories to per-process roots (Vector A). These make
  tests break *each other* under concurrency (cosmetic false-fails), **not**
  production. Tracked separately at lower priority.
- A Rule-4 `lint-test-isolation.ts` check flagging in-source `.test-tmp` roots.
  It belongs with the Vector A sweep (adding it now would force that sweep) and
  is therefore excluded here.

These exclusions are deliberate: the production-safety invariant is achievable
with a tight, low-risk change confined to the vendor-sync lint and its test.
