# Unify `detectDefaultBranches` and `detectDefaultBranchesAuthoritative` in `git-runner.ts`

## Goal

`src/git-runner.ts` exports two near-identical functions — `detectDefaultBranches` (local-only) and `detectDefaultBranchesAuthoritative` (adds an `ls-remote --symref` network tier between the local-symref probe and the main/master fallback). The two share the same `read(remote)` closure, the same `{ origin, upstream }` return shape, and the same null semantics; only one middle tier differs. Carrying two exports for an 80%-identical implementation is unnecessary maintenance surface, surfaced as a code-level item in `task-87e7dc36`'s retrospective.

Unify them into a single function with an opt-in flag whose name conveys the I/O contract at the call site, so a reader of `staging-ff.ts` sees "this path performs network I/O" without consulting JSDoc.

## Acceptance Criteria

- [ ] `src/git-runner.ts` exports a single `detectDefaultBranches(cwd, runGit, opts?: { authoritativeIO?: boolean }): DetectedBranches`. The previously-exported `detectDefaultBranchesAuthoritative` is removed.
- [ ] When `authoritativeIO` is omitted or `false`, the function performs zero `git ls-remote` invocations — bit-for-bit equivalent to today's `detectDefaultBranches`. Briefing-lag's per-tick git budget does not regress.
- [ ] When `authoritativeIO: true`, the tier order is: local `symbolic-ref refs/remotes/<r>/HEAD` → `ls-remote --symref <r> HEAD` (parsed with the existing `/^ref:\s+refs\/heads\/(.+?)\s+HEAD\b/m` regex) → `rev-parse --verify --quiet refs/remotes/<r>/{main,master}` → null. Same as today's `detectDefaultBranchesAuthoritative`.
- [ ] The function's JSDoc explicitly documents that `authoritativeIO: true` performs up to N network round-trips (one `ls-remote` per remote queried, i.e. 2 for the `{ origin, upstream }` pair when both remotes are present); default `false` is local-only with no network I/O. The "IO" suffix in the option name is load-bearing — a comment on the option may explain why.
- [ ] Call sites updated:
  - `src/briefing-lag.ts` (`formatUpstreamLagSection`): unchanged call shape — `detectDefaultBranches(path, opts.runGit)` continues to work because `authoritativeIO` defaults to `false`.
  - `src/orchestration/index.ts` (`resolveDiffBase` inside `orchDiff`): unchanged call shape.
  - `src/orchestration/skills.ts` (`proposalFreshnessWarning`): unchanged call shape.
  - `src/staging-ff.ts` (sole production caller of the network tier): switches to `detectDefaultBranches(path, opts.runGit, { authoritativeIO: true })` and drops the `detectDefaultBranchesAuthoritative` import.
- [ ] Tests updated:
  - `src/git-runner.test.ts`: the four `detectDefaultBranchesAuthoritative` tests (lines ~86–143) are rewritten to call `detectDefaultBranches("/x", rg, { authoritativeIO: true })`. The test names update to reflect the new shape (e.g. `"detectDefaultBranches authoritativeIO: prefers local symbolic-ref when present"`). The three pre-existing local-only `detectDefaultBranches` tests (lines ~60–82) keep their current call shape unchanged. The `detectDefaultBranchesAuthoritative` import is removed.
  - `src/briefing-lag.test.ts`: unchanged — still imports and calls `detectDefaultBranches` with two args.
- [ ] `bun run typecheck && bun run lint && bun run build && bun test` all pass. The 9 tests across `git-runner.test.ts` and `briefing-lag.test.ts` that directly assert `detectDefaultBranches[Authoritative]` behaviour, plus any orchestration tests added in gh-ludics-374 that exercise the same code path, continue to pass.
- [ ] No grep hit for `detectDefaultBranchesAuthoritative` remains anywhere in `src/` or `dashboard/` after the change. Files under `docs/proposals/` and `retrospectives/` are design records and may still mention the symbol: this proposal itself necessarily references the migration target by name; the sibling `resolve-base-ref-helper.md` is task-b6bca25c's authoritative record of folding the function (now landed in main commit `6f53c24`); `consolidate-git-and-sentinel-helpers.md` is the historical record of the symbol's introduction. Editing those proposal-history files to scrub the name would falsify the design record. The intent of this AC is "no remaining live consumers" — satisfied once `src/` is clean.

## Context

### Files

- `src/git-runner.ts` — defines `detectDefaultBranches` and `detectDefaultBranchesAuthoritative`. Same file holds `RunGit`, `RunGitResult`, `DetectedBranches` types, and the `defaultRunGit` production runner.
- `src/staging-ff.ts` — the only production caller of the authoritative variant. Calls it immediately after `git fetch upstream --quiet`, when the connection/credentials are warm. The result feeds `withCheckout(branches.origin, …)` and a subsequent `git merge --ff-only upstream/${branches.upstream}`; both branch names are load-bearing for staging fast-forward correctness on remotes whose true default is neither `main` nor `master` and which lack a local symref.
- `src/briefing-lag.ts` — `formatUpstreamLagSection` uses the local-only variant on every keepalive briefing tick. Must not gain network I/O.
- `src/orchestration/index.ts` — `orchDiff`'s private `resolveDiffBase` calls the local-only variant inside a worktree to pick a diff base.
- `src/orchestration/skills.ts` — `proposalFreshnessWarning` calls the local-only variant; reads only `origin`, silently no-ops if absent.
- `src/git-runner.test.ts` — 7 direct unit tests across both functions (3 local + 4 authoritative).
- `src/briefing-lag.test.ts` — 5 direct unit tests against local-only behaviour.

### Confirmed delta

The two functions' `read(remote)` closures share the local-symref tier and the main/master fallback verbatim. The authoritative variant inserts one extra middle step: `runGit(["ls-remote", "--symref", remote, "HEAD"], cwd)`, parsed with `/^ref:\s+refs\/heads\/(.+?)\s+HEAD\b/m`. No other behavioural divergence — same return shape, same null semantics, same iteration order, same prefix-strip on the symref line.

### Why the option is named `authoritativeIO`

User-resolved (2026-04-30) over Shape A (`authoritative: boolean`) and Shape B (two thin wrappers over a parametric core). Shape B's argument was that the separate `…Authoritative` symbol at the `staging-ff.ts` import site flagged the network round-trip lexically without forcing a JSDoc read. Shape A wins on fewer exported symbols and one canonical function — but only if the flag name carries the I/O signal. `authoritativeIO` does that work: the `IO` suffix makes the contract visible at call sites (`{ authoritativeIO: true }` reads as "this path performs network I/O") so Shape B's protective property is preserved without a wrapper sprawl.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Rewrite `detectDefaultBranches` in `src/git-runner.ts`** to a single function:
   ```ts
   /**
    * Detect the default branch name for each of origin and upstream.
    *
    * Tier order per remote:
    *   1. local `git symbolic-ref refs/remotes/<r>/HEAD` (set by clone or
    *      `git remote set-head <r> -a`)
    *   2. (only when `authoritativeIO: true`) `git ls-remote --symref <r> HEAD`
    *      — performs a network round-trip, intended for callers that have
    *      already warmed the connection (e.g. just ran `git fetch <r>`).
    *   3. `git rev-parse --verify --quiet refs/remotes/<r>/{main,master}`
    *
    * Returns null for a remote when no tier matches.
    *
    * @param opts.authoritativeIO - When true, performs up to N network
    *   round-trips (one `ls-remote --symref` per remote queried — i.e. 2 for
    *   origin+upstream when both remotes exist). Default false: zero network
    *   I/O. The `IO` suffix in the name is deliberate — it surfaces the
    *   network contract at call sites without requiring a JSDoc lookup.
    */
   export function detectDefaultBranches(
     cwd: string,
     runGit: RunGit,
     opts?: { authoritativeIO?: boolean },
   ): DetectedBranches {
     const authoritativeIO = opts?.authoritativeIO ?? false;
     const read = (remote: string): string | null => {
       const primary = runGit(["symbolic-ref", `refs/remotes/${remote}/HEAD`], cwd);
       if (primary.exitCode === 0) {
         const line = primary.stdout.trim();
         const prefix = `refs/remotes/${remote}/`;
         if (line.startsWith(prefix)) {
           const name = line.slice(prefix.length);
           if (name) return name;
         }
       }
       if (authoritativeIO) {
         const symref = runGit(["ls-remote", "--symref", remote, "HEAD"], cwd);
         if (symref.exitCode === 0) {
           const m = symref.stdout.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD\b/m);
           if (m && m[1]) return m[1];
         }
       }
       for (const candidate of ["main", "master"]) {
         const verify = runGit(
           ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`],
           cwd,
         );
         if (verify.exitCode === 0 && verify.stdout.trim() !== "") return candidate;
       }
       return null;
     };
     return { origin: read("origin"), upstream: read("upstream") };
   }
   ```
   Critical detail: the `ls-remote` call must sit inside the `if (authoritativeIO)` block, not be invoked-then-ignored. Default callers (briefing-lag every keepalive tick) make zero network calls.

2. **Delete `detectDefaultBranchesAuthoritative`** from `src/git-runner.ts` entirely — its old JSDoc block and function body. The merged JSDoc on the unified function covers both modes.

3. **Update `src/staging-ff.ts`**:
   - Drop `detectDefaultBranchesAuthoritative` from the import list at line ~13; ensure `detectDefaultBranches` is imported instead (may already be — just consolidate).
   - Change line ~116 from `detectDefaultBranchesAuthoritative(path, opts.runGit)` to `detectDefaultBranches(path, opts.runGit, { authoritativeIO: true })`.

4. **Update `src/git-runner.test.ts`**:
   - Drop `detectDefaultBranchesAuthoritative` from the import list (line ~5).
   - Rewrite the four authoritative-tier tests (lines ~86, ~105, ~122, ~134) to call `detectDefaultBranches("/x", rg, { authoritativeIO: true })`. Rename their describe-strings to match (e.g. `"detectDefaultBranches authoritativeIO: prefers local symbolic-ref when present"`). Behaviour assertions stay identical.
   - Leave the three local-only tests at lines ~60, ~70, ~79 untouched — they continue to call the two-arg form and exercise the default-`false` path.

5. **No changes** to `src/briefing-lag.ts`, `src/orchestration/index.ts`, `src/orchestration/skills.ts`, `src/briefing-lag.test.ts` — their existing two-arg calls remain valid because `opts` is optional with a `false` default.

6. **Verify**: `bun run typecheck && bun run lint && bun run build && bun test`. Spot-check that `grep -r detectDefaultBranchesAuthoritative src/ docs/ dashboard/` returns no hits.

## Scope

**In scope**

- The single-file refactor in `src/git-runner.ts` plus the four mechanical updates to `src/staging-ff.ts` and `src/git-runner.test.ts`.
- JSDoc rewrite on the unified function explicitly framing `authoritativeIO: true` as performing N network round-trips.

**Out of scope**

- Changes to `resolveBaseRef` or its proposed introduction (tracked under `task-b6bca25c`). That helper sits a layer above and consumes the `{ origin, upstream }` output — the unification is mechanical and doesn't change its contract.
- Any change to the `DetectedBranches` type's shape, the iteration order over `["main", "master"]`, the symref-prefix-strip rule, or the null semantics. The refactor is behaviour-preserving by construction.
- Renaming or relocating the function. The export name `detectDefaultBranches` is preserved; the file stays `src/git-runner.ts`.

**Dependencies**

- Independent of `task-b6bca25c`. Either can land first; if `task-b6bca25c`'s worker lands first and folds the two functions per its Question 3 clause, this task becomes a no-op and would be merged. If this task lands first, that worker will see one function and skip its folding clause.
- Sibling polish proposals queued today: `task-3a29f3fb` (completed), `task-bf451303`, `task-41b91ca3`, `task-6a80b0ff` (completed), `task-d024e32c`, `gh-ludics-441`, `task-fa409f49`. None touch `git-runner.ts` API surface, so no merge-order coupling is expected — but a coder noticing conflicts in `staging-ff.ts` or `git-runner.test.ts` from a sibling polish landing first should rebase rather than coordinate manually.
