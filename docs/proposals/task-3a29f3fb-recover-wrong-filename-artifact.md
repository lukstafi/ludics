# Defense-in-depth: detect plan-merge artifact written to suspect alternative files

## Goal

When a coder/reviewer agent self-reports phase completion (`<phase>-done`)
but the canonical phase artifact is missing — typically because the agent
wrote into a wrong filename — the orchestrator should recover automatically
when the wrong file is one of a small set of well-known mistakes, and
otherwise emit a sharp targeted nudge that names the canonical path and
lists the recently-modified candidate files.

Today the only signal is a `required artifact missing: <path>` warning that
repeats every 10s until the phase timeout fires and force-promotes. This
was observed twice on 2026-04-29 (slot 2 / task-7ae99643): the coder wrote
the merged plan into `.peer-sync/plans/round-1-coder.md` (clobbering the
original pre-merge plan) instead of `.peer-sync/plans/round-1-merged-0.md`,
and on the next plan-merge round again skipped `merged-0` and wrote
`merged-1.md`. Both required manual `cp` to unstick. We want the smell to
be visible on the first poll cycle and self-healing for the narrow set of
filename mistakes we can recognize safely.

## Acceptance Criteria

- When the artifact gate in `validateDoneStatus` fires `required artifact
  missing` for a `plan-merge`, `plan`, `plan-review`, or `review` phase,
  the orchestrator runs a two-branch recovery (auto-cp, then targeted
  nudge) **before** emitting the existing 10s warning. Exactly one of the
  three outcomes obtains per gate tick: auto-cp + diagnostic, nudge +
  diagnostic, or the existing warning unchanged.

- **Auto-cp branch (whitelist-driven):** If a file matching the phase's
  conservative whitelist (defined below) exists with `mtime >=
  state.phaseStartedAt`, the orchestrator copies it to the canonical
  path with `cp -p` semantics — `copyFileSync(src, dest)` followed by
  `utimesSync(dest, atime, mtime)` to preserve the source mtime. If
  multiple whitelisted suspects qualify, the most-recently-modified wins.
  No content inspection is performed; the whitelist itself is the safety.
  A diagnostic event records suspect path, canonical path, phase, round,
  and `planMergeRound`.

- **Nudge branch:** If no whitelisted suspect was auto-cp'd and the
  canonical is still missing, the orchestrator scans both
  `<peerSyncDir>/plans/*.md` and `<peerSyncDir>/reviews/*.md` for any
  files with `mtime >= state.phaseStartedAt` (canonical excluded). If at
  least one such file exists, it sends a targeted nudge via
  `transport.sendTurn(state, agent, message)` whose body names the
  canonical path and lists up to 5 of the most-recently-modified
  candidates as "did you mean to write here?" suggestions.

- **No suspects anywhere:** If neither a whitelisted suspect nor any
  recently-modified file exists in `plans/` ∪ `reviews/`, behavior is
  unchanged from today — the existing 10s warning continues to fire and
  the timeout-based force-promote remains the fallback.

- **Auto-cp whitelist (conservative, grows by code edit):**
  with `R = state.round`, `K = state.planMergeRound ?? 0`:
  - Phase `plan-merge` (canonical: `plans/round-R-merged-K.md`):
    - any `plans/round-R-<agent>.md` (parses as `{type: "plan", round: R}`
      via `parsePlanFilename`),
    - any `plans/round-R-merged-<j>.md` with `j !== K`,
    - explicit string list: `plans/round-R-merge.md`,
      `plans/round-R-merged.md` (singular-name fallthrough — neither
      parses).
  - Phases `plan`, `plan-review`, `review`: empty for v1. Cross-agent /
    cross-directory cases are too risky to auto-cp without content
    inspection and are handled by the nudge branch.

- **Config flag:** `OrchestrationConfig.autoRecoverWrongFilename`
  (boolean, default `true`) gates the auto-cp branch only. When `false`,
  whitelisted suspects fall through to the nudge branch. The flag is
  added to `defaultOrchestrationConfig()` alongside `autoFinish`-style
  flags. It is exposed through the same channel the rest of
  `OrchestrationConfig` flows through (adapter `--auto-recover-wrong-filename`
  / `--no-auto-recover-wrong-filename` CLI args in
  `src/adapters/t3code.ts` and `src/adapters/tmux-adapter.ts`, mirroring
  `--auto-finish` / `--clarify`); no `harness/config.yaml` schema change
  is required because orchestration flags are passed via adapter args
  today.

- **TUI gating:** Nudge dispatch is gated on the agent's
  `runtime.turnLifecycle.state === "settled"`. If the lifecycle is
  `dispatched`, `starting`, or `running`, recovery is deferred to the
  next gate tick rather than firing into a busy session. (Agents in
  `error` state still receive the diagnostic but no nudge.) Auto-cp is
  not gated on TUI state — it's a pure filesystem operation.

- **Nudge dedup (own bucket, separate from `HUNG_NUDGE_COOLDOWN_S`):**
  Keyed by `(slot, phase, agent, round)` — for `plan-merge` /
  `plan-review` the key includes `planMergeRound` as well, since both
  phases iterate within a single `round`. State is stored on
  `AgentTurnLifecycle` (e.g. `wrongFilenameNudgeRound: number` and
  `wrongFilenameNudgeMergeRound?: number`) so it survives orchestrator
  restarts and the existing turnLifecycle-clear semantics on resume. A
  wrong-filename nudge and a hung-agent nudge can fire concurrently in
  the same poll cycle.

- **Nudge attempt accounting:** Each fired nudge increments
  `lc.nudgeAttempts` so the existing `MAX_NUDGE_ATTEMPTS` (force-settle)
  ceiling continues to bound retries. Auto-cp does NOT increment
  `nudgeAttempts` — it's a non-disruptive recovery and shouldn't burn
  the agent's nudge budget.

- **Cross-round re-fire:** When the agent makes the same wrong-filename
  mistake on a subsequent round (R+1) or planMergeRound (K+1), the
  recovery fires again — the dedup key changes with the round/mergeRound
  tuple, so the round-R sentinel does not block round-(R+1).

- **`merge-amend` is out of scope.** Its `requiredArtifactPath` is
  `null` (produces a commit, not a file). Recovery for merge-amend
  would require defining a stand-in artifact first and is filed
  separately if needed.

- **Diagnostic event vocabulary:** Both branches emit a structured
  event distinct from the existing `orchestration_warning`. Auto-cp
  emits e.g. `orchestration_artifact_recovered` with fields `{slot,
  task, agent, phase, round, planMergeRound?, suspectPath,
  canonicalPath}`; nudge emits e.g.
  `orchestration_wrong_filename_nudge` with `{...,
  candidatePaths: string[]}`. Existing `orchestration_warning` is still
  emitted in the no-suspects fallback case so dashboards and Mag's flow
  view continue to see the smell.

- **Unit tests cover:**
  - (a) canonical present → no diagnostic, no auto-cp, no nudge.
  - (b) canonical missing + no in-phase modifications anywhere →
    existing warning only (no nudge, no cp).
  - (c) canonical missing + whitelisted-suspect in-phase → auto-cp
    + recovered-event, no nudge, `nudgeAttempts` unchanged.
  - (d) canonical missing + non-whitelisted in-phase modifications
    in `plans/` → nudge + nudge-event listing modified files, no cp,
    `nudgeAttempts` incremented.
  - (e) canonical missing + non-whitelisted in-phase modifications
    in `reviews/` (cross-directory, e.g. plan-merge phase) → nudge body
    lists the cross-dir file.
  - (f) canonical missing + whitelisted suspect with `mtime <
    state.phaseStartedAt` → no recovery, existing warning only.
  - (g) `autoRecoverWrongFilename: false` + whitelisted-suspect
    in-phase → nudge instead of cp.
  - (h) Wrong-filename clobber recurs in round R+1 → nudge fires again
    for round R+1 even though round R already nudged.
  - (i) Nudge deferred when `turnLifecycle.state === "running"` (not
    `settled`); diagnostic still emitted on the next tick once settled.
  - (j) Singular-name fallthrough: `plans/round-R-merged.md` and
    `plans/round-R-merge.md` are auto-cp'd despite not parsing through
    `parsePlanFilename`.
  - (k) `planMergeRound` skip-counter case: canonical
    `merged-K.md` missing, suspect `merged-(K+1).md` present in-phase
    → auto-cp.
  - (l) Tie-breaking when multiple whitelisted suspects qualify:
    most-recently-modified wins.

## Context

- **Orchestration phases gate:** `src/orchestration/phases.ts`
  - `requiredArtifactPath(state, agent)` resolves the canonical path
    per `state.phase`.
  - `hasRequiredArtifact(state, agent)` performs the `existsSync` check
    and the `pr-create` URL validation.
  - `validateDoneStatus(state, agent, runtime)` is the single hook
    point: when `hasRequiredArtifact` returns `false`, today it emits
    `orchestration_warning` and returns `false`. The new recovery logic
    wedges in *between* the `if (!hasRequiredArtifact(...))` test and
    the `emitEvent(...)` call so it preempts the warning when a
    suspect is found.
  - `isAgentDone(state, agent)` calls `validateDoneStatus` from two
    branches (legacy no-lifecycle and `lc.state === "settled"`); the
    recovery should run from the validator itself, not be duplicated
    at the call sites.
  - There is a related (but distinct) recovery in `phases.ts` already:
    `lc.nudgeAttempts >= 2` + canonical present → "treat as done"
    (~line 290). The new recovery sits *upstream* of that branch.

- **Filename builders & parsers:**
  `src/orchestration/plan-files.ts` exports `planFilename`,
  `mergedPlanFilename`, `planFilePath`, `mergedPlanFilePath`,
  `parsePlanFilename`. `src/orchestration/review-files.ts` exports
  `reviewFilename`, `reviewFilePath`, `parseReviewFilename`. The
  whitelist scanner reuses `parsePlanFilename` for the
  `{type:"plan",round:R}` and `{type:"merged",round:R,planMergeRound:!K}`
  matches; the singular-name fallthroughs are an explicit string list.

- **Nudge dispatch reference pattern:** `src/orchestration/runner.ts`,
  the hung-agent nudge dispatch (lines ~595–650) shows the canonical
  shape: `transport.sendTurn(state, agent, message)`,
  `lc.nudgeAttempts = attempts + 1`, `lc.lastNudgeAt = isoNow()`,
  emit `orchestration_nudge_sent`, swallow errors and emit
  `orchestration_nudge_failed`. The wrong-filename nudge mirrors this
  shape but with its own event types and dedup state.

- **Lifecycle state:** `src/orchestration/state.ts`
  - `AgentTurnLifecycle` (~line 35) — add
    `wrongFilenameNudgeRound?: number` and
    `wrongFilenameNudgeMergeRound?: number` for per-tuple dedup that
    persists across orchestrator restarts.
  - `OrchestrationConfig` (~line 104) — add
    `autoRecoverWrongFilename: boolean`.
  - `defaultOrchestrationConfig` (~line 234) — default to `true`.

- **Adapter wiring:** `src/adapters/t3code.ts` (`--clarify`,
  `--auto-finish` etc. ~line 328) and the equivalent block in
  `src/adapters/tmux-adapter.ts` — add
  `--auto-recover-wrong-filename` / `--no-auto-recover-wrong-filename`
  to flip the flag.

- **`phaseStartedAt` semantics:** numeric epoch (seconds) tracked in
  `orchestration/slot-N.json`. `mtime` from `statSync` is a `Date` —
  convert via `Math.floor(stat.mtimeMs / 1000)` for the comparison.

- **Out-of-scope reminders (from elaboration):**
  - `merge-amend` (no canonical artifact today).
  - Header-content inspection (a fixed-whitelist-of-safe-filenames
    approach was chosen instead — no skill-template edits required).
  - Extending recovery to `work` / `pr-create` / `merge-execute` —
    those use git artifacts, not standalone files.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Extend `OrchestrationConfig` and `AgentTurnLifecycle` with the new
   fields described above. Default the config flag in
   `defaultOrchestrationConfig`. Plumb the flag through both adapters'
   CLI arg parsers.

2. Add a new module `src/orchestration/wrong-filename-recovery.ts`
   exporting:
   - `whitelistSuspects(state): string[]` — phase-keyed whitelist
     enumerator that uses `parsePlanFilename` + the singular-name
     string list.
   - `scanRecentlyModified(peerSyncDir, phaseStartedAt, exclude):
     {plans: string[], reviews: string[]}` — directory scan returning
     mtime-sorted candidates from both subdirs.
   - `recoverWrongFilename(state, agent, runtime, transport):
     "cp"|"nudge"|"none"` — the orchestrator hook called from
     `validateDoneStatus` before emitting the existing warning. Returns
     `"cp"` when auto-cp succeeded (so the canonical now exists and the
     caller can re-test `hasRequiredArtifact`), `"nudge"` when nudge
     was sent, `"none"` otherwise (caller emits original warning).

3. In `phases.ts`, rewrite the `if (!hasRequiredArtifact(...))` branch
   in `validateDoneStatus` to call the recovery hook first. On `"cp"`,
   re-test `hasRequiredArtifact` and return its result (the agent
   becomes done if the cp succeeded). On `"nudge"` or `"none"`, return
   `false` as today; on `"none"` continue to emit
   `orchestration_warning` so the no-suspects path is unchanged.

4. Tests: extend `phases.test.ts` with the (a)–(l) cases, using
   tmpdir-based peer-sync fixtures and a mock `transport.sendTurn`
   that records calls. Reuse `runner.test-helpers.ts` patterns for
   building synthetic `OrchestrationState`.

## Scope

**In scope:**
- New recovery hook in `phases.ts` for `plan-merge`, `plan`,
  `plan-review`, `review` phases.
- Whitelist enumerator + recently-modified scanner.
- Targeted nudge via existing `transport.sendTurn` path.
- New diagnostic event types.
- Config flag plumbed through both adapters.
- Lifecycle-state extensions for dedup.
- Unit-test coverage of the recovery branches.

**Out of scope:**
- `merge-amend`, `work`, `pr-create`, `merge-execute`,
  `merge-review` recovery.
- Cross-directory auto-cp (nudge only).
- Header-content matching / skill-template edits.
- Dashboard surface — the new event types should appear automatically
  via the existing event log; bespoke dashboard work can be a
  follow-up task.

**Dependencies:**
- None blocking. Sibling polish tasks (task-bf451303 buildHandlers
  factory, task-41b91ca3 dedup util shadows, task-d024e32c lint
  vendor-sync) are independent.
