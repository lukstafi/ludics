# lint:vendor-sync: freshen node_modules before comparing

## Goal

Close the recurring `lint:vendor-sync` drift loop where stale local
`node_modules/` masks vendored-package skew until an unrelated PR's CI
surfaces the violation. Make local and CI runs converge on the same
fresh resolution so drift is caught on the PR that introduces it,
not on a bystander PR.

Issue: https://github.com/lukstafi/ludics/issues/531
Related: gh-ludics-440 (the original byte-equality lint this extends).

## Acceptance Criteria

- [ ] `scripts/lint-vendor-sync.ts` spawns `bun install --frozen-lockfile`
  before calling `checkPairs`, gated to skip when **either** `process.env.CI`
  is set **or** `argRoot` (the first positional argv) is provided. The gate
  preserves both CI's no-redundant-install property and hermetic-test
  isolation (existing tmp-root tests must not spawn).
- [ ] Offline / failed-install path is a **hard error**, not a silent skip.
  The spawn's non-zero exit (or non-existent `bun` executable, or any
  thrown error) propagates as a non-zero exit from `lint:vendor-sync` with
  a clear diagnostic of the form *"could not refresh node_modules; vendor
  sync indeterminate"* plus the captured stderr from `bun install` so the
  developer can act. Verification: `find /Users/lukstafi/ludics/scripts -name
  lint-vendor-sync.ts | xargs grep -nE 'indeterminate|frozen-lockfile'` must
  match the diagnostic and the spawn flag.
- [ ] `.github/workflows/ci.yml` `Install dependencies` step adds
  `--frozen-lockfile` (side hygiene fix; bare `bun install` on CI can drift
  the lockfile on a release-bump PR). Verification: `grep -nE
  'bun install( --frozen-lockfile)?' /Users/lukstafi/ludics/.github/workflows/ci.yml`
  shows the flag on every `bun install` line.
- [ ] `scripts/lint-vendor-sync.test.ts` gains a positive regression test
  that drives the spawn path (i.e. exercises the CLI without `argRoot`,
  against a fixture root that simulates the install). The freshen step's
  existence is pinned by an assertion that fails if a future refactor
  removes the spawn. The test must remain hermetic — no real
  network/registry call against the host `node_modules/`; mock the
  spawn (e.g. via a `PATH`-shimmed fake `bun`, an injected runner, or a
  branch that recognises a sentinel env var) or run against a tiny
  pre-populated fixture cache. Reuse the existing `spawnSync` exit-code
  test shape.
- [ ] Existing hermetic tests via `argRoot` remain unchanged: argv-root
  paths do NOT spawn (because `argRoot` is the gate). `bun test
  scripts/lint-vendor-sync.test.ts` continues to pass without any network
  or `node_modules/` mutation.
- [ ] `templates/dashboard/vendor/README.md` step 5 is updated so the
  documented "run after `bun install`" caveat is removed — the lint now
  refreshes `node_modules/` itself. The wording change should be minimal
  (one or two lines) and keep the existing CI-also-runs-it sentence.
- [ ] Manual verification: on a checkout where `bun.lock` has been advanced
  past the installed `node_modules/` (simulate by running `git checkout
  HEAD~1 -- bun.lock` after an install, or by hand-editing a version),
  `bun run lint:vendor-sync` now flags the drift locally. With the previous
  behaviour the lint passed against stale `node_modules/`.

## Context

### How things work now

`scripts/lint-vendor-sync.ts` exports a pure `checkPairs(root, pairs)`
that byte-compares each `vendored`/`upstream` pair from a hard-coded
`PAIRS` array (currently `marked.esm.js` and `purify.es.js`). The CLI
shim under `if (import.meta.main)` reads `process.argv[2]` as an optional
`argRoot` override — present, the lint runs against that root (the
gate used by hermetic tests); absent, the lint runs against the
repo root computed via `import.meta.dir`.

`scripts/lint-vendor-sync.test.ts` builds tmp-root fixtures via
`makeFixture`, drives `checkPairs` with synthetic `TEST_PAIRS`, and
also has a `spawnSync` CLI test that invokes the script with the
argv-root override to exercise the exit-code path. The argv-root path
is what currently signals "test mode" — i.e. *the test never touches
the real `node_modules/` or the host's network*.

`.github/workflows/ci.yml` step `Install dependencies` runs bare
`bun install`. Later in the lint chain, `Lint — vendor sync` runs
`bun run lint:vendor-sync`. `package.json` declares
`"lint:vendor-sync": "bun run scripts/lint-vendor-sync.ts"`.

`templates/dashboard/vendor/README.md` step 5 currently asks for a
manual `bun run lint:vendor-sync` after step 1's `bun add` and steps
2–3's `cp` invocations.

### Why drift recurs

`bun install` (without `--frozen-lockfile`) is permissive: it leaves
files in place when the lockfile's resolution does not demand
re-fetching that specific version. On a long-lived dev checkout,
`node_modules/dompurify/` can persist as the older build even after
`bun.lock` is rewritten to a newer version by a transitive bump
(e.g. `isomorphic-dompurify@3.10.0` carrying `dompurify@^3.4.1`).
`lint:vendor-sync` then passes locally — vendored copy matches stale
`node_modules/` — and the drift surfaces on CI, on an unrelated PR.

### Code pointers (by symbol, not line number)

- `scripts/lint-vendor-sync.ts` — `checkPairs(root, pairs)`, the
  `import.meta.main` CLI block, and the `argRoot = process.argv[2]`
  override. Spawn site for the freshen step.
- `scripts/lint-vendor-sync.test.ts` — `makeFixture`, `TEST_PAIRS`,
  and the existing `spawnSync` exit-code test (the shape to extend
  with the positive freshen-step regression).
- `.github/workflows/ci.yml` — `Install dependencies → bun install`.
- `package.json` — `lint:vendor-sync` script entry.
- `templates/dashboard/vendor/README.md` — step 5 of the bump ritual.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The user picked **Option 1a** from the elaboration menu (spawn lives
inside the lint script, gated by `process.env.CI` OR `argRoot`), plus
the **side hygiene fix** in `ci.yml`, plus **hard-fail on offline**.

Concretely:

1. In `scripts/lint-vendor-sync.ts`, before calling `checkPairs(root)`
   in the `import.meta.main` block, compute
   `const shouldFreshen = !argRoot && !process.env.CI;` and, when true,
   spawn `bun install --frozen-lockfile` synchronously (e.g. via
   `Bun.spawnSync` or `node:child_process` `spawnSync`) with stdio
   inherited or captured. On non-zero exit (or thrown error), print the
   diagnostic ("could not refresh node_modules; vendor sync
   indeterminate") plus the captured stderr and `process.exit(1)`
   before any `checkPairs` call.
2. In `.github/workflows/ci.yml`, change `bun install` to
   `bun install --frozen-lockfile` on the `Install dependencies` step.
3. In `scripts/lint-vendor-sync.test.ts`, add one new test that drives
   the script without `argRoot` but with a controlled environment that
   either (a) shims `PATH` so the spawned `bun` is a tiny script that
   records its invocation and exits 0, or (b) uses an injected runner
   if the script is refactored to accept one, or (c) sets a sentinel
   env var the script recognises in a TEST-only branch. Whichever
   mechanism is chosen, the test must remain hermetic and the
   freshen-step's existence must be pinned by an assertion.
4. In `templates/dashboard/vendor/README.md`, trim step 5's wording
   so it no longer implies the developer must have just run
   `bun install` — the lint now does it.

The spawn shim should:
- use `--frozen-lockfile` unconditionally (never write the lockfile);
- capture stderr so the hard-fail diagnostic carries the underlying
  `bun install` error;
- not silently fall back to the stale-comparison path.

## Scope

In scope:
- `scripts/lint-vendor-sync.ts` spawn + gate logic.
- `scripts/lint-vendor-sync.test.ts` positive regression.
- `.github/workflows/ci.yml` `--frozen-lockfile` hygiene.
- `templates/dashboard/vendor/README.md` step 5 wording.

Out of scope:
- Option 2 (diff-paired lockfile/vendored co-change lint). The user
  did not pick it; revisit only if Option 1a proves insufficient.
- Option 3 (CI auto-resync via `cp` + `git diff --exit-code`). Same.
- New vendored libraries beyond the existing two `PAIRS` entries.
- Any behavioural change inside `checkPairs` itself — the function
  stays pure.
- Bun-cache integrity hardening. `--frozen-lockfile` closes the
  common failure mode; rare bun-cache poisoning is not in scope.

Dependencies:
- Relates to gh-ludics-440 (original `lint:vendor-sync` lint).
- No blocking task; this can ship independently.
