# Git-runner API follow-ups: withCheckout compile-time async rejection + expandHome consolidation + drop briefing-lag re-exports

## Goal

Three post-merge cleanups on the `src/git-runner.ts` API surface established by
PR #366 (task-b0d4f45b). Each item is independent and small; bundling them keeps
the review surface local to `git-runner.ts` and a handful of consumers.

1. Replace `withCheckout<T>`'s runtime thenable guard with a compile-time type
   constraint.
2. Collapse `expandHome` (git-runner.ts) and `expandHomePath`
   (sessions/sweep-state.ts) into a single helper.
3. Remove the transitional `briefing-lag.ts` re-exports of symbols that now
   live in `git-runner.ts`.

Source: retrospective of task-b0d4f45b — `suggestRefactorSummary` items 1, 3, 4
flagged by the coder after PR #366 merged.

## Acceptance Criteria

### Item 1 — `withCheckout` compile-time async rejection

- [ ] `withCheckout<T>` in `src/git-runner.ts` has its `fn` parameter typed as
  `() => T extends PromiseLike<unknown> ? never : T` so that calling it with
  an `async` callback (or a callback returning a `Promise`) fails to typecheck.
- [ ] The runtime `isThenable` helper and both `.then`-sniffing branches inside
  `withCheckout` are deleted entirely — not retained as belt-and-braces.
- [ ] The two regression tests in `src/git-runner.test.ts` that exercised the
  runtime guard via `as unknown as number` / `as unknown as string` casts are
  converted to `@ts-expect-error` compile-time assertions (or removed if the
  compile-time rejection is covered by a single `@ts-expect-error` case).
- [ ] The other `withCheckout` tests (restore on exception, checkout-failure,
  skip-when-already-on-target, detached-HEAD restore) continue to pass
  unchanged.

### Item 2 — `expandHome` consolidation

- [ ] `src/git-runner.ts` `expandHome` is rewritten to use `resolve` semantics:
  `raw.startsWith("~/") ? resolve(HOME ?? "~", raw.slice(2)) : resolve(raw)`.
  This makes the output absolute + normalized for all inputs, subsuming the
  behaviour previously provided by `expandHomePath` in
  `src/sessions/sweep-state.ts`.
- [ ] `expandHomePath` in `src/sessions/sweep-state.ts` is deleted;
  `normalizeProjectDirForSweep` imports and calls `expandHome` from
  `../git-runner.ts` instead. The sole call-site contract (feed
  `isGitWorktree` / `getMainRepoFromWorktree` with an absolute path) is
  preserved.
- [ ] The existing `expandHome` unit test in `src/git-runner.test.ts` is
  updated to reflect the new semantics: `expandHome("~/work/foo")` still
  produces `$HOME/work/foo`; `expandHome("/abs/path")` still produces
  `"/abs/path"`; the `expandHome("relative")` assertion is updated to expect
  `resolve("relative")` (i.e. `<cwd>/relative`) or is replaced with an
  equivalent assertion covering the normalizing behaviour (`..` collapse,
  trailing-slash normalization). A new test or subcase covers the
  normalization of `~/foo/../bar` or a trailing slash.
- [ ] No production caller's output changes: the two production call-sites
  (`src/briefing-lag.ts` `formatUpstreamLagSection` and `src/staging-ff.ts`
  `maybeFastForwardStagingFromUpstream` / `syncStagingMainWithUpstream`) feed
  config-declared project paths (absolute or `~/…` in normal use), for which
  `resolve` and `join` yield the same result.

### Item 3 — Drop `briefing-lag.ts` transitional re-exports

- [ ] The three re-export statements at the top of `src/briefing-lag.ts` —
  `export { detectDefaultBranches, defaultRunGit };`,
  `export type { RunGit };`,
  `export type { DetectedBranches, RunGitResult } from "./git-runner.ts";`
  (plus the comment preceding them) — are removed.
- [ ] `src/briefing-lag.test.ts` imports `detectDefaultBranches` and
  `type RunGit` from `./git-runner.ts`; imports of `formatUpstreamLagSection`
  and `parseLeftRightCount` continue to come from `./briefing-lag.ts`.
- [ ] `src/staging-ff.test.ts` imports `type { RunGit }` from
  `./git-runner.ts` (currently from `./briefing-lag.ts`).
- [ ] `src/mag.test.ts` imports `type { RunGit }` from `./git-runner.ts`
  (currently from `./briefing-lag.ts`).
- [ ] `src/mag.ts` import of `formatUpstreamLagSection` from
  `./briefing-lag.ts` is unchanged (this is a native briefing-lag export).
- [ ] No other importers of briefing-lag exist — the grep above exhausts the
  call sites.

### Cross-cutting

- [ ] `bun run typecheck && bun run lint && bun run build && bun test` all
  pass.
- [ ] Delivered as one PR. Commit boundaries are a plan-phase decision; a
  natural split is three commits (one per item) for reviewability, but the
  reviewer may prefer fewer if the diffs interleave cleanly.

## Context

### Item 1 code pointers

- `withCheckout<T>` — `src/git-runner.ts`, exported function near the bottom
  of the file; signature currently `(cwd: string, targetBranch: string,
  runGit: RunGit, fn: () => T): T`.
- `isThenable` — private helper just above `withCheckout` in
  `src/git-runner.ts`; only caller is `withCheckout` itself.
- Two `.then`-sniffing branches inside `withCheckout`: one on the "already on
  target branch" fast-path after invoking `fn()`, one inside the
  `try { … } finally { … }` block after the checkout.
- Regression tests to convert — `src/git-runner.test.ts`, the two cases
  whose titles begin `"rejects async callbacks"`. Each uses the idiom
  `() => Promise.resolve(42) as unknown as number`. The cast is the smell;
  `@ts-expect-error` on `async () => 42` (or `() => Promise.resolve(42)`)
  asserts the same contract at compile time.
- TypeScript version: `"typescript": "^5.7"` per `package.json`. Conditional
  types on parameter annotations have been supported since much earlier TS
  versions; no version concern.

### Item 2 code pointers

Current `expandHome` — `src/git-runner.ts`:

```ts
export function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return path;
}
```

Current `expandHomePath` — `src/sessions/sweep-state.ts`:

```ts
function expandHomePath(raw: string): string {
  if (raw.startsWith("~/")) return resolve(process.env.HOME ?? "~", raw.slice(2));
  return resolve(raw);
}
```

Behavioural diff (`expandHomePath` is strictly stronger):

| Input | `expandHome` (current) | `expandHomePath` |
|-------|------------------------|------------------|
| `~/foo` | `join(HOME, "foo")` | `resolve(HOME, "foo")` |
| `/abs/foo` | `"/abs/foo"` as-is | `"/abs/foo"` (same result) |
| `relative` | `"relative"` (stays relative) | `<cwd>/relative` (absolute) |
| `~/a/../b` | `"$HOME/a/../b"` (unnormalized) | `"$HOME/b"` (normalized) |
| `/a/` (trailing slash) | preserved | normalized away |

Call-site inventory for `expandHome` (from grep):

- `src/briefing-lag.ts` inside `formatUpstreamLagSection`, applied to
  `p.path` from project config.
- `src/staging-ff.ts` inside the staging fast-forward worker, applied to
  `p.path` from project config.

Both receive config-declared project paths. There is no production code path
where a project's `path` is a relative string that must *stay* relative. The
one place that does assert the relative-stays-relative behaviour is the unit
test `expandHome: expands ~/ prefix using $HOME` in `src/git-runner.test.ts`
(asserts `expandHome("relative") === "relative"`); the test needs updating
alongside the source change.

Call-site inventory for `expandHomePath`:

- Only `normalizeProjectDirForSweep` in `src/sessions/sweep-state.ts`, whose
  downstream consumers `isGitWorktree` / `getMainRepoFromWorktree` require
  absolute paths.

### Item 3 code pointers

Re-export block in `src/briefing-lag.ts` (lines near the top after the
imports):

```ts
// Re-exports so existing importers of briefing-lag's public surface keep
// working.
export { detectDefaultBranches, defaultRunGit };
export type { RunGit };
export type { DetectedBranches, RunGitResult } from "./git-runner.ts";
```

Exhaustive importers of the re-exported symbols (from
`grep -rn "from \"./briefing-lag.ts\"" src/`):

- `src/briefing-lag.test.ts` — imports `formatUpstreamLagSection`,
  `parseLeftRightCount`, `detectDefaultBranches`, and `type RunGit`. Only the
  first two are native to briefing-lag; the latter two must switch.
- `src/staging-ff.test.ts` — `import type { RunGit } from "./briefing-lag.ts"`
  must switch.
- `src/mag.test.ts` — `import type { RunGit } from "./briefing-lag.ts"`
  must switch.
- `src/mag.ts` — `import { formatUpstreamLagSection } from "./briefing-lag.ts"`
  stays (native export).

Circular-dep check: `git-runner.ts` does not import from `briefing-lag.ts`
(it has no cross-module imports beyond `path` and `./spawn.ts`); dropping the
re-exports removes an edge without creating a cycle.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Plausible commit ordering (one PR, three commits):

1. **Item 1 (withCheckout):** add the conditional-type constraint, delete
   `isThenable` and both `.then`-branches, convert the two regression tests
   to `@ts-expect-error`.
2. **Item 2 (expandHome):** rewrite `expandHome` to use `resolve`, update its
   unit test to match, delete `expandHomePath` from sweep-state.ts and import
   `expandHome` there.
3. **Item 3 (re-exports):** update the three importer files to pull from
   `./git-runner.ts`, delete the re-export block (and its preceding comment)
   from `briefing-lag.ts`.

Each commit should independently pass `bun run typecheck && bun run lint &&
bun run build && bun test`. Per-item size is roughly 15 source lines plus a
few test lines.

## Scope

**In scope**:
- `src/git-runner.ts` (withCheckout signature, delete `isThenable`, rewrite
  `expandHome`).
- `src/git-runner.test.ts` (convert async-rejection regression tests to
  `@ts-expect-error`; update the `expandHome("relative")` assertion;
  optionally add a normalization case).
- `src/sessions/sweep-state.ts` (delete `expandHomePath`, import `expandHome`
  from `../git-runner.ts`, remove now-unused `resolve` import if no other
  callers remain).
- `src/briefing-lag.ts` (remove the three re-export lines + preceding
  comment).
- `src/briefing-lag.test.ts`, `src/staging-ff.test.ts`, `src/mag.test.ts`
  (switch re-export imports to `./git-runner.ts`).

**Out of scope** (per task body, explicit):
- `suggestRefactor` item 2 — `magSentinel(name)` path-construction factory
  (deferred to the next `mag.ts` cleanup task).
- `suggestRefactor` item 5 — `defaultRunGit` `trim` default flip (coder
  defers as "not urgent").
- `suggestRefactor` item 6 — merge-conflict forecast checklist (process
  discipline, not code).

**Dependencies**:
- `relates_to`: task-b0d4f45b (PR #366 — landed the main `git-runner.ts`
  consolidation that created the API surface this task polishes).
- No `blocked_by`; no `blocks`.
