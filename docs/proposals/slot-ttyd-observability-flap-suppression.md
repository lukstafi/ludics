# Slot ttyd observability + flap-suppression

## Goal

Slot ttyd processes (per-slot, per-agent) currently spawn with stdout/stderr
ignored, so when ttyd dies the runner restarts it without leaving any error
trace on disk. Empirical evidence shows this is a real problem: slot 1 has
accrued **1258 `ttyd_restarted` events** vs slot 2's **1 event** — a sustained
flap with no diagnostic signal.

This task delivers two pieces of infrastructure so we can finally see why ttyds
die and stop the runaway respawn churn:

1. **Observability**: capture ttyd stdout+stderr to per-slot per-agent log
   files at `~/Library/Logs/ludics-slot-{N}-{agent}-ttyd.log` (matches Mag's
   existing `ludics-ttyd.log` convention; `newsyslog` handles rotation).
2. **Flap-suppression**: add restart backoff to `ensureTtydAlive` with a
   window-reset counter, a hard threshold (10 restarts in 10 min), a single
   `ttyd_flapping` event on threshold-cross, and recovery via a dashboard
   force-reload on the Terminals tab posting to a new
   `/api/ttyd-reset` endpoint that clears the per-agent counter.

The *root cause* of slot 1's flap is explicitly out of scope — fix that once
the new logs reveal it.

## Acceptance Criteria

### Log capture

- [ ] `startTtyd` in `src/adapters/tmux-adapter.ts` redirects ttyd stdout AND
      stderr to `~/Library/Logs/ludics-slot-{N}-{agent}-ttyd.log`, where `{N}`
      is the slot number and `{agent}` is the agent name (e.g.
      `ludics-slot-1-coder-ttyd.log`).
- [ ] If `~/Library/Logs/` does not exist (non-macOS), fall back to `/tmp/` —
      mirrors `src/mag.ts`'s existing fallback (the `existsSync(...) ? ... : "/tmp"`
      pattern around `getTtydPort`).
- [ ] The log directory and file are created on first write; ttyd output
      **appends** (no truncation across restarts) so cause-of-death history is
      preserved.
- [ ] After a forced ttyd kill on an active slot, the corresponding log file
      grows (non-zero new bytes) with ttyd's exit/startup output. Verifiable
      manually by `kill $(pgrep -f "ttyd.*--port 7681") && tail -f ~/Library/Logs/ludics-slot-1-coder-ttyd.log`.
- [ ] `setsidWrap` continues to detach the ttyd from the parent process group
      — no regression in survival across keepalive parent exit.

### Flap-suppression state

- [ ] `TmuxSlotState` (in `src/adapters/tmux-adapter.ts`) is extended with an
      optional field
      `ttydRestartCounts?: Record<string, { count: number; firstRestartAt: number; backoffUntil?: number }>`
      keyed by agent name. The field is optional so existing on-disk
      `tmux-slot-{N}.json` files without it continue to load (no migration).
- [ ] `readTmuxSlotState` returns the field when present and `undefined` when
      absent; `writeTmuxSlotState` round-trips it.

### Backoff logic in `ensureTtydAlive`

- [ ] In `src/orchestration/runner.ts`, `ensureTtydAlive` reads/writes
      `tmuxState.ttydRestartCounts[agent.name]` to track restart cadence.
- [ ] **Window reset**: if the time since the agent's last restart exceeds
      **5 minutes** of quiet, reset that agent's counter to zero before
      considering a new restart. (A transient blip resets cleanly.)
- [ ] **Threshold**: if the agent records **10 restarts within a 10-minute
      window** (`now - firstRestartAt <= 600s` and `count >= 10`), the runner
      stops respawning that agent's ttyd and sets `backoffUntil` to a sentinel
      ("give up" state — see recovery below).
- [ ] **Single emission**: `ttyd_flapping` event is emitted **once** at the
      moment the threshold is first crossed (i.e. when the agent transitions
      into the give-up state), not on every subsequent poll. The event's
      `event_type` is the literal string `"ttyd_flapping"` and the payload
      mirrors the existing `ttyd_restarted` shape (source, scope, slot, task,
      agent), additionally carrying `restart_count` and `window_seconds`, plus
      a `message` that includes the absolute path to the per-agent log file
      so consumers (health check, CLI) can point users there.
- [ ] While in give-up state, `ensureTtydAlive` skips both the
      `processAlive` check and the `startTtyd` call for that agent — no
      `pkill`, no respawn, no further `ttyd_restarted` events.
- [ ] Restarts under threshold continue to emit `ttyd_restarted` as today
      (unchanged behaviour).

### Recovery via dashboard force-reload

- [ ] A new HTTP endpoint `POST /api/ttyd-reset` is added to
      `src/dashboard-server.ts`. Query params: `slot` (1–6, required) and
      `agent` (agent name, optional — when omitted, clears all agents in the
      slot). Body unused.
- [ ] The handler loads `tmux-slot-{N}.json` via `readTmuxSlotState`,
      deletes the matching entries from `ttydRestartCounts`, writes back via
      `writeTmuxSlotState`, and returns `200 OK`. Returns `400` for invalid
      slot, `404` if no slot state exists.
- [ ] After reset, the next `ensureTtydAlive` poll sees no give-up state and
      proceeds to restart the dead ttyd normally (counter starts fresh).
- [ ] `templates/dashboard/terminals.html` posts to `/api/ttyd-reset` (one
      request per active slot, no `agent` param) on full page load — i.e.
      inside `loadTerminals`'s first invocation block, not on the 30s
      `setInterval` tick. A force-reload (Cmd-Shift-R) re-runs the script and
      thus re-issues the reset; a normal periodic refresh via the existing
      `setInterval(loadTerminals, 30000)` does not. Implementation: a
      module-level `resetSent = false` flag guarding a `Promise.all(...)` that
      fires once on first `loadTerminals` and never again for that page
      lifetime.
- [ ] Reset failures (network error, non-2xx) do not block terminal
      rendering — log to console only.

### Tests / verification

- [ ] An integration test (or extension of an existing tmux-adapter / runner
      test) covers the backoff state machine: with `processAlive` mocked to
      always return false and `nowEpoch` advancing, after 10 forced restarts
      within the window the next call emits `ttyd_flapping` exactly once and
      no further `ttyd_restarted` events fire on subsequent polls.
- [ ] A test asserts that after `ttydRestartCounts[agent]` is deleted (the
      `/api/ttyd-reset` effect, simulated directly on state), the next poll
      restarts ttyd and the `ttyd_flapping` event does not re-emit until the
      threshold is again crossed.
- [ ] Cardinality probe: with all 6 slots active in tmux mode, `ls
      ~/Library/Logs/ludics-slot-*-ttyd.log` shows one file per active
      (slot, agent) pair (verifiable manually post-deploy).

## Context

### Current spawn site

`startTtyd` in `src/adapters/tmux-adapter.ts` calls
`Bun.spawn(setsidWrap(["ttyd", ...]), { stdin: "ignore", stdout: "ignore", stderr: "ignore" })`.
The `setsidWrap` helper in `src/orchestration/util.ts` prepends `setsid`
(Linux) or `perl ... POSIX::setsid; exec @ARGV` (macOS) so ttyd survives the
parent process exit.

### Current health check

`ensureTtydAlive` in `src/orchestration/runner.ts` polls every
`TTYD_HEALTH_CHECK_INTERVAL_S = 30` seconds, gated by a module-scoped
`lastTtydCheckAt`. For each agent in `state.agents` it checks `processAlive`
(from `src/t3code/server.ts`) on the recorded pid in
`tmuxState.ttydPids[agent.name]`; if dead, it calls `startTtyd` and emits a
`ttyd_restarted` event. There is no per-agent state, no backoff, no give-up
condition.

### Existing log-capture precedent (Mag)

`src/mag.ts` (around the `getTtydPort` block) writes Mag's own ttyd output to
`~/Library/Logs/ludics-ttyd.log` with `/tmp` as fallback, using shell
redirection (`>>${logFile} 2>&1`) inside `tmuxRunShell`. Mag runs ttyd
*inside* its tmux session, which slots cannot do (slot ttyds attach *to* the
slot's tmux session — circular). Slot ttyds will use `Bun.spawn` with shell
wrapping, not `tmuxRunShell`.

### Dashboard server pattern

`src/dashboard-server.ts` has many `if (pathname === "/api/...")` handlers,
e.g. `/api/slot-clear`, `/api/slot-mode`, `/api/slot-start`. New endpoint
slots in alongside them with the same shape: validate query params, perform
mutation, return `Response`.

### Terminals page

`templates/dashboard/terminals.html` is a small static page whose `<script>`
block defines `loadTerminals()` and ends with `loadTerminals();
setInterval(loadTerminals, 30000);`. The first `loadTerminals()` call is the
natural attach point for the one-shot reset POST.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Spawn-with-redirection mechanism

User left this open ("agent's choice"). Two options were considered in
elaboration:

- **(a) Bash wrapper**: change the argv from
  `["ttyd", "--writable", "--port", String(port), "tmux", "attach", "-t", target]`
  to `["bash", "-c", \`exec ttyd --writable --port ${port} tmux attach -t '${target}' >>'${logFile}' 2>&1\`]`,
  still wrapped in `setsidWrap`. The `exec` ensures bash replaces itself with
  ttyd so `proc.pid`'s liveness reflects ttyd's. Mirrors Mag's spirit (shell
  redirection).
- **(b) FD passing**: `openSync(logFile, "a")` (Node `fs`) and pass the
  number to `Bun.spawn`'s `stdout`/`stderr`. More idiomatic Bun, fewer shell
  quoting hazards.

**Recommendation: (a) bash wrapper with `exec`.** It keeps the spawn pipeline
visually parallel with Mag's, and the quoting risk is contained because
`logFile` and `target` are known-safe strings (numeric slot, agent name from
config, fixed `~/Library/Logs/` prefix). Single-quote the substitutions inside
the bash command. Verify with a manual smoke test that `processAlive(proc.pid)`
returns `false` after killing ttyd directly (the `exec` should make the bash
process replace itself with ttyd, so the pid is ttyd's pid; if the platform
quirk breaks this, fall back to (b)).

### Backoff state machine

Per-agent state in `ttydRestartCounts[agentName] = { count, firstRestartAt,
backoffUntil? }`:

```
on poll, ttyd dead, agent has no record:
  startTtyd; record { count: 1, firstRestartAt: now }; emit ttyd_restarted

on poll, ttyd dead, agent has record:
  if backoffUntil is set (give-up state):
    skip — do nothing
  else if now - firstRestartAt > 5*60:
    // window-reset: stale, treat as new
    startTtyd; record { count: 1, firstRestartAt: now }; emit ttyd_restarted
  else if count + 1 >= 10 (threshold):
    // threshold crossed
    set backoffUntil to a sentinel (e.g. Number.MAX_SAFE_INTEGER, or 0 used
    as "give up" marker — pick one and document)
    do NOT call startTtyd
    emit ttyd_flapping (single emission)
  else:
    startTtyd; count++; emit ttyd_restarted
```

Use `backoffUntil` as the single source of truth for the give-up state. The
`/api/ttyd-reset` handler simply deletes the map entry, returning the agent
to "no record" state.

### `/api/ttyd-reset` endpoint

Place it adjacent to `/api/slot-clear` in `dashboard-server.ts` (around the
`/api/slot-*` handlers). Sketch:

```ts
if (pathname === "/api/ttyd-reset" && req.method === "POST") {
  const slotParam = url.searchParams.get("slot");
  const agentParam = url.searchParams.get("agent");
  if (!slotParam || !/^[1-6]$/.test(slotParam)) {
    return new Response("Bad Request: slot must be 1-6", { status: 400 });
  }
  const slot = parseInt(slotParam, 10);
  const dir = harnessDir();
  const tmuxState = readTmuxSlotState(slot, dir);
  if (!tmuxState) return new Response("Not Found", { status: 404 });
  if (!tmuxState.ttydRestartCounts) {
    return new Response("OK (no counters)", { status: 200 });
  }
  if (agentParam) {
    delete tmuxState.ttydRestartCounts[agentParam];
  } else {
    tmuxState.ttydRestartCounts = {};
  }
  writeTmuxSlotState(tmuxState, dir);
  return new Response("OK", { status: 200 });
}
```

### Terminals tab POST hook

Inside `loadTerminals`'s first call (gated by a module-level `resetSent`
flag so the 30s interval doesn't re-trigger):

```js
let resetSent = false;
async function maybeResetTtydCounters(activeSlots) {
  if (resetSent) return;
  resetSent = true;
  await Promise.allSettled(
    activeSlots.map(slot =>
      fetch(`/api/ttyd-reset?slot=${slot}`, { method: 'POST' })
        .catch(err => console.warn('ttyd-reset failed', slot, err))
    )
  );
}
// inside loadTerminals after parsing data:
maybeResetTtydCounters(data.activeSlots || []);
```

A force-reload (`Cmd-Shift-R`) reloads the page, which re-evaluates the
script, which resets `resetSent = false` for the new page — recovery
mechanism delivered.

### Health check (downstream consumer)

The `/ludics-health-check` skill reads `events.jsonl`. Adding the new
`ttyd_flapping` event_type is sufficient — no skill code change required;
existing event-type-as-issue plumbing surfaces it. The single-emission
contract ensures it appears once per flap incident, not as continuous noise.

## Scope

### In scope

- Output redirection in `startTtyd` to per-slot per-agent log files in
  `~/Library/Logs/`.
- Per-agent backoff state in `TmuxSlotState` (optional field).
- Backoff logic in `ensureTtydAlive` with window-reset, threshold, and
  single-emission `ttyd_flapping`.
- New `/api/ttyd-reset` endpoint in `dashboard-server.ts`.
- Force-reload reset hook in `templates/dashboard/terminals.html`.
- Tests covering the backoff state machine and reset semantics.

### Out of scope

- **Diagnosing or fixing the root cause** of slot 1's flap. That's a
  follow-up once the new logs reveal what ttyd prints before exiting.
- **Replacing ttyd** with gotty / in-process WebSocket bridge — separate
  decision.
- **Migrating Mag's ttyd log path** — already correct, no change needed.
- **In-process log rotation** — `newsyslog` rotates `~/Library/Logs/*.log`
  by default on macOS; non-macOS `/tmp` fallback accepts unbounded growth as
  a known limitation (rare path; flapping will be rare once root-caused).
- **CLI command** `ludics ttyd reset <slot>` — dashboard force-reload is the
  primary recovery; CLI can be added later if needed.
- **Auto-recover after long quiet window** — explicitly deferred per
  Q3 answer; only the dashboard reset path is delivered now.

### Dependencies

None — this task touches only ludics's own files.
