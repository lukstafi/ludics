# Repo-wide eslint cleanup — drop baseline to zero, wire `bun run lint` into CI

## Goal

Drive the ludics `src/` eslint baseline from its current ~704 errors to zero in a single repo-wide PR, then wire `bun run lint` into `.github/workflows/ci.yml` as a durable invariant. After this PR lands, every future PR's "did I add new lint errors?" verification step becomes the CI itself, and the baseline-framing discipline added by issue #334 can retire.

## Acceptance Criteria

- `bun run lint` exits 0 against `src/**/*.ts` (currently exits 1 with ~704 errors).
- `eslint.config.js` has a new `files: ["src/**/*.test.ts", "templates/**/*.test.ts"]` override block (or extends the existing one at lines 34–47) that disables, for test files only:
  - `@typescript-eslint/no-unsafe-member-access`
  - `@typescript-eslint/no-unsafe-call`
  - `@typescript-eslint/no-unsafe-assignment`
  - `@typescript-eslint/no-unsafe-argument`
  - `@typescript-eslint/no-unsafe-return`
  - `@typescript-eslint/no-explicit-any`
- `.github/workflows/ci.yml` runs `bun run lint` as a step in the `build` job, matching the pattern of the existing four `lint:*` steps (lines 28–38). Place it after the existing `Lint` steps.
- All production-code fixes are hand-written; no widescale `eslint-disable` on prod files. Per-line `eslint-disable-next-line` is acceptable only for genuinely necessary cases (lazy-require in circular-dep contexts), and each must carry a `-- <reason>` comment.
- The PR body includes a short table of lazy-require call-sites (the 50 `no-require-imports` errors) showing per-site disposition: refactored to top-level import, or annotated with `eslint-disable-next-line` plus the reason (circular dep, init order, etc.).
- No new `any` types introduced in production code (intentional explicit `any` is OK if justified inline).
- All existing tests still pass (`bun test` is green).
- `bun run typecheck` and `bun run build` still pass.

## Context

Four recent retrospectives (`task-f9c2cb2f`, `task-9f21d3de`, `gh-ludics-314`, `task-b4a0d1f9`) all flagged the same friction: every unrelated PR pays a "no new lint errors" verification tax against a ~679-error baseline. Issue #334 added baseline-framing discipline to skill prompts as a workaround. This task removes the underlying debt so the workaround can retire.

Re-measured baseline (2026-04-24): **704 errors** (drift of +27 since the elaboration's 677 reading two days ago — confirms the "tax compounds" problem). Zero auto-fixable: `eslint --fix-dry-run` reports `fixable: 0` for every rule. Rule breakdown by current count:

| Errors | Rule |
|-------:|------|
| 221 | `@typescript-eslint/no-unsafe-member-access` |
| 176 | `@typescript-eslint/no-unsafe-call` |
| 118 | `@typescript-eslint/no-unsafe-assignment` |
|  51 | `@typescript-eslint/no-unused-vars` |
|  50 | `@typescript-eslint/no-require-imports` |
|  32 | `@typescript-eslint/no-floating-promises` |
|  17 | `@typescript-eslint/no-explicit-any` |
|  14 | `no-empty` |
|  14 | `@typescript-eslint/no-unsafe-argument` |
|   6 | `prefer-const` |
|   5 | `@typescript-eslint/no-unsafe-return` |

Test/prod split from the elaboration: ~78% of errors live in `*.test.ts` files. The user-approved strategy ("C-relaxed" from the questions section) is to disable the `no-unsafe-*` family AND `no-explicit-any` in test files via one `eslint.config.js` override, collapsing ~530 errors with one config change, then hand-fix the remaining ~150 production errors.

**In-flight PR coordination**: At elaboration time, four open PRs touched `src/orchestration/` and `src/slots/` (the biggest offender clusters). As of this proposal, those have largely landed — only PR #112 (test-only frontmatter regression) is still open and doesn't touch the cleanup hot-spots. The "no parallel cleanup work while this is in flight" constraint from Q1 still applies: the coder should pause unrelated cleanup task launches in the same area until this PR merges, and re-measure on rebase.

## Approach

Five-phase plan, ordered to minimize review burden and merge risk.

### Phase 1 — Test-file override (collapses ~530 errors)

Edit `eslint.config.js`. Extend the existing test-file override block at lines 34–47 (or add a new block) to disable the six rules listed in Acceptance Criteria. Commit as the first commit of the PR with message like `chore(lint): relax type-safety rules in test files`. After this commit, `bun run lint` should report ~150 errors instead of 704 — much easier review baseline for the rest.

Rule preservation note: keep `@typescript-eslint/no-floating-promises` enforced in tests (the 29 in `src/slots/index.test.ts` stay in scope — they're real promise-handling bugs and mechanical to fix with `void` / `await`).

### Phase 2 — Hand-fix remaining prod errors by file cluster

Walk the remaining ~150 prod errors in priority order. The hot-spots are stable from elaboration:

- `src/cluster-http.ts` (~33): mostly `await req.json()` / handler-body `any` leaks plus 10 lazy `require()`. Add request-body types or narrow with `typeof === "object"` guards. Several `require()` calls duplicate top-level imports (e.g. `require("./config.ts")` when `loadConfigSync` is already imported, `require("fs")` for `readdirSync` / `unlinkSync` / `appendFileSync`); those collapse to top-level `import` additions and are pure wins.
- `src/mag.ts` (~21): 6 `no-unused-vars` (drop or prefix `_`), 5 `prefer-const`, remainder unsafe-* around config lookups and journal entries (narrow with type guards).
- `src/slots/index.ts` (~11): 3 lazy `require()` (`./migration.ts`, `../cluster.ts`, `../t3code/index.ts`). The `../cluster.ts` import is already top-level for `clusterMachine` / `heartbeatIsFresh` — adding `clusterIsController` to the existing import is mechanical. The other two need circular-dep checks before refactoring.
- `src/adapters/*` (~15): mix of unused-var, empty-catch, unsafe-assignment from adapter-boundary `any`. Mostly mechanical.
- `src/t3code/server.ts` (~12), `src/sessions/*` (~2), other small clusters: same patterns.
- `src/slots/index.test.ts` floating-promises (~29 if not relaxed by Phase 1; check after Phase 1 lands): mechanical `void` / `await` additions.

For `no-empty` (14 errors, mostly empty `catch {}`): add a `/* ignore */` body comment or an explicit `_e` parameter as the codebase already does in some spots.

### Phase 3 — Lazy-require disposition

For each of the 50 `no-require-imports` errors, attempt top-level import first. If a refactor would (a) introduce a new circular dependency, (b) reorder module init in a way that breaks startup, or (c) require nontrivial restructuring, fall back to:

```ts
// eslint-disable-next-line @typescript-eslint/no-require-imports -- <reason>
const { foo } = require("./bar.ts");
```

Build a per-site table for the PR body. Format:

| File:Line | Required module | Disposition | Reason |
|-----------|-----------------|-------------|--------|
| `cluster-http.ts:145` | `./config.ts` (`stateRepoDir`) | refactored | already imported at top-level; consolidate |
| `cluster-http.ts:164` | `fs` (`unlinkSync`) | refactored | promote to top-level import |
| ... | ... | ... | ... |

Initial spot-check (from this proposal's verification): at least 5 of the 10 `cluster-http.ts` requires are duplicate `fs` builtins or already top-level-imported same-package modules — strong refactor candidates. The `slots/index.ts:100` `clusterIsController` require is also a refactor candidate (same module already imported at line 23). The `mag.ts` requires for `cluster-http.ts` and `cluster.ts` are the higher-risk ones (Mag boots before HTTP server in some init paths) — likely `eslint-disable` annotation territory.

### Phase 4 — CI wiring

Edit `.github/workflows/ci.yml`. Add after the existing `Lint — no mock.module() in tests` step (after line 38):

```yaml
      - name: Lint — eslint
        run: bun run lint
```

Place this last so the cheaper / faster lint:* checks fail first on bad PRs.

(Out of scope: wiring `lint:contracts` — already filed as `task-d2d259fc`.)

### Phase 5 — Pre-merge rebase

Before merging:
1. Rebase against `origin/main`.
2. Re-run `bun run lint`. If new errors appeared (other PRs merged with rule violations) — patch them in this PR. The merge invariant flips here, so the PR's job is to land a zero-error tree.
3. Confirm `bun test`, `bun run typecheck`, `bun run build` all pass.
4. Merge.

## Out of Scope

- `lint:contracts` CI wiring — filed as follow-up `task-d2d259fc`.
- Rewriting `eslint.config.js` to use a different ruleset philosophy (just relax test-file rules, leave the core rule choices alone).
- Introducing typed test helpers for `spyOn` / `JSON.parse` patterns — the test-file relaxation makes this unnecessary now (could be a future "improve test type safety" task if desired).
- Changes to the existing `no-restricted-syntax` rule against `mock.module()` (preserve as-is).

## Regression Tests

The CI step (`bun run lint`) added in Phase 4 *is* the regression test — once the baseline is zero, any future PR that introduces an eslint error will fail CI. No additional smoke test is needed; the failure mode is loud and obvious.

(Optional: a tiny `scripts/check-test-override-present.ts` that asserts the test-file override block exists in `eslint.config.js`. Skip unless reviewer requests — the lint failure on accidental removal would be loud enough.)
