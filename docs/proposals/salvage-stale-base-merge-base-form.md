# Salvage stale-base check: use git merge-base, not BASE-vs-HEAD existence

## Goal

The salvage-flow stale-base verification documented in three coordinated places (`skills/orchestration/pair-coder-work.md`, `skills/orchestration/pair-reviewer-review.md`, `docs/orchestration-patterns.md`) currently uses a `git cat-file -e "$BASE:<path>" && git cat-file -e HEAD:<path>` conjunction. `$BASE` resolves to a *branch tip* (`origin/main`), so this form catches the "shared history at fork point" case but misses fork-point-vs-tip drift — files added to `main` *after* the branch's fork point that the reviewer then reads as branch-side deletions.

PR #470 round 2 surfaced this concretely: two proposal files (`docs/proposals/ci-add-lint-test-isolation-step.md`, `docs/proposals/lint-cli-readme-fail-on-undocumented.md`) were added to main *after* fork point `c54b37b`. They were never on the branch. The current check produced a false-negative ("not shared history → proceed with revert"), and the salvage flow tried to "revert phantom scope expansions" that were really main-side drift.

The retrospective (task-defe2e27 coder durable learning #1) sketched a fix using `git merge-base`, but its sketch was **one-armed**: it covered only the new "added to main after fork" case. The original gh-ludics-409 case — "file present on both sides today because it was already at the fork point" — must remain detected. A correct fix is **two-armed**: case (a) merge-base-shared-history (preserved); case (b) fork-point-vs-tip drift (new). Both must short-circuit the salvage/revert flow with the same per-commit-diff push-back.

Related: gh-ludics-409 (introduced the original check), gh-ludics-374 (per-commit-diff guidance, unaffected here), task-defe2e27 (PR #470, retrospective source).

## Acceptance Criteria

Each criterion below is a separate falsifier; reviewer should treat them as a checklist (one assertion per AC, per the AC-rigor reference's *enumerated-element* clause).

1. **Three call-site updates, no fourth.** All three lockstep documentation sites encode the new merge-base verification form, and no other skill or doc file gains a similar block:
   - `skills/orchestration/pair-coder-work.md` — step `0.` of the `**Salvage on rejection**` block.
   - `skills/orchestration/pair-reviewer-review.md` — paragraph beginning `Before flagging apparent deletions as scope violations`.
   - `docs/orchestration-patterns.md` — the `**Procedure (diff commands).**` paragraph inside `### Scope declaration and salvage`.

   Falsifier: a `git grep` for the new `MERGE_BASE` literal across `skills/` and `docs/` returns exactly three files (the three above).

2. **Both arms present at every site.** Each of the three sites describes both case (a) — file present at the merge-base (shared history with the fork point) — and case (b) — file absent at merge-base, present on `origin/$BASE`, absent on `HEAD` (fork-point-vs-tip drift). At each site, both arms short-circuit the salvage/revert with the per-commit-diff push-back.

   Falsifier: a site that omits either arm (e.g., one-armed merge-base check that only catches case b) fails this AC.

3. **`$BASE` substitution preserved.** The merge-base resolution uses `git merge-base "origin/$BASE" HEAD` (or equivalent that derives the base branch from `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`), not hard-coded `origin/main`. This carries forward the gh-ludics-409 P2 review requirement that `master`/`trunk`/custom defaults work.

   Falsifier: any of the three sites contains the literal `origin/main` in the merge-base or cat-file commands.

4. **Old conjunction form removed.** None of the three sites contains the legacy form `git cat-file -e "$BASE:<path>" && git cat-file -e HEAD:<path>` (the conjunction; individual `cat-file` invocations may still appear in the new arms). The replacement is the merge-base form, not an addition that leaves the old check in place.

   Falsifier: `git grep -F 'cat-file -e "$BASE:<path>"'` followed in the same paragraph/step by `cat-file -e HEAD:<path>` — i.e., the old conjunction — returns any hits in the three target files.

5. **Tests refreshed in lockstep.** The three structural-assertion tests in `src/orchestration/skills.test.ts` that pin the existing form are updated to assert the new merge-base shape and to falsify reappearance of the legacy conjunction:
   - `gh-ludics-409: pair-coder-work salvage block prepends cat-file verification` (~line 1915).
   - `gh-ludics-409: pair-reviewer-review per-commit-diff paragraph adds cat-file post-hoc check` (~line 1941).
   - `gh-ludics-409: orchestration-patterns Procedure block names runner coverage and cat-file verification` (~line 1961).

   Each updated test asserts:
   - Positive: the merge-base form (e.g., `git merge-base`, `\$MERGE_BASE:<path>` or equivalent literal).
   - Both arms named (text mentioning the merge-base case AND the fork-point-vs-tip / origin-vs-HEAD case).
   - Falsifier: no hard-coded `main:<path>`, no plain `\$BASE:<path>` in the verification position, no surviving `cat-file -e "\$BASE:<path>" && cat-file -e HEAD:<path>` conjunction.

   Tests are renamed only if the existing name becomes misleading; otherwise the original test names are preserved (they still pin the gh-ludics-409 invariant, refined).

   Falsifier: running `bun test src/orchestration/skills.test.ts` against the *old* template form fails (i.e., reverting the docs without reverting the tests breaks the suite). Conversely the suite passes against the new template form.

6. **No runtime code changes.** `src/orchestration/runner.ts` (`warnStaleBase` and friends) is not modified. The fix is docs/skills + structural tests only.

   Falsifier: the PR diff touches any `.ts` file other than `src/orchestration/skills.test.ts`.

7. **Verification choice: text-pinning.** The verification surface is the existing `skills.test.ts` structural-assertion harness (string matching against rendered template text). A behavioral 3-commit fixture (constructing an actual git history and running `cat-file` against it) is *not* added — text-pinning is sufficient because the salvage flow is human-followed in the skill template; tests assert the template literals, not runtime git semantics. The retrospective floated a behavioral fixture; this proposal explicitly chooses text-pinning to stay aligned with gh-ludics-409 style and effort budget.

   Falsifier: a new behavioral test that constructs a temp git repo and invokes `git cat-file` against it appears in this PR.

## Context

### Where the canonical pattern lives

Three coordinated documentation sites encode the salvage-flow stale-base check. All three were last touched together by gh-ludics-409 and must move in lockstep:

- `skills/orchestration/pair-coder-work.md` — `**Salvage on rejection**` block, step `0.`. The verification step that gates the irreversible patch capture and revert in steps 1+. Anchor sentence: `Verify the rejection isn't a stale-base false positive`.

- `skills/orchestration/pair-reviewer-review.md` — single paragraph in the scope-violation section. Anchor sentence: `Before flagging apparent deletions as scope violations, cross-check with`.

- `docs/orchestration-patterns.md` — `**Procedure (diff commands).**` paragraph inside the `### Scope declaration and salvage` section. The cat-file sentence begins `When an individual file claim is in dispute`.

The `pair-reviewer-plan-review.md` per-commit-diff guidance does *not* encode the cat-file verification and is not in scope.

### Pinning tests

`src/orchestration/skills.test.ts` contains three `gh-ludics-409: ...` structural-assertion tests (around lines 1915, 1941, 1961) that read each of the three sites and assert the verification literals. Each test asserts both positive shape (`git cat-file -e "\$BASE:<path>"`, `symbolic-ref refs/remotes/origin/HEAD`) and falsifiers (`git cat-file -e main:<path>` must not appear). These tests will fail against the new template if not also updated; they must move with the docs in the same PR.

### Why the existing form misses fork-point-vs-tip drift

The check resolves `$BASE` from `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` — yielding a branch *name* like `main`. `git cat-file -e "$BASE:<path>"` then reads the file at `origin/main`'s **current tip**, not at the branch's fork point. When `main` has gained a file `X` *after* the fork:

- `cat-file -e "$BASE:X"` succeeds (X exists at origin/main tip).
- `cat-file -e HEAD:X` fails (X never existed on the branch).
- Conjunction short-circuits to false → check declines to fire → salvage flow proceeds → coder reverts a phantom "scope expansion" that was always main-side drift.

The merge-base form uses `git merge-base "origin/$BASE" HEAD` to find the actual fork point, then queries `cat-file -e "$MERGE_BASE:<path>"` against that commit. This separates "file existed at fork" (case a, shared history) from "file added to main after fork" (case b, drift).

### Consistency with `runner.ts`

`src/orchestration/runner.ts` `warnStaleBase` (around line 189–230) already uses `git merge-base HEAD origin/<base>` for distance counting. The new docs form is consistent with the runner's own idiom — no new git command is being introduced to the harness.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

At each of the three sites, replace the conjunction with a two-armed merge-base form. A reference shape (the exact prose adapts per site's voice and existing surrounding text):

```sh
BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)
MERGE_BASE=$(git merge-base "origin/$BASE" HEAD 2>/dev/null)
# Two stale-base shapes the salvage flow must skip (push back, do not revert):
#   (a) Shared history at fork: file existed at MERGE_BASE.
#   (b) Fork-point-vs-tip drift: file absent at MERGE_BASE, present on origin/$BASE,
#       absent on HEAD — main added it after fork; never on the branch.
if [ -n "$MERGE_BASE" ] && git cat-file -e "$MERGE_BASE:<path>" 2>/dev/null; then
  : # case (a): shared history — push back with per-commit diff.
elif git cat-file -e "origin/$BASE:<path>" 2>/dev/null && ! git cat-file -e "HEAD:<path>" 2>/dev/null; then
  : # case (b): main-side drift — push back with per-commit diff.
fi
```

Edge-case handling:

- **Empty `$MERGE_BASE`** (orphan branch / unfetched remote / detached HEAD with no `origin/$BASE`): `merge-base` exits nonzero with empty stdout. Guard the case-(a) arm with `[ -n "$MERGE_BASE" ]` (or equivalent). Do not error; just fall through to ordinary salvage. This matches gh-ludics-409's `2>/dev/null` style.
- **`$BASE` substitution**: keep the existing `git symbolic-ref ... | sed 's@^origin/@@' || echo main` resolution. Do not hard-code `origin/main`.

For the tests, mirror the original gh-ludics-409 falsifier style: positive assertions on the new literals (`git merge-base`, both arms named) and negative assertions that the old conjunction and any hard-coded `main:<path>` are gone.

The fork-point-vs-tip arm is what the retrospective's sketch covered; the merge-base-shared-history arm is what gh-ludics-409 covered. Keeping both is the load-bearing distinction.

## Scope

### In scope

- Edits to three documentation/skill files: `skills/orchestration/pair-coder-work.md`, `skills/orchestration/pair-reviewer-review.md`, `docs/orchestration-patterns.md`.
- Updates to three structural-assertion tests in `src/orchestration/skills.test.ts`.
- Build artifacts that flow from the skill changes (`bun run build` regenerates).

### Out of scope

- **Runtime code changes.** `runner.ts` `warnStaleBase` and other TypeScript stays untouched.
- **Behavioral 3-commit fixtures.** Verification stays text-pinning per AC 7.
- **Rename-across-fork handling.** Files renamed on main after fork are an open boundary — the merge-base form classifies the new path correctly but says nothing about the old path. Same boundary as gh-ludics-409. Not widening here.
- **Other reviewer/coder skill edits unrelated to the stale-base verification.** `pair-reviewer-plan-review.md` per-commit-diff guidance is unaffected.
- **General salvage-flow restructuring.** This is a targeted fix to the verification step; the surrounding salvage workflow (steps 1+ of `**Salvage on rejection**`) does not change.

### Dependencies

- No blocking task dependencies. Relates to gh-ludics-409 (original check) and gh-ludics-374 (per-commit-diff guidance, preserved). Source learning: task-defe2e27 retrospective (PR #470).
