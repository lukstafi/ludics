# Slot ttyd mid-session deaths: root-cause + reachability hardening

## Goal

Dashboard terminals for an active slot intermittently show "failing to connect"
while the underlying tmux session is alive. Root-caused 2026-06-15 from the
per-agent ttyd log `~/Library/Logs/ludics-slot-1-coder-ttyd.log` (port 7681,
during the `task-cabf6402` run): the coder ttyd was killed/respawned every
~30–60s, then went **fully down for ~11m45s** (18:42:25 → 18:54:10) while the
tmux session `s1_coder_task-cabf6402` stayed alive. Any terminal access in that
window got connection-refused against a live session.

The predecessor proposal (`slot-ttyd-observability-flap-suppression.md`,
already landed) delivered the per-agent logs *and* the anti-flap give-up
sentinel — that is the machinery producing both the log evidence and the
11.5-min gap. This task is the **follow-on root-cause work**: find and stop the
mid-session ttyd deaths so the flap never trips, plus close the connectivity
gap where a terminal stays unreachable even when its ttyd is healthy.

Supersedes gh-ludics-145 (closed as fixed 2026-06-16 — its `setsid` ask already
landed via `setsidWrap` in `buildTtydSpawnArgs`; its symptom was ttyd dying when
the *runner* exits, a distinct already-resolved mode).

## Acceptance Criteria

Intent: terminals stay reachable for the life of an active slot — no
connection-refused windows from avoidable ttyd restarts, no killed-but-not-
respawned gaps, and no dead-IP-family gaps where a healthy ttyd is unreachable.

### Root-cause: stop the mid-session ttyd deaths

- [ ] The mid-session restart churn is root-caused to a specific code path that
      invalidates a live ttyd's tmux-attach target (or its tracked pid) during
      an active slot. The PR description names the mechanism and the triggering
      call sequence, citing the relevant function(s) by name (not line number).
- [ ] When a slot re-init / resume path recreates a tmux agent session under a
      live ttyd, the ttyd is brought back into a consistent state in the **same
      operation** — either (a) the ttyd is restarted so it re-attaches the new
      session, or (b) the session is not recreated when a healthy attach already
      exists. After such a re-init, no terminal is left attached to a destroyed
      session, and the persisted `ttydPids[agent]` points at the live ttyd.
- [ ] `ensureTtydAlive` is **not** the source of churn for a healthy ttyd: a
      ttyd that is alive *and attached to the current session* is neither
      pkilled nor respawned. (The existing pid-liveness guard already covers
      alive-pid; this AC additionally requires that the tracked pid is not
      silently lost by an upstream re-init — see prior criterion.)
- [ ] No persisted-state path overwrites `ttydPids[agent]` with `undefined` /
      a stale pid for an agent whose ttyd is still running. (Concretely: the
      resume re-init must not record an empty/garbage pid for an agent whose
      port-in-use check caused `startTtyd` to be skipped.)

### Hardening: wrong-session detection in `ensureTtydAlive` (optional, may be folded in)

- [ ] If implemented, `ensureTtydAlive` additionally treats a ttyd whose live
      process is attached to the **wrong tmux target** (stale session) as
      needing restart — mirroring the `pkill -f "ttyd.*--port ${port}"` /
      `tmuxTarget(...)` matching already used at spawn — so the ensure converges
      on session identity, not merely port occupancy. This is hardening, not the
      primary fix; it must not introduce churn for a correctly-attached ttyd.

### Connectivity: terminal reachable over the advertised address family

- [ ] A terminal for an active slot is reachable from the dashboard client over
      whatever address the dashboard advertises in `terminals.json`. The current
      gap (ttyd binds IPv4-only via `buildTtydSpawnArgs`, while the advertised
      `host` is the cluster machine's MagicDNS name carrying both A and AAAA, so
      an IPv6-pinning client reaches a dead family) is closed by **one** of:
      - (a) ttyd binds dual-stack (e.g. `::`) so both families are served, or
      - (b) the dashboard emits an IPv4 literal in `terminals.json` (precedent:
            `resolveHost` in `src/t3code/server.ts` maps `localhost`→`127.0.0.1`).
- [ ] The chosen remediation does not regress single-machine localhost use or
      cross-machine (Tailnet) terminal access.

### Durable guard

- [ ] A unit test covers the chosen root-cause fix at the behavioural level
      (e.g. a re-init under a live ttyd does not leave a stale-session terminal
      / does not lose the tracked pid). Extend the existing flap-suppression
      matrix in `src/orchestration/runner.lifecycle.test.ts` rather than
      duplicating it; if the fix lives in `slotResume`, the test may live with
      the slots tests instead.
- [ ] `bun test` and lint pass; no regression in the existing
      `ensureTtydAlive — flap suppression` suite.

## Context

How it works now (verified against `~/ludics` @ main, 2026-06-15/16):

- **`startTtyd(slot, agentName, role, taskId)`** — `src/adapters/tmux-adapter.ts`.
  Unconditionally `pkill -f "ttyd.*--port ${port}"` then
  `Bun.spawn(buildTtydSpawnArgs(...))`. No idempotency guard inside; callers are
  responsible for not invoking it on a healthy ttyd.
- **`buildTtydSpawnArgs`** — same file. argv is
  `exec ttyd --writable --port ${port} tmux attach -t <target> >>log 2>&1`,
  `setsidWrap`-wrapped. **IPv4-only — no `-6`/`::` bind flag.** The `tmux attach
  -t <target>` makes a running ttyd's argv a reliable session-binding check, and
  ties the ttyd's lifetime to that tmux session: if the session is destroyed and
  recreated, the attach client exits and ttyd dies.
- **`createTmuxAgentSession`** — same file. Kills any existing session then
  `tmuxNewSession`. Called at slot setup.
- **`ensureTtydAlive(state)`** — `src/orchestration/runner.ts`. Runs once per
  `TTYD_HEALTH_CHECK_INTERVAL_S = 30`s. For each agent: if the tracked pid is
  alive it `continue`s (no churn); otherwise it restarts via `startTtyd` and
  drives the anti-flap state machine (`TTYD_FLAP_THRESHOLD = 10` restarts within
  `TTYD_FLAP_WINDOW_S = 600`s → `backoffUntil = TTYD_GIVE_UP_SENTINEL`, single
  `ttyd_flapping` event, no further respawn; `TTYD_FLAP_QUIET_RESET_S = 300`s of
  quiet resets the window). This confirms the 11.5-min gap is the give-up
  sentinel reacting to the churn — *intended* back-off, not a bug. So the task
  is to stop the deaths, not the respawn logic.
- **`slotResume` re-init** — `src/slots/index.ts`. The prime suspect for the
  deaths. For each agent (loop around the `sessionExists` check):
  - `newTtydPids` is seeded from the existing `ttydPids` (so the
    port-in-use-skip path preserves a *prior* pid).
  - When the session does **not** exist, the code `tmuxNewSession(...)` recreates
    it, but the ttyd start is gated by an `lsof -i :${port}` port-in-use check —
    if a ttyd is still listening on that port (attached to the *now-destroyed*
    session) `startTtyd` is **skipped**. That orphaned ttyd's attach client then
    exits → ttyd dies → `ensureTtydAlive` respawns it on the next tick. A burst
    of resume/re-init calls during an active run reproduces the observed
    30–60s flap exactly.
  - After the loop, `writeTmuxSlotState({ ...tmuxState, ttydPids: newTtydPids })`
    persists the (possibly stale) pid map.
- **Terminals advertisement** — `src/dashboard.ts` `generateTerminals()`. `host`
  comes from `clusterMachine(machine)?.host` (the cluster machine's MagicDNS
  hostname), not directly from `networkHostname()`. That MagicDNS name resolves
  both A and AAAA, so a client preferring IPv6 hits a family ttyd does not bind.
- **Existing tests** — `src/orchestration/runner.lifecycle.test.ts` already has a
  `describe("ensureTtydAlive — flap suppression")` block (the below-threshold /
  threshold-cross / give-up / quiet-reset / record-delete cases). Extend it.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The root-cause fix and the connectivity fix are independent and both modest;
the proposal carries both because they share the single intent "terminals stay
reachable for the life of an active slot."

1. **Re-init coherence (the death fix).** In `slotResume`'s per-agent re-init,
   make session recreation and ttyd state move together. The cleanest shape: when
   the session is recreated (`!sessionExists`), restart the ttyd unconditionally
   (it is now attached to a destroyed session), recording the fresh pid in
   `newTtydPids[agent]` — i.e. drop the port-in-use skip *for the recreate
   branch* (the existing ttyd, if any, is orphaned and should be replaced). Keep
   the port-in-use skip only where the session was **not** recreated and a
   healthy ttyd is genuinely still serving the live session. Ensure no code path
   writes an `undefined`/stale pid for a still-running ttyd.

2. **Optional: wrong-session detection in `ensureTtydAlive`.** Add an argv/target
   check so an alive-but-wrong-session ttyd is treated as dead and restarted,
   mirroring the `pkill -f "ttyd.*--port ${port}"` matcher against
   `tmuxTarget(slot, agent.name, taskId)`. This makes the ensure self-healing
   even if a future re-init path reintroduces the orphan. Include only if it
   adds no churn risk for correctly-attached ttyds.

3. **Connectivity: pick (a) or (b).** Prefer the smaller-blast-radius option.
   (a) dual-stack `::` bind in `buildTtydSpawnArgs` serves both families with no
   dashboard change; (b) emit an IPv4 literal in `generateTerminals` following
   the `resolveHost` precedent. Either satisfies the AC; choose at implementation
   time and justify in the PR.

4. **Test.** Add a behavioural unit test for the re-init coherence fix (a
   recreate-under-live-ttyd path leaves no stale-session attach and persists the
   live pid), extending the existing flap-suppression suite or the slots tests as
   appropriate.

## Scope

In scope: the mid-session ttyd-death root cause (re-init coherence), the
IPv4-only-bind connectivity gap (one remediation), optional wrong-session
hardening in `ensureTtydAlive`, and a durable unit test. Framework code → fix
worktree + PR against `lukstafi/ludics`.

Out of scope:
- The respawn / back-off / flap-suppression machinery itself — already correct
  and landed; do not redesign it.
- `~/ludics` checkout-lag — resolved OUT OF SCOPE during elaboration (it is an
  independent operational concern, better framed as general workflow-checkout
  hygiene, not a shared root cause and not `~/ludics`-specific).
- gh-ludics-145 — already closed as fixed; this task supersedes it.

Relates to: gh-ludics-145 (superseded). Builds on the landed
`slot-ttyd-observability-flap-suppression` proposal.
