# pair-coder pr-create: assert PR base-repo matches the project's working repo

## Goal

Close the only remaining exposure window in which an orchestrated coder can
open a PR against the wrong base repository.

Incident (2026-05-14, GH issue
[lukstafi/ludics#529](https://github.com/lukstafi/ludics/issues/529)): slot 4's
coder for `gh-ocannl-320` ran `gh pr create` **without `--repo`**. Because
`lukstafi/ocannl-staging` is a GitHub fork of `ahrefs/ocannl`, `gh pr create`
with no `--repo` defaults the base repo to the **fork parent**, opening a
cross-repo PR (`ahrefs/ocannl#457`) against upstream instead of the staging
repo. Mag caught it manually at `pr-comments`; had it slipped past
`final-merge`, the harness would have merged straight into `ahrefs/ocannl:master`.

The `pair-coder-pr-create.md` template is already correct (it emits
`--repo "{{PROJECT_REPO}}"`); the failure was coder *deviation* from the
template. `final-merge.md` and the runner-side `validateAndFixPrFile`
auto-create path both already pass `--repo` explicitly and are safe. The only
unguarded path is the coder's *manual* `gh pr create`, whose output URL is
written to `.peer-sync/<agent>.pr` and trusted by the rest of the flow.

The fix must be entirely harness-side: per the user's firm decision,
`lukstafi/ocannl-staging` stays a GitHub fork for provenance clarity —
detaching the fork is not an acceptable fix.

## Acceptance Criteria

1. A shared, slug-normalized helper exists (exported from
   `src/orchestration/github.ts`, e.g. `prUrlBelongsToRepo(prUrl, repo)`) that
   returns whether a PR URL's `owner/repo` slug matches an expected repo slug.
   Comparison is case-insensitive, trims whitespace, and ignores a trailing
   `.git`. It reuses the existing `parsePrUrl` parser.
2. `validateAgentPrFiles` (in `src/orchestration/runner.ts`) checks the
   resolved PR URL — whether the `.pr` file already held a URL or
   `validateAndFixPrFile` just created one — against the project's configured
   `repo`. A mismatch is surfaced (event emitted) the moment it is detected, and
   the mismatched URL is not silently promoted to `runtime.prUrl` as a valid
   result.
3. The `pr-create` verification gate (`PR_CREATE_GATE` via `verifyPhaseOutcome`)
   fails when the verified PR URL's slug does not match the project's `repo`.
   The failure routes through the existing `handleVerifyFailure` path:
   `prCreateVerifyAttempts` increments, `phaseRetryContext` is set,
   `preparePhaseRedispatch` runs, decision is `"redispatch"`; after
   `MAX_VERIFY_ATTEMPTS` it escalates via the existing
   `manual_intervention_required` + `surfaceManualIntervention` path. No new
   state fields are added.
4. The `phaseRetryContext` / failure message for a wrong-base-repo failure
   names both the wrong repo the PR pointed at and the expected `repo`, and
   instructs the coder to: recreate the PR against the working repo with
   `gh pr create --repo <repo>`, and overwrite `.peer-sync/<agent>.pr` with the
   corrected URL. When the wrong repo matches the project's `upstream_repo`,
   the message says so explicitly (fork-parent default of an omitted `--repo`).
5. The assertion no-ops (skips, does not fail) when the project config has no
   `repo` slug to compare against — repo-less / ad-hoc projects must not break.
6. The assertion is mode-agnostic (fires for solo, duo, and pair) and scoped to
   the non-upstream `pr-create` path — it does not false-trip on intentional
   upstream-forward PR flows (`upstream-*` templates / `*.upstream-pr`
   artifacts).
7. Unit tests cover: the shared helper (match, slug-normalized match,
   mismatch, malformed URL); `verifyPhaseOutcome` returning `"redispatch"` on a
   wrong-repo PR URL and `"advance"` when the slug matches; and the no-config
   skip path. Tests live alongside the existing
   `runner.verification.test.ts` blocks (`verifyPhaseOutcome (PR_CREATE_GATE)`,
   `validateAgentPrFiles (eager repair)`, `validateAndFixPrFile --repo argument`).

## Context

How things work now:

- **`src/orchestration/github.ts`**
  - `parsePrUrl(prUrl)` — private helper; regex-extracts `{ repo, prNumber }`
    (`repo` is the `owner/repo` slug) from a PR URL. Returns `null` on
    malformed input. The new shared helper builds on this; `parsePrUrl` itself
    need not be exported if the new helper is co-located.
  - `isPrUrl(value)` — shape check for a PR URL.
  - `validateAndFixPrFile(prFile, worktreePath, branch, repo?)` — if the `.pr`
    file holds markdown instead of a URL, auto-creates the PR with `gh pr
    create` (passing `--repo repo` when set) and rewrites the file. **Crucially:
    `if (isPrUrl(content)) return content;` short-circuits before any repo
    check** — a `.pr` file that already contains a (possibly wrong-repo) URL is
    returned untouched.
  - `getPrVerification(prUrl)` — GitHub-API existence/merge check used by the
    gates.
- **`src/orchestration/runner.ts`**
  - `validateAgentPrFiles(state)` — runs in `pr-create`; reads `projectRepo =
    findProjectConfig(state.projectDir)?.repo`, calls `validateAndFixPrFile` for
    each participating agent (both the eager-repair branch when the `.pr` file
    is known-bad and the settled-mode branch), and on success sets
    `runtime.prUrl`. It already has `projectRepo` and the resolved URL in hand —
    natural site for the early catch.
  - `PR_CREATE_GATE` (`VerificationGateConfig`) — `checkSuccess: (v) => v.exists`
    currently asserts only that the PR *exists*, not that it belongs to the
    working repo. `verifyPhaseOutcome(state, PR_CREATE_GATE)` resolves the URL
    via `getFirstPrUrl(state)`, runs `getPrVerification`, and on
    `checkSuccess` failure calls `handleVerifyFailure`.
  - `verifyPhaseOutcome` — has `prUrl` and `v` in hand; a wrong-repo check can
    live in `PR_CREATE_GATE.checkSuccess` (needs the URL, which `checkSuccess`'s
    `(v)` signature doesn't currently receive) or inline in `verifyPhaseOutcome`
    after the `checkSuccess` block. `formatFailure` is the message-shaping hook.
  - `handleVerifyFailure(state, "prCreate", reason)` — already wired:
    increments `prCreateVerifyAttempts`, sets `state.phaseRetryContext = reason`,
    calls `preparePhaseRedispatch`, returns `"redispatch"`; after
    `MAX_VERIFY_ATTEMPTS` emits `manual_intervention_required`, notifies, and
    calls `surfaceManualIntervention` (sets `has_questions`). The wrong-base-repo
    failure reuses this path verbatim.
  - `getFirstPrUrl(state)` — reads the coder's PR URL from `agentStates[*].prUrl`
    with a `.pr`-file fallback.
- **`src/config.ts`** — `ProjectConfig` has `repo` (working/staging fork, used
  for PR creation) and `upstream_repo?` (fork parent, issue sync only). For
  OCANNL: `repo: lukstafi/ocannl-staging`, `upstream_repo: ahrefs/ocannl`.
  `findProjectConfig(projectDir)?.repo` can be `undefined` for ad-hoc/local
  projects — hence AC5.
- **`pair-coder-pr-create.md`** (templates dir) — the `gh pr create` template
  the coder deviated from. Strengthening its wording is **explicitly out of
  scope** (issue suggestion #3, user: "definitely not doing it").
- **Tests** — `src/orchestration/runner.verification.test.ts` has the
  `verifyPhaseOutcome (PR_CREATE_GATE)`, `validateAgentPrFiles (eager repair)`,
  and `validateAndFixPrFile --repo argument` describe blocks; new coverage
  slots in alongside them. `github.ts`-level tests for the helper go in the
  existing github test file if one exists, else colocated with the gate tests.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The user resolved the design in the task Notes, so the shape is fixed:

1. **Shared helper** in `github.ts`:
   `export function prUrlBelongsToRepo(prUrl: string, repo: string): boolean` —
   parse via `parsePrUrl`, slug-normalize both sides (lowercase, trim, strip a
   trailing `.git`), compare. Returns `false` on malformed URL.
2. **Early catch in `validateAgentPrFiles`**: after each agent's URL is
   resolved (both the eager-repair and settled-mode branches), if `projectRepo`
   is set and `prUrlBelongsToRepo(url, projectRepo)` is false, emit a
   wrong-repo event and do **not** set it as a clean `runtime.prUrl` success
   (leave it for the gate to fail on, or surface it as already-bad). When
   `projectRepo` is unset, skip (AC5).
3. **Catch-all in the gate**: in `verifyPhaseOutcome`, after the existing
   `config.checkSuccess(v)` success branch, add a base-repo assertion for the
   `prCreate` gate: if `projectRepo` is set and the verified `prUrl` does not
   belong to it, build a wrong-repo `reason` (naming the wrong slug, the
   expected `repo`, and — when the wrong slug equals `upstream_repo` — the
   fork-parent explanation plus the recreate-and-overwrite-`.pr` instruction)
   and return `handleVerifyFailure(state, "prCreate", reason)`. Keep the check
   gated on `config.gate === "prCreate"` so `FINAL_MERGE_GATE` is unaffected.
   Resolve `projectRepo` inside `verifyPhaseOutcome` the same way
   `validateAgentPrFiles` does (`findProjectConfig(state.projectDir)?.repo`).
4. Upstream-forward flows write `*.upstream-pr` artifacts on a distinct phase
   path, not the `pr-create` coder `.pr`; scoping the assertion to the
   `pr-create` phase + `prCreate` gate keeps it clear of those (AC6) — confirm
   no `pr-create`-phase template legitimately targets a non-`repo` base.

No new state fields: the redispatch budget, escalation, and `has_questions`
surfacing all reuse `handleVerifyFailure`.

## Scope

In scope:
- Shared `prUrlBelongsToRepo` helper in `github.ts`.
- Base-repo assertion at both insertion points (`validateAgentPrFiles` and the
  `pr-create` verification gate), per the user's "both" decision.
- Wrong-repo-aware retry/failure messaging.
- Unit tests for the helper and both insertion points.

Out of scope (per user decision, do **not** do, do **not** file follow-ups
unless asked):
- Issue suggestion #3 — strengthening `pair-coder-pr-create.md` template
  wording.
- Issue suggestion #2 — inverting `clearGhResolvedMarkers` to pin
  `gh-resolved=base` for fork-layout repos. `clearGhResolvedMarkers` stays
  as-is.

Dependencies: none.
