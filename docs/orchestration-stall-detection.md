# Orchestration stall detection

The orchestration runner has **two** distinct stall-recovery layers. They
share none of: detection signal, recovery shape, or threshold scale. Names
matter because they describe what the agent is doing and what input shape
will reach the agent's read loop. This page is the canonical reference for
the vocabulary, signals, recovery progressions, and threshold knobs.

## Vocabulary

- **Settled** — the agent is ready to process the next prompt. A static
  pane (no spinner, no churn) is the strongest signal. Pasted input lands
  in the read loop.
- **Hung** — the agent is alive but *not* ready for the next prompt. The
  spinner animates; pane bytes change every tick but no substantive
  progress is being made. Pasted input does **not** reach the read loop.

## The two subsystems

### Settled-no-signal layer

Detected by `detectAndNudgeSettledNoSignal` in
[`src/orchestration/runner.ts`](../src/orchestration/runner.ts).

Trigger: lifecycle still says `running` / `dispatched`, the pane has gone
static (= agent has actually settled), but the authoritative completion
signal — tmux: stop-hook record; t3code: server turn-state observation —
hasn't been received.

Why the recovery shape works: the agent is settled, so its read loop is
open. Enter / "Continue." / a fresh re-dispatch / "stop" all reach it.

Lifecycle bookkeeping fields:

- `lc.settledNoSignalDetectedAt: ISO | null`
- `lc.settledNoSignalNudgeAttempts: number`
- `lc.lastSettledNoSignalNudgeAt: ISO | null`

Recovery ladder (per attempt):

1. Idle + first nudge → `transport.sendEnter()` (prompt may already be in
   the input buffer; only the submit key is missing).
2. Idle + second nudge → `transport.sendTurn(state, agent, "Continue.")`.
3. Idle + third nudge → full re-dispatch via
   `composeSkillMessage(state, agent)`.
4. Done-but-still-running → `"Your work for the <phase> phase is complete.
   Stop and wait for further instructions."`.
5. Dispatch-stuck → `"Your session appears stuck. Please respond to
   confirm you are working on the <phase> phase."`.

After `SETTLED_NO_SIGNAL_MAX_NUDGE_ATTEMPTS` (default `3`) the runner
escalates to `interruptAgent` (force-settle: C-c × 2 + SIGTERM children).

Events emitted: `orchestration_settled_no_signal_detected`,
`orchestration_settled_no_signal_nudge_sent`,
`orchestration_settled_no_signal_force_settle`,
`orchestration_settled_no_signal_nudge_failed`.

### Hung-agent layer (substantive-diff)

Detected by `detectAndNudgeHungAgents` in
[`src/orchestration/runner.ts`](../src/orchestration/runner.ts).

Trigger: tmux pane is changing every tick (so the settled-no-signal layer
never fires) but the changes are spinner-only chrome. The detector
captures the raw 50-line pane each tick and feeds it to `substantiveDiff`,
which trims shared prefix and shared suffix and reports the residual char
count and percent. Under-threshold sustained for
`thresholdSeconds` (default 1200 s = 20 min) is hung.

Lifecycle bookkeeping fields:

- `lc.lastPaneRaw: string | null` — previous-tick capture (~2 KB).
- `lc.substantiveStallSince: ISO | null` — first under-threshold tick in
  the current run; cleared on any substantive diff.
- `lc.substantiveStallChars: number` — cumulative residual chars over
  the run (event payload `diffCharsAccumulated`).
- `lc.hungDetectedAt: ISO | null` — when detection #1 fired.
- `lc.hungNudgeAttempts: number` — `0` (not detected), `1`
  (breakAndPrompt sent), `2` (force-settled).

Recovery ladder:

1. Detection #1 → emit `agent_hung_detected` (payload includes `slot`,
   `agent`, `phase`, `stallSeconds`, `diffCharsAccumulated`,
   `paneSnapshot`); persist incident JSON under
   `mag/hung-incidents/<safe-iso>-slot<N>-<agent>.json` (FIFO-pruned to
   the newest 50); call `transport.breakAndPrompt(state, agent,
   composeSkillMessage(state, agent))`. The tmux implementation sends
   exactly **one** `C-c` keystroke, sleeps 2 s, then `sendTurn(message)`.
2. Detection #2 (after `nudgeCooldownSeconds`, default 180 s) → emit
   `agent_hung_force_settle`; call `transport.interruptAgent(state,
   agent)` (the existing C-c × 2 + SIGTERM force-settle). No further
   hung-recovery attempts.
3. Any substantive diff between detections clears `hungDetectedAt`,
   `substantiveStallSince`, `substantiveStallChars`, `hungNudgeAttempts`.

Skip rules:

- `state.backend !== "tmux"` — t3code uses authoritative server turn-state.
- `runtime.interrupted`.
- `lc.settledNoSignalDetectedAt` is set — the settled-no-signal layer
  owns the agent on this tick. Two distinct attempts counters; no shared
  state.
- `!lc.substantiveStallSince` or stall < threshold.

## Why two layers, not one

The case the legacy `detectAndNudgeHungAgents` was named for —
spinner-only churn, read loop closed — was *never* detected by it.
`lastPaneHash` flipped every second, so `lastPaneChangeAt` kept
refreshing. On 2026-05-01 a codex reviewer was hung for 55 minutes (pane
"Working 55m 20s → 21s → ...") before manual recovery. The recovery shape
the legacy detector implements (Enter / "Continue." / re-dispatch) only
*works* when the agent is settled — when its read loop is open. So that
layer was correctly named after its recovery's precondition, not its
trigger. task-a670cdbf renamed the layer to `SettledNoSignal` and added
this `Hung` detector with the appropriate recovery shape (interrupt the
stream first, *then* prompt).

## Threshold table

Defaults live in
[`src/orchestration/state.ts`](../src/orchestration/state.ts) as
`DEFAULT_SUBSTANTIVE_STALL_CONFIG`. Per-slot overrides come from
`mag.orchestration.substantive_stall.*` in `config.yaml`.

| Constant | Default | Rationale |
|---|---|---|
| `SETTLED_NO_SIGNAL_RUNNING_THRESHOLD_S` | 180 | static pane after status=done |
| `SETTLED_NO_SIGNAL_DISPATCH_THRESHOLD_S` | 90 | failed dispatch should fire fast |
| `SETTLED_NO_SIGNAL_IDLE_RUNNING_THRESHOLD_S` | 180 | prompt-injection failure |
| `SETTLED_NO_SIGNAL_NUDGE_COOLDOWN_S` | 90 | cooldown between nudges |
| `SETTLED_NO_SIGNAL_MAX_NUDGE_ATTEMPTS` | 3 | Enter → Continue → re-dispatch |
| `substantiveStall.thresholdSeconds` | 1200 | absorbs long tool calls; rejects 1h+ stalls |
| `substantiveStall.minChars` | 30 | codex spinner is ~8-12 chars/s |
| `substantiveStall.minPct` | 0.05 | belt-and-suspenders for short panes |
| `substantiveStall.nudgeCooldownSeconds` | 180 | give breakAndPrompt time to land |
| `substantiveStall.maxNudgeAttempts` | 2 | one breakAndPrompt + one force-settle |

## Configuration

`templates/config.reference.yaml`:

```yaml
mag:
  orchestration:
    substantive_stall:
      threshold_seconds: 1200
      min_chars: 30
      min_pct: 0.05
      nudge_cooldown_seconds: 180
      max_nudge_attempts: 2
```

These keys are persisted into `state.config.substantiveStall` and read by
the runtime detector. `migrateState()` backfills the substantive-stall
block (per-leaf) on load so legacy slot JSON upgrades cleanly.

## Incident-capture

Each `agent_hung_detected` writes a JSON file:

```text
mag/hung-incidents/<safe-iso>-slot<N>-<agent>.json
```

Payload:

```json
{
  "detectedAt": "<ISO>",
  "slot": <N>,
  "agent": "<name>",
  "phase": "<phase>",
  "round": <number>,
  "stallSeconds": <number>,
  "diffCharsAccumulated": <number>,
  "paneSnapshot": "<50-line pane capture>",
  "promptSent": "<output of composeSkillMessage>"
}
```

The directory is FIFO-pruned to the newest 50 files at write time (ISO
sorts lexicographically). This is the corpus the post-deploy tuning
plan consumes.

## Related

- [docs/orchestration-patterns.md](orchestration-patterns.md) — general
  orchestration design patterns; cross-references this doc.
- [docs/orchestration-phase-transitions.md](orchestration-phase-transitions.md)
  — turn-lifecycle model.
