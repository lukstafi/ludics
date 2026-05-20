# t3code integration: gate broken surfaces behind a feature flag

## Goal

The t3code-ludics integration is paused: the test suite times out at the
300s health-check ceiling, the discovery scanner emits `server not
available` on every keepalive tick, and `t3code-server-down` /
`test-health:t3code-ludics` linger as ongoing health-check findings. The
user decided to pause the integration rather than fix it — see
[lukstafi/ludics#539](https://github.com/lukstafi/ludics/issues/539).

This proposal adds a single feature flag, `mag.t3code_integration_enabled`
(default `false`), that gates every surface from which the broken
integration leaks into briefings, sessions reports, and health checks.
Code paths stay in place; flipping the flag back to `true` is the sole
re-engagement step.

## Acceptance Criteria

1. **Config helper exists.** A new `t3codeIntegrationEnabled()` helper in
   `src/config.ts` reads `config.mag.t3code_integration_enabled` and
   returns `false` when the field is absent. Helper lives next to
   `preemptAutonomy()`/`startSessionsAutonomy()`/`cleanupDelayHours()` and
   follows the same `loadConfigSync().mag` lookup shape.

2. **Session discovery is gated.** When the flag is off,
   `discoverAll()` in `src/sessions/index.ts` short-circuits past
   `discoverT3code()` and the fallback `console.error` log line; the
   legacy `discoverCodex` + `discoverClaudeCode` scanners run directly
   instead of as a fallback. As defense-in-depth, `discoverT3code()` in
   `src/sessions/discover-t3code.ts` also returns `[]` immediately when
   the flag is off (no server probe, no `console.error`).

3. **Adapter assignment is gated.** When the flag is off,
   `validateAssignAdapter()` in `src/slots/index.ts` rejects `t3code`
   (only `t3code`; `tmux`/`manual` continue to validate) with the
   message:
   ```
   t3code integration is currently paused; enable mag.t3code_integration_enabled in config.yaml to re-engage
   ```
   `VALID_ASSIGN_ADAPTERS` is unchanged — re-enabling is purely runtime.

4. **Existing `-a t3code` slots: option (c) — only new assign/preempt blocked.**
   `resume`/`redispatch` of an already-running `-a t3code` slot continues
   to work (no new validation guard added to those paths). The only new
   rejections fire from `validateAssignAdapter()`, which is called by
   `slotAssign` (line 347), `slotPreempt` (line 738), and the CLI
   parser's pre-flight check (line 1565). Rationale (one-liner cited
   from a code audit): option (c) covers the user's "no new t3code work"
   intent with **zero additional guards** because the three
   `validateAssignAdapter()` call-sites are all on the new-work paths;
   `slotResume`, `slotRestoreFromPreempt`, and the redispatch path do
   not invoke it. Option (a) would require new guards on each of those
   paths plus their tests — strictly more surface.

5. **Orchestration auto-flag selection is gated.** When the flag is off,
   `selectOrchestrationFlags()` (and the `selectOrchestrationFlagsForTask`
   wrapper) in `src/adapters/t3code.ts` refuses to return a `t3code`
   adapter selection. Both production callers — `maybeFillEmptySlots()`
   keepalive (`src/mag.ts:2899`) and `slotStart()` auto-fill
   (`src/slots/index.ts:1005`) — log a single clear `console.error` line
   ("auto-fill skipped: t3code integration paused") and treat the slot
   as not auto-fillable, rather than silently falling back to a stale
   default. `globalAdapter()` is *not* changed (the field exists for
   re-engagement); the gate sits above it.

6. **`ensureT3codeIfEnabled` honors both flags.** The guard in
   `src/mag.ts` `ensureT3codeIfEnabled()` short-circuits when
   `mag.ensure_t3code === false` **or** when
   `!t3codeIntegrationEnabled()`. The existing `mag.ensure_t3code` field
   keeps working for users who set it; the new flag is the stronger
   gate that subsumes it. Briefing precompute, keepalive, and fresh-start
   call-sites all benefit transitively.

7. **`cleanupDoneTaskThreads` is gated.** `cleanupDoneTaskThreads()`
   short-circuits its **t3code thread-deletion block** (server import,
   `serverStatus()` probe, thread delete) when the flag is off. The
   retrospective-fallback collection loop in the same function is
   unaffected — it is not t3code-related and must keep running.
   *(Revised during gh-ludics-539 implementation: the original wording
   guarded the whole function / the `briefingPrecomputeContext()` call
   site, but `cleanupDoneTaskThreads()` was refactored to fold in a
   non-t3code retrospective-fallback loop, so a whole-function gate would
   silently disable retro fallback. The gate is narrowed to the t3code
   block only.)*

8. **`test-health:t3code-ludics` skip is visible.** When the flag is
   off, `checkProjectTestHealth()` in `src/health.ts` returns
   `{ skipped: true, reason: "t3code-integration-paused" }` for any
   project whose name matches `t3code-ludics` *or* (preferred,
   forward-compatible) whose project config carries
   `requires_t3code: true`. The harness `config.yaml` entry for
   `t3code-ludics` is updated with `requires_t3code: true`. The
   `runAllTestHealth()` log line `[test-health] <name>: skipped
   (t3code-integration-paused)` surfaces the skip — mirrors how
   `postponed` projects are surfaced (visible, not silent). This satisfies
   Q2's "low-priority info entry" requirement: skip is shown, not
   silently elided.

9. **Skill-side `t3code-server-down` gating via new CLI subcommand.**
   A new `ludics t3code integration-status` subcommand is added to the
   `t3code` dispatcher in `src/t3code/index.ts` (alongside `status`,
   `start`, `stop`, `doctor`). It prints `enabled` or `paused` to stdout
   and exits 0. The `ludics-health-check` skill template
   (`skills/ludics-health-check.md`) consults this subcommand before
   probing the t3code server: when output is `paused`, the skill skips
   emitting `t3code-server-down` and discovery-noise findings. The
   existing `serverStatus()` primitive stays honest (no flag awareness
   inside it); the conditional lives in the skill template.

10. **Defaults are zero-migration.** No change to harness `config.yaml`
    is required for the integration to be paused: when the field is
    absent, the helper returns `false` and every gate short-circuits.
    Re-engagement = add `mag.t3code_integration_enabled: true` to
    `config.yaml` and commit; no other state needs touching.

11. **Tests cover both flag states.** Each new gate has paired
    flag-on / flag-off coverage:
    - `src/config.test.ts` — `t3codeIntegrationEnabled()` returns
      `false` when key absent, `true` when set, `false` when set to
      anything not strictly `true`.
    - `src/slots/index.test.ts` — `validateAssignAdapter("t3code")`
      throws the paused message when flag is off; passes when flag
      is on; `validateAssignAdapter("tmux")` and
      `validateAssignAdapter("manual")` are unaffected by the flag.
    - `src/sessions/sessions.test.ts` (or the closest existing
      sessions test) — `discoverAll()` skips `discoverT3code()` when
      flag is off; the legacy-fallback `console.error` line is absent
      from the flag-off path.
    - `src/adapters/t3code.test.ts` — `selectOrchestrationFlags()`
      and `selectOrchestrationFlagsForTask()` refuse when flag is off
      (with a typed sentinel return or thrown error, whichever the
      callers handle cleanly — implementer's choice; both callers
      already have try/catch envelopes).
    - `src/health.test.ts` (or `src/health-test-health.test.ts`) —
      `checkProjectTestHealth()` returns
      `{ skipped: true, reason: "t3code-integration-paused" }` for a
      project with `requires_t3code: true` when flag is off; runs
      normally when flag is on.
    - `src/mag.test.ts` (or the closest existing mag test) —
      `ensureT3codeIfEnabled()` short-circuits when flag is off and
      when `ensure_t3code === false`; runs when both are on/unset.

12. **No regressions in unrelated suites.** `bun run build` succeeds;
    `bun test` passes with no new failures in suites outside the new
    coverage above.

### AC verification notes

This task's ACs are paths/configs inside the project's own git context
(`/Users/lukstafi/ludics`), so commit-SHA evidence is appropriate. No
cross-repository or symlinked-tree paths are referenced; the
find/grep-over-SHA exception from the proposal template does not apply.

## Context

### How the broken surfaces leak today

- **Sessions discovery (`src/sessions/index.ts:17`).** `discoverAll()`
  always calls `discoverT3code()` first and uses it as the primary
  source. When the server is down, `discoverT3code()` returns `[]` and
  emits a `console.error` (`src/sessions/discover-t3code.ts:94`,
  "ludics: t3code discovery failed: ..."); `discoverAll` then logs its
  own "falling back to legacy scanners" line. Both lines appear on
  every keepalive sessions report tick.

- **Adapter validation (`src/slots/index.ts:43`).**
  `validateAssignAdapter()` accepts `t3code` unconditionally. Called
  from `slotAssign` (line 347), `slotPreempt` (line 738), and the
  CLI parser (line 1565). Importantly, `slotResume` /
  `slotRestoreFromPreempt` / the redispatch path do **not** call it —
  so option (c) (block new assign/preempt only) requires zero
  additional guards on those paths.

- **Orchestration auto-flag (`src/adapters/t3code.ts:760`).**
  `selectOrchestrationFlags()` returns `{adapter: globalAdapter(),
  args, isDuo}`. `globalAdapter()` still defaults to `"t3code"` in many
  configs, so even without the integration the keepalive `maybeFillEmptySlots`
  and `slotStart` auto-fill would happily set up a t3code slot. Callers
  are at `src/mag.ts:2899` and `src/slots/index.ts:1005`.

- **Briefing precompute (`src/mag.ts:1912`).**
  `ensureT3codeIfEnabled()` already short-circuits on
  `mag.ensure_t3code === false`, but most users have not set that.
  Called from briefing precompute (1927), keepalive (3222), and
  fresh-start (3344). `cleanupDoneTaskThreads()` runs after the ensure
  step in `briefingPrecomputeContext()` and incurs an import + status
  probe even when t3code is unreachable.

- **Health-check `test-health:t3code-ludics`
  (`src/health.ts:95`).** `checkProjectTestHealth()` resolves the
  test command from `project.test_command` or `detectTestCommand()`,
  then runs it with a 300s timeout. The t3code-ludics suite hits the
  timeout each tick.

- **Health-check `t3code-server-down` (skill-side, not code-side).**
  Grepping for the literal string `t3code-server-down` finds matches
  only in the harness's `mag/health-last.json` and notification
  journals — not in `src/` or `skills/`. The finding is emitted by
  Mag's natural reasoning over the health-check skill's observations,
  not by a code constant. Gating it cheaply means giving the skill a
  way to see the flag value without parsing config — hence the new
  `ludics t3code integration-status` subcommand.

### Config plumbing patterns

`src/config.ts` already exposes a family of small accessor helpers
(`preemptAutonomy`, `startSessionsAutonomy`, `cleanupDelayHours`) that
all follow `loadConfigSync().mag` casts with a default. The new
`t3codeIntegrationEnabled()` should follow the same shape:

```ts
export function t3codeIntegrationEnabled(): boolean {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  return mag?.t3code_integration_enabled === true;
}
```

The config loader is cast-based, not schema-validated, so no schema
migration is needed.

### Q1 audit — option (c) is less invasive

| Surface | Option (a): refuse ALL ops on t3code slots | Option (c): block new assign/preempt only |
|---|---|---|
| `validateAssignAdapter` | 1 change | 1 change |
| `slotResume` (line 1143+) | needs new guard | unchanged |
| `slotRestoreFromPreempt` (line 795+) | needs new guard | unchanged |
| Redispatch path (`src/orchestration/*`) | needs new guard | unchanged |
| New tests | 4+ per added guard | 1 (assign/preempt rejection) |

Option (c) wins on call-site count and test-surface diff, with no
silent state rewrites. Documenting per Q1's request.

### Q2 — visible skip for `test-health:t3code-ludics`

Mirroring `postponedProjectSet()` (already returns
`{ skipped: true, reason: "postponed" }` and surfaces a
`[test-health] <name>: skipped (postponed)` log line in
`runAllTestHealth()`), the new skip path uses `reason:
"t3code-integration-paused"`. The runAllTestHealth log line falls out
for free — it already prints `result.reason` on skip.

### Q3 — no auto-triggers on re-engagement

When the flag flips to `true`, the next keepalive tick will rediscover
t3code via the now-active discovery path; the next briefing precompute
will call `ensureT3codeIfEnabled` which now starts the server; the next
health-check tick will re-emit `t3code-server-down` findings naturally.
No flip-detection logic; no PR work here for re-engagement.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Add `t3codeIntegrationEnabled()` to `src/config.ts`** next to the
   other `mag.*` accessors. Export it.

2. **Gate session discovery in `src/sessions/index.ts`** at the top
   of `discoverAll()`: when the flag is off, return the legacy
   scanner output directly (no `discoverT3code` call, no fallback log
   line). Also early-return `[]` inside
   `src/sessions/discover-t3code.ts` `discoverT3code()` for
   defense-in-depth.

3. **Gate `validateAssignAdapter` in `src/slots/index.ts`**: when
   `adapter === "t3code"` and `!t3codeIntegrationEnabled()`, throw
   with the paused message. Keep `t3code` in `VALID_ASSIGN_ADAPTERS`.

4. **Gate `selectOrchestrationFlags` in `src/adapters/t3code.ts`**:
   when `!t3codeIntegrationEnabled()`, throw a typed error
   (`T3codeIntegrationPausedError`?) or return `{ adapter: null, args:
   "", isDuo: false }`. Update the two callers
   (`maybeFillEmptySlots`, `slotStart` auto-fill) to log and skip on
   that sentinel, not throw upward. Implementer's choice — either
   shape is fine, prefer whichever produces the least caller churn.

5. **Extend `ensureT3codeIfEnabled` in `src/mag.ts`**: change the
   guard from `magConfig?.ensure_t3code === false` to
   `magConfig?.ensure_t3code === false || !t3codeIntegrationEnabled()`.
   Also guard the `cleanupDoneTaskThreads()` call in
   `briefingPrecomputeContext()` (or early-return inside
   `cleanupDoneTaskThreads`).

6. **Gate `checkProjectTestHealth` in `src/health.ts`**: add an early
   `return { skipped: true, reason: "t3code-integration-paused" }`
   when `!t3codeIntegrationEnabled()` and the project either has
   `requires_t3code: true` *or* has name `t3code-ludics`. Add
   `requires_t3code: true` to the `t3code-ludics` project entry in
   harness `config.yaml` (state-repo commit, separate from the code
   commit — workers should note this in the task notes when they
   land the change).

7. **Add the `integration-status` subcommand to
   `src/t3code/index.ts`**: a new `case "integration-status"` block
   in the existing `switch (sub)` that calls
   `t3codeIntegrationEnabled()` and prints `enabled` or `paused`. One
   line in `src/cli-dispatch.ts` may need adjusting if there's a
   subcommand whitelist; the existing `t3code` dispatch already
   defers to the subcommand-parsing inside `t3code/index.ts`.

8. **Update `skills/ludics-health-check.md`** to consult
   `ludics t3code integration-status` before emitting
   `t3code-server-down` findings or discovery-noise findings. Single
   conditional in the step that today probes the server.

9. **Tests** — pair flag-on / flag-off cases for every new gate, as
   enumerated in AC 11.

10. **Build + tests** — `bun run build && bun test`.

## Scope

**In scope:**
- New `t3codeIntegrationEnabled()` helper and the six gates above.
- New `ludics t3code integration-status` CLI subcommand.
- `ludics-health-check` skill conditional.
- Tests for each gate.
- `requires_t3code: true` annotation on the `t3code-ludics` project
  entry in harness `config.yaml` (state repo, not project repo).

**Out of scope (per issue body):**
- Fixing the underlying t3code integration bugs (timeouts, server
  reliability, scanner behavior).
- Removing the t3code adapter or discovery code paths entirely.
- Any cross-node federation changes.
- Flip-detection logic on re-engagement (Q3 resolved: no auto-triggers).
- Migrating other projects to use `requires_t3code` (only `t3code-ludics`
  is annotated; the field is forward-compatible for future projects).

**Dependencies:** None. This is an independent change.
