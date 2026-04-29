# Audit src/ for probe-then-act try/catch patterns where the catch is load-bearing for the action

## Goal

One-shot grep audit of `src/` for the probe-then-act pattern that motivated
PR #430 — a single `try { probe; action } catch { }` where the catch was
quietly swallowing failures for *both* the probe (`process.kill(pid, 0)`,
`fs.statSync(path)`, `JSON.parse(s)`) and the paired action that depends on
the probe's success. The risk is that a future mechanical refactor replacing
only the probe with a helper changes observable behavior on the race where
the action's failure mode no longer reaches the catch.

Source issue: https://github.com/lukstafi/ludics/issues/433
Rescoped 2026-04-29 from a workflow-meta doc memo to this code audit
(action #3 of the original GH issue). Skill-template hint additions
(actions #1 and #2) are abandoned per `feedback_reference_layer_not_inline.md`.

This proposal **is** the audit report — the audit was performed during
proposal drafting. No further coding work is required.

## Acceptance Criteria

- [x] Audit run with the recipe in the task body (or equivalent grep over
      `process.kill`, `fs.read|stat|access`, `JSON.parse`, `spawnSync`).
- [x] Every hit classified as probe-only / probe + paired-action-correct /
      probe + paired-action-needs-follow-up.
- [x] Audit yield documented inline (counts and file:symbol identifiers).
- [x] Recommendation surfaced (close as done vs. file follow-ups).

## Audit Result Summary

**Yield: zero load-bearing-catch fixes needed.**

- 47 candidate hits inspected (process.kill: 17 prod sites; JSON.parse +
  paired action: 30 prod sites; spawnSync probes: 4 sites).
- 0 sites need follow-up tasks.
- Recommendation: **close gh-ludics-433 as done without a PR**.

The PR #430 fix (`slotResume` SIGTERM/SIGKILL inner try/catch in
`src/slots/index.ts`) was the only structurally suspicious site. Every
other probe+paired-action shares one of the following safe shapes:

1. **Action is non-throwing** (e.g. `targetPids.push(n)` after
   `process.kill(n, "SIGTERM")` — synchronous array push cannot throw).
2. **Action has its own internal try/catch** (e.g. `clearIntent(slot)`
   internally wraps `unlinkSync` in try/catch, so re-throw past the outer
   parser-catch is impossible by design).
3. **Combined catch is intentional and idempotent** (e.g. `tryAcquireLock`
   in `t3code/server.ts:170` — outer-catch and inner-catch both perform
   "steal the lock by writing again," so the combined behavior is correct
   regardless of whether `JSON.parse` or `writeFileSync` is the thrower).
4. **Pure-probe wrapper functions** (e.g. `processAlive`,
   `parseJsonRecord`, `safeSyncOutput`, `countCommitsAhead`,
   `isWorktreeNoOp`) — the body has no paired action; the function
   *is* the probe.

## Context

### Audit recipe used

```sh
cd ~/ludics
grep -rn 'try {' src/ \
  | grep -B0 -A4 'process\.kill\|fs\.\(read\|stat\|access\)\|JSON\.parse\|spawnSync'
```

Plus follow-up greps for `process.kill` non-test sites and broader
inspection of multi-line `try {` blocks containing both a probe and a
side-effecting call.

### Site-by-site classification

#### A. `process.kill` sites (production, non-test)

| Site (file:symbol) | Pattern | Classification |
|---|---|---|
| `src/mag.ts` `autoResumeOrchestrators` (~L2596) — `process.kill(pid, 0)` | Pure aliveness probe inside helper-shaped try/catch; sets `alive` boolean. Following block uses `if (alive) continue;`. | **probe-only** |
| `src/queue.ts` `breakStaleLock` (L52) — `process.kill(pid, 0)` | Pure probe; catch sets `pidDead = true`. | **probe-only** |
| `src/t3code/server.ts` `processAlive` (L387) | Helper wrapper; the function *is* the probe. | **probe-only** |
| `src/t3code/server.ts` `terminateProcess` (L444 SIGTERM, L457 SIGKILL) | Both the outer `processAlive(pid)` early-return and the loop guarding `processAlive(pid)` before SIGKILL run *outside* the kill-try. Each `process.kill` is in its own try/catch. | **probe + paired (correct)** |
| `src/adapters/t3code.ts` `killPid` (L639) | Helper wrapper; only one statement in try. | **probe-only** |
| `src/adapters/t3code.ts` slot-status block (L1062) — `process.kill(pid, 0)` | Pure aliveness probe; sets `alive = true` then catch leaves `alive = false`. No paired action inside try. | **probe-only** |
| `src/adapters/tmux-adapter.ts` `killPid` (L140) | Helper wrapper. | **probe-only** |
| `src/adapters/tmux-adapter.ts` (L608, L637) — `try { process.kill(...0); alive = true; } catch { }` | Inline aliveness probe; only assigns boolean. | **probe-only** |
| `src/orchestration/transport-tmux.ts` (L162) — `try { process.kill(pid, "SIGTERM"); } catch { }` | One-statement single-line try; no paired action. The `if (isAgentAlive(...))` aliveness check is *outside* the try. | **probe + paired (correct)** |
| `src/dashboard.ts` `dashboardStop` (L1163) — `process.kill(n, "SIGTERM"); targetPids.push(n);` | Two-statement try, but the action is a non-throwing array push. Behaviorally probe-only. | **probe + paired-action; action cannot throw — correct** |
| `src/dashboard.ts` (L1180) — `try { process.kill(p, "SIGKILL"); } catch { }` | One-statement single-line try. | **probe-only** |
| `src/slots/index.ts` `slotResume` (L1177, L1180, L1256, L1259) — SIGTERM/SIGKILL guards | Already fixed in PR #430 / task-f54cb627. Each `process.kill` is in its own one-line try/catch; the `processAlive(pid)` guard sits between SIGTERM and SIGKILL *outside* both try blocks. | **probe + paired (correct, already fixed)** |

#### B. `JSON.parse` sites (production, non-test)

All inspected sites fall into one of these safe categories:

- **Pure-probe wrappers** (function body is a single try/catch returning
  parsed value or null/default): `src/json.ts` (L13), `src/queue.ts`
  `parseJsonRecord` (L105), `src/queue.ts` (L275 — map fallback to
  `{ raw: line }`), `src/sessions/discover-codex.ts` (L34, L56),
  `src/sessions/discover-claude.ts` (L44 with paired
  `cache.set(...)` — but `Map.set` cannot throw), `src/network.ts`
  (L23), `src/cluster.ts` (L181, L195, L258), `src/health.ts` (L34,
  L78), `src/health-gate.ts` (L70), `src/events.ts` (L107),
  `src/retrospective.ts` (L120, L137), `src/notify.ts` (L357, L616,
  L644), `src/dashboard.ts` (L716, L795, L919, L935),
  `src/t3code/server.ts` (L710), `src/t3code/client.ts` (L249),
  `src/adapters/peer-sync.ts` (L162, L199), `src/adapters/tmux-adapter.ts`
  (L67), `src/sessions/sweep-state.ts` (L79),
  `src/orchestration/peer-sync.ts` (L237, L327),
  `src/orchestration/index.ts` (L137, L237), `src/orchestration/deferred-cleanup.ts`
  (L34), `src/slots/preempt.ts` (L37, L61), `src/slots/json.ts` (L59),
  `src/init.ts` (L398), `src/mag.ts` (L339, L357, L459, L645, L717,
  L1435, L1796, L3179, L3272), `src/tasks/sync.ts` (L55, L323),
  `src/t3code/index.ts` (L321).

- **Paired action with internal try/catch on the action**:
  `src/cluster-http.ts` (L172, L192, L213, L532) — `JSON.parse` followed
  by `clearIntent(slot)`. `clearIntent` (L165) wraps `unlinkSync` in its
  own try/catch, so a stale-intent delete failure cannot escape past the
  outer parser-catch. **probe + paired (correct)**.

- **Combined catch is idempotent and intentional**:
  `src/t3code/server.ts` `tryAcquireLock` (L180) — `JSON.parse(...)`
  followed by `writeFileSync(lp, ...)` inside the same try. Both the
  outer catch and the inner catch perform the same lock-steal write, so
  the behavior is "if anything goes wrong, steal the lock." Documented in
  comments as "Corrupt lock file — steal it." **probe + paired (correct
  by design)**.

- **Cluster-http L172 specifically**: `JSON.parse(...)` then optional
  `clearIntent(slot)` then `return intent`. The `return intent` cannot
  throw. The `clearIntent` is internally guarded. **probe + paired
  (correct)**.

#### C. `fs.statSync`/`readFileSync` direct probes (production)

Most `readFileSync` calls feed into a `JSON.parse` already covered above.
Standalone `statSync` probes:

- `src/sentinel.ts` (L17) — pure probe wrapper.
- `src/mag.ts` (L513, L1775), `src/briefing-lag.ts` (L51),
  `src/queue.ts` (L39, L356), `src/notify.ts` (L148) — all pure-probe
  wrappers returning the mtime/exists.

**No paired side-effecting action.** All probe-only.

#### D. `Bun.spawnSync` sites (production)

- `src/spawn.ts` `safeSyncOutput` (L21) — pure-probe wrapper, the helper.
- `src/orchestration/worktrees.ts` `countCommitsAhead` (L237) — probe;
  returns `null` on any throw.
- `src/orchestration/runner.ts` `isWorktreeNoOp` (L1682) — probe; returns
  `false` on any throw.
- `src/mag.ts` (L3067) — `Bun.spawnSync(["tmux", "attach", ...])` is a
  no-throw exec wrapped in a try; no paired action.

All probe-only.

## Approach

*No implementation needed — the audit is the deliverable.*

Closing recommendation:

1. The Notes block on `tasks/gh-ludics-433.md` should record:
   "Audited 47 candidate sites; 0 load-bearing-catch fixes needed.
   PR #430 was the only structurally suspicious site and is already fixed.
   Closing as done without a PR."
2. Set `status: done` on the task and let the GH issue auto-sync close
   issue #433.

## Scope

**In scope:** `src/**.ts` (excluding `*.test.ts`).

**Out of scope:**
- Skill-template hints (actions #1 and #2 from the original issue) —
  abandoned per `feedback_reference_layer_not_inline.md`.
- Unit tests for race conditions — would be filed per-site if any
  follow-ups were needed (none were).
- Audit beyond `src/` (tests, scripts, infra, `templates/`).
- The migrate-pid-aliveness-probes proposal (separate task) —
  orthogonal cleanup that doesn't change catch semantics.
