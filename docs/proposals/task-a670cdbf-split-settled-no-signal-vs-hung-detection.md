# Split settled-no-signal vs hung detection

## Goal

The orchestration runner currently has one detector named
`detectAndNudgeHungAgents`. Despite its name it does *not* detect hung
agents — it detects **settled-without-signal**: the pane has gone
static (so the agent is in fact ready for input), but the authoritative
completion signal (tmux: stop-hook record; t3code: server turn-state)
hasn't arrived. The recovery shape (Enter / "Continue." /
re-dispatch / "stop") is correct *because* the agent is settled and
its read loop is open. Only the name lies.

The genuinely-hung case — pane churning with spinner-only diff while
the read loop is closed — has never been detected. On 2026-05-01 a
codex reviewer was hung for 55 minutes (spinner "Working 55m 20s →
21s → ..."), so `lc.lastPaneHash` flipped every tick and the existing
detector never fired.

This proposal bundles three changes (one PR by user direction):

1. **Rename** the existing layer `Hung*` → `SettledNoSignal*`
   throughout (function, lifecycle fields, constants, events, test
   file, docs). Mechanical, no behaviour change.
2. **Add** a real hung detector based on a substantive-diff trigger:
   trim shared prefix/suffix from successive 50-line pane captures,
   count the residual chars; under-threshold sustained over a 20-minute
   window means hung.
3. **Add** a new transport recovery method `breakAndPrompt`: a single
   `C-c`, 2 s sleep, then re-dispatch a fresh prompt. Distinct from
   the existing `interruptAgent` (C-c × 2 + SIGTERM force-settle); on
   second hung-detection we escalate to that.

Pairs with task-bce80781 (PR-comments redispatch fix, merged
2026-05-03 as #492). Together they close the "review posted, nobody
acts" failure mode: bce80781 ensures the dispatch fires; this task
ensures a hung agent in the ensuing work phase actually gets unstuck.

## Acceptance Criteria

### Rename: settled-no-signal layer

1. **Function and event renames are exhaustive.** After the PR, a
   case-sensitive grep across `src/`, `tests/`, `docs/`, and
   `templates/` for the literals `detectAndNudgeHungAgents`,
   `stallDetectedAt`, `nudgeAttempts`, `lastNudgeAt`,
   `HUNG_RUNNING_THRESHOLD_S`, `HUNG_DISPATCH_THRESHOLD_S`,
   `HUNG_IDLE_RUNNING_THRESHOLD_S`, `HUNG_NUDGE_COOLDOWN_S`,
   `HUNG_MAX_NUDGE_ATTEMPTS`, `orchestration_hung_detected`,
   `orchestration_nudge_sent`, `orchestration_hung_force_settle`,
   `orchestration_nudge_failed` returns **zero** matches outside
   migration code paths. Each name maps to its
   `settledNoSignal`/`SETTLED_NO_SIGNAL_*` counterpart per the
   table in the task file. *Falsifier:* any one of these literals
   surviving at a runtime call site.
2. **No event dual-emit.** A grep over `journal/events.jsonl`
   produced from a fresh end-to-end run shows
   `orchestration_settled_no_signal_*` events but not the legacy
   `orchestration_hung_*` (modulo new layer's `agent_hung_detected`,
   which is a different event from a different detector). *Falsifier:*
   both new and old event types appear in one run.
3. **State migration triple — positive backfill.** Loading a slot
   JSON containing the legacy fields
   `{ stallDetectedAt, nudgeAttempts, lastNudgeAt }` populates
   `lc.settledNoSignalDetectedAt`, `lc.settledNoSignalNudgeAttempts`,
   `lc.lastSettledNoSignalNudgeAt` to the same values respectively.
4. **State migration triple — negative control.** After load, the
   legacy field names are absent from the in-memory `lc` object
   (`"stallDetectedAt" in lc === false` etc.). A subsequent persist
   round-trip writes only the new field names.
5. **State migration triple — JSON round-trip.** Serializing a
   freshly-migrated lifecycle and parsing it again yields identical
   in-memory shape (no field-name drift, no field loss). Per
   `feedback_state_migration_test_triple`.
6. **Renamed test file passes.** `runner.settled-no-signal.test.ts`
   exists, contains the assertions previously in
   `runner.hung-agents.test.ts` (modulo name changes), and
   `bun test src/orchestration/runner.settled-no-signal.test.ts`
   exits 0. *Falsifier:* the old filename still exists or the new
   file's assertions reference legacy field/event names.

### New: hung-agent detection (substantive-diff)

7. **Lifecycle fields exist and persist.** `AgentTurnLifecycle`
   gains `lastPaneRaw: string | null`, `substantiveStallSince:
   string | null`, `hungDetectedAt: string | null`,
   `hungNudgeAttempts: number`. They round-trip through
   `slot-{n}.json` save/load. *Falsifier:* writing then re-reading
   an active stall loses any of the four fields, or treats a
   persisted `null` as "absent".
8. **`substantiveDiff` is correct on synthetic spinner.** Pure
   function `substantiveDiff(prev: string, curr: string) → { chars:
   number, pct: number }`. Synthetic input — `prev` and `curr`
   share a 1500-char prefix and a 400-char suffix, residual diff is
   `"Working 1m 30s"` vs `"Working 1m 31s"` — returns `chars`
   ≤ 30 *and* `pct < 0.05`. Synthetic input where the new tail
   contains `" • Ran shell `bun run build`"` (60+ residual chars)
   returns `chars > 30`. *Falsifier:* either case crosses the
   wrong side of the threshold.
9. **Tick captures raw pane.** `transport-tmux.ts:
   refreshAgentTransportState` updates `lc.lastPaneRaw` from
   `tmuxCapture(target, 50)` (same window as the existing hash) on
   each tick where pane bytes differ. *Falsifier:* a tick observed
   a hash flip but `lastPaneRaw` was unchanged.
10. **t3code transport is skipped.** With a t3code agent registered,
    `detectAndNudgeHungAgents` does not call `breakAndPrompt`,
    `interruptAgent`, or emit `agent_hung_detected` regardless of
    its lifecycle state. *Falsifier:* a t3code-only run journals
    any `agent_hung_*` event.
11. **Settled-no-signal layer takes priority.** If
    `lc.settledNoSignalDetectedAt` is set, the hung detector emits
    no event for that agent in the same tick — a single mocked
    spinner-stalled t3code-tmux pair owned by settled-no-signal
    yields zero `agent_hung_detected` events over the test window.
    *Falsifier:* both layers fire on the same agent in the same
    tick.
12. **Sustained-spinner triggers detection at exactly the boundary.**
    Test harness drives `tmuxCapture` to return spinner-only diffs
    (≤30 chars, <5% per tick) for simulated 1199 s — no
    `agent_hung_detected` event fires. At simulated 1201 s exactly
    one `agent_hung_detected` event fires for that agent.
    *Falsifier:* fires before the threshold or fails to fire after
    it.

### Recovery: interrupt-then-prompt

13. **Transport interface has `breakAndPrompt`.**
    `OrchestrationTransport` declares `breakAndPrompt?(state, agent,
    message): Promise<void>`. Tmux implementation: exactly one
    `tmuxSendKeys(target, "C-c")` followed by 2 s sleep followed
    by `sendTurn(state, agent, message)`. *Falsifier:* the tmux
    implementation issues two C-c keystrokes for any input, or
    skips the sleep, or omits the prompt send.
14. **Detection #1 invokes `breakAndPrompt` with composed prompt.**
    First detection emits `agent_hung_detected` (payload includes
    `slot`, `agent`, `stallSeconds`, `diffCharsAccumulated`,
    `paneSnapshot`); calls `transport.breakAndPrompt(state, agent,
    composeSkillMessage(state, agent))`; sets `lc.hungDetectedAt =
    now`, `lc.hungNudgeAttempts = 1`. *Falsifier:* any of these
    side-effects missing in the matched run.
15. **Cooldown holds.** Within `HUNG_NUDGE_COOLDOWN_S = 180` after
    detection #1, no second detection event fires even if the
    spinner-only diff continues. *Falsifier:* second event fires
    inside the cooldown window.
16. **Detection #2 escalates to force-settle.** After cooldown
    expires with continued under-threshold churn, exactly one
    `agent_hung_force_settle` event fires and `interruptAgent` is
    invoked once; `lc.hungNudgeAttempts` becomes 2. No third
    detection or recovery is attempted afterward.
17. **Recovery clears state on substantive diff.** Following a
    detection-#1, if the next tick produces a substantive diff
    (chars > 30), `lc.hungDetectedAt`, `lc.substantiveStallSince`,
    and `lc.hungNudgeAttempts` are all cleared (set to null / 0).
    *Falsifier:* any of those three fields retains its non-null
    value after the substantive-diff tick.

### Glue

18. **Config schema documented.**
    `templates/config.reference.yaml` adds, under
    `mag.orchestration.substantive_stall:`, the keys
    `threshold_seconds: 1200`, `min_chars: 30`, `min_pct: 0.05`,
    `nudge_cooldown_seconds: 180`, `max_nudge_attempts: 2`. Each
    has an explanatory comment. *Falsifier:* a key has no comment
    or its default does not match the constants in `runner.ts`.
19. **Vocabulary doc exists.**
    `docs/orchestration-stall-detection.md` exists; renders without
    broken links; covers (a) the settled-vs-hung vocabulary split,
    (b) the two subsystems and their distinct signals, (c) the
    recovery progressions, (d) the threshold table.
    `docs/orchestration-patterns.md` cross-references it in at
    least one location. *Falsifier:* either doc is missing or
    references the legacy `Hung*` names as the active layer.
20. **Health-check surfaces hung detections.** The health-check
    skill's output (string surface accessible via the skill's main
    entry) includes a warning when one or more
    `agent_hung_detected` events appear in `events.jsonl` since the
    last skill invocation. *Falsifier:* the skill silently ignores
    such events.
21. **Incident files persist with FIFO cap.** Each
    `agent_hung_detected` event writes a file matching
    `mag/hung-incidents/<ISO>-slot<N>-<agent>.json` containing the
    event payload, the lifecycle snapshot at detection
    (`phase`, `round`, `stallSeconds`, `diffCharsAccumulated`,
    `paneSnapshot`), and the prompt sent by `breakAndPrompt`.
    After the 51st detection, the directory contains at most 50
    files (oldest pruned by FIFO). *Falsifier:* file is missing,
    payload omits any required field, or directory grows past 50.

### Tests

22. **Test coverage hits each shape.** The new
    `runner.hung-agents.test.ts` (different target from the renamed
    file) contains at minimum:
    - Unit `substantiveDiff` — spinner-only and tool-call cases
      (AC 8).
    - Sustained-spinner integration — single detection event
      (AC 12).
    - Post-`breakAndPrompt` substantive-diff clears state (AC 17).
    - Post-`breakAndPrompt` continued spinner crosses cooldown →
      force-settle (AC 16).
    - Settled-no-signal-first → hung skipped (AC 11).
    - State migration triple (ACs 3-5) lives in
      `runner.settled-no-signal.test.ts` (renamed file) or a
      dedicated state-test.

## Context

**Vocabulary clarification (load-bearing).**

- *Settled* = agent is ready to process the next prompt. A static
  pane (no spinner, no churn) is the strongest signal. Pasted input
  reaches the read loop.
- *Hung* = agent is alive but *not* ready for input. The spinner
  animates; pane bytes change every tick but no substantive progress
  occurs. Pasted input does not reach the read loop.

These two failure modes share none of: detection signal, recovery
shape, or threshold scale. They have been conflated in code under one
detector named `detectAndNudgeHungAgents`. The current detector's
recovery (Enter / "Continue." / re-dispatch / "stop") works *because*
the agent it actually catches is settled, not hung. This proposal
puts the truthful name on the existing layer and adds the missing one.

**Relationship to settled-no-signal layer.** The renamed
`detectAndNudgeSettledNoSignal` keeps its current trigger (pane static
past `SETTLED_NO_SIGNAL_*` thresholds) and its current escalation
ladder. The new hung detector runs alongside it; the two layers
coordinate only through a single skip rule: when
`lc.settledNoSignalDetectedAt` is set, hung evaluation no-ops for
that agent in that tick. Both layers maintain independent attempts
counters and incident state.

**Pairing with task-bce80781.** task-bce80781 (PR-comments
redispatch fix) closed the case where a code review posted to the PR
never re-dispatched the coder. This task closes the case where the
re-dispatched coder hangs on the spinner. Together they form the
end-to-end "review posted → coder works again" recovery path.

**Code pointers (verified against `~/ludics` HEAD on 2026-05-03).**
The task file lists exact line numbers; quick-verify landmarks:

- `src/orchestration/runner.ts:551` — existing detector entry; line
  range 540-695 is the current detector. Constants block lives at
  35-63 (with `HUNG_MAX_NUDGE_ATTEMPTS = 3` at line 472).
- `src/orchestration/state.ts:35-77` — `AgentTurnLifecycle`
  fields. JSON validators that double as the migration entry point
  run inside the `if (state.agentStates)` block at lines 370-394
  (the elaboration's "state.ts:376" pointer is approximate to the
  inner `lc.state` validator); the field-rename migration belongs
  in this block, before the validators that key off the new names.
- `src/orchestration/state.ts:249-270` — `defaultOrchestrationConfig`
  (substantive-stall thresholds extend this).
- `src/orchestration/transport-tmux.ts:72-167` — pane-hash refresh
  (72-140) and `interruptAgent` (142-167); `refreshAgentTransportState`
  is at line 72 and `lastPaneRaw` capture lands inside it.
- `src/orchestration/transport.ts:46` — `OrchestrationTransport`
  interface; `interruptAgent` is declared at line 46. New
  `breakAndPrompt?` declaration sits adjacent.
- `templates/config.reference.yaml:102-138` — `mag.orchestration`
  block; `substantive_stall` keys nest under it.

No drift detected from the task file's claims.

## Approach

### Rename map

Apply the table from the task file mechanically:

| Legacy | Renamed |
|---|---|
| `detectAndNudgeHungAgents` | `detectAndNudgeSettledNoSignal` |
| `lc.stallDetectedAt` | `lc.settledNoSignalDetectedAt` |
| `lc.nudgeAttempts` | `lc.settledNoSignalNudgeAttempts` |
| `lc.lastNudgeAt` | `lc.lastSettledNoSignalNudgeAt` |
| `HUNG_RUNNING_THRESHOLD_S` | `SETTLED_NO_SIGNAL_RUNNING_THRESHOLD_S` |
| `HUNG_DISPATCH_THRESHOLD_S` | `SETTLED_NO_SIGNAL_DISPATCH_THRESHOLD_S` |
| `HUNG_IDLE_RUNNING_THRESHOLD_S` | `SETTLED_NO_SIGNAL_IDLE_RUNNING_THRESHOLD_S` |
| `HUNG_NUDGE_COOLDOWN_S` | `SETTLED_NO_SIGNAL_NUDGE_COOLDOWN_S` |
| `HUNG_MAX_NUDGE_ATTEMPTS` | `SETTLED_NO_SIGNAL_MAX_NUDGE_ATTEMPTS` |
| event `orchestration_hung_detected` | `orchestration_settled_no_signal_detected` |
| event `orchestration_nudge_sent` | `orchestration_settled_no_signal_nudge_sent` |
| event `orchestration_hung_force_settle` | `orchestration_settled_no_signal_force_settle` |
| event `orchestration_nudge_failed` | `orchestration_settled_no_signal_nudge_failed` |
| test `runner.hung-agents.test.ts` | `runner.settled-no-signal.test.ts` |

The new test file `runner.hung-agents.test.ts` (same name, different
target) covers the new detector — handle this by `git mv` followed
by a fresh write. Existing values for the renamed thresholds are
preserved; only the names change.

### State migration (one-pass read-forward)

Inside the `if (state.agentStates)` block in `state.ts:370-394`,
before the lifecycle-state validators, apply:

```ts
if ("stallDetectedAt" in lc) {
  lc.settledNoSignalDetectedAt = lc.stallDetectedAt as string | null;
  delete (lc as any).stallDetectedAt;
}
// likewise nudgeAttempts → settledNoSignalNudgeAttempts
// likewise lastNudgeAt → lastSettledNoSignalNudgeAt
```

No fallback dual-read at write time — once migrated, slot JSON only
ever carries the new names. A follow-up PR (filed at merge time)
removes the migration shim once controllers are confirmed upgraded.

### New lifecycle fields

Append to `AgentTurnLifecycle`:

```ts
/** Raw 50-line pane capture from the previous tick (~2KB). */
lastPaneRaw?: string | null;
/** ISO timestamp when the first under-threshold diff started a stall run. */
substantiveStallSince?: string | null;
/** ISO timestamp when hung detection fired. */
hungDetectedAt?: string | null;
/** Number of breakAndPrompt + force-settle attempts in this stall episode. */
hungNudgeAttempts?: number;
```

All four fields reset to `null`/`0` on phase transition (alongside
existing turn-scoped fields).

### `substantiveDiff` shape

Pure function in `runner.ts` (or sibling util):

```ts
export function substantiveDiff(prev: string, curr: string): {
  chars: number;
  pct: number;
} {
  let p = 0;
  const minLen = Math.min(prev.length, curr.length);
  while (p < minLen && prev[p] === curr[p]) p++;
  let s = 0;
  while (
    s < minLen - p &&
    prev[prev.length - 1 - s] === curr[curr.length - 1 - s]
  ) s++;
  const residualPrev = Math.max(0, prev.length - p - s);
  const residualCurr = Math.max(0, curr.length - p - s);
  const chars = Math.max(residualPrev, residualCurr);
  const denom = Math.max(prev.length, curr.length, 1);
  return { chars, pct: chars / denom };
}
```

Tick logic in `refreshAgentTransportState`, after the existing
pane-hash update:

1. If `lc.lastPaneRaw == null`: capture, exit.
2. Compute `substantiveDiff(lc.lastPaneRaw, currRaw)`.
3. If `chars > SUBSTANTIVE_MIN_CHARS || pct > SUBSTANTIVE_MIN_PCT`:
   substantive — clear `substantiveStallSince`, update
   `lastPaneRaw`, exit.
4. Else: set `substantiveStallSince` if null; update
   `lastPaneRaw` to current (so a slow genuine diff doesn't accrue
   below threshold tick-by-tick forever).
5. Hung evaluation in `detectAndNudgeHungAgents` checks
   `now - substantiveStallSince > SUBSTANTIVE_STALL_THRESHOLD_S`.

### `breakAndPrompt` shape

```ts
// transport-tmux.ts
async breakAndPrompt(
  state: OrchestrationState,
  agent: AgentConfig,
  message: string,
): Promise<void> {
  const target = tmuxSessionName(state.slot, agent.name, state.taskId);
  tmuxSendKeys(target, "C-c");
  await Bun.sleep(2000);
  await this.sendTurn(state, agent, message);
}
```

t3code transport: do not implement (or implement as a thrown
"unsupported"). Detector skip rule keeps it from being invoked.

### Threshold table

Added in the same constants block as the renamed
`SETTLED_NO_SIGNAL_*`:

| Constant | Default | Rationale |
|---|---|---|
| `SUBSTANTIVE_MIN_CHARS` | `30` | codex spinner is ~8-12 chars/sec; 30 absorbs jitter, rejects spinner-only diff |
| `SUBSTANTIVE_MIN_PCT` | `0.05` | belt-and-suspenders for short panes |
| `SUBSTANTIVE_STALL_THRESHOLD_S` | `1200` | 20 min absorbs long tool calls (background tests, network fetches) without admitting genuine 1h+ stalls |
| `HUNG_NUDGE_COOLDOWN_S` | `180` | give C-c+prompt time to land before re-detect |
| `HUNG_MAX_NUDGE_ATTEMPTS` | `2` | one breakAndPrompt; one force-settle |

These coexist with the legacy `HUNG_NUDGE_COOLDOWN_S = 90` (which
becomes `SETTLED_NO_SIGNAL_NUDGE_COOLDOWN_S = 90` post-rename) and
`HUNG_MAX_NUDGE_ATTEMPTS = 3` (becomes
`SETTLED_NO_SIGNAL_MAX_NUDGE_ATTEMPTS = 3`). The hung-detector
constants must use distinct identifiers — same prefix would shadow
the rename.

### Recovery progression

```text
substantive-stall observed for SUBSTANTIVE_STALL_THRESHOLD_S
  → emit agent_hung_detected (incident captured)
  → transport.breakAndPrompt(agent, composeSkillMessage(state, agent))
  → lc.hungDetectedAt = now; lc.hungNudgeAttempts = 1
  → cooldown HUNG_NUDGE_COOLDOWN_S
    ├── substantive diff observed → clear hungDetectedAt,
    │   substantiveStallSince, hungNudgeAttempts
    └── still under-threshold past cooldown →
        emit agent_hung_force_settle
        → transport.interruptAgent(agent)
        → no further hung-recovery (phase-recovery owns the rest)
```

### Incident-capture file format

Path: `mag/hung-incidents/<ISO>-slot<N>-<agent>.json` (ISO is the
detection's `now`, colon-safe — use `Z`-suffixed ISO with `:`
replaced by `-` to match Mac-friendly filenames). Payload:

```json
{
  "detectedAt": "<ISO>",
  "slot": <N>,
  "agent": "<name>",
  "phase": "<phase>",
  "round": <number>,
  "stallSeconds": <number>,
  "diffCharsAccumulated": <number>,
  "paneSnapshot": "<50-line capture string>",
  "promptSent": "<output of composeSkillMessage>"
}
```

FIFO prune to 50 newest files at write time
(`Array.prototype.sort` by filename — ISO sorts lexicographically;
older files unlinked). Directory created lazily on first write.

### Documentation

`docs/orchestration-stall-detection.md` (new): vocabulary section,
two-subsystems-side-by-side section, threshold tables, escalation
flowcharts. `docs/orchestration-patterns.md` gains a one-line
cross-link from its existing stall section.

## Out of scope

- Tmux phase tracking parity (`agents[].phase` is null for
  codex/tmux) — separate task.
- Replacing codex's spinner upstream — not in our control.
- Per-agent custom thresholds — global defaults only on this PR;
  revisit if per-agent tuning becomes necessary.
- A graceful "wrap up" polite-message recovery — the polite-message
  doesn't reach a hung agent's read loop, so it's not the right
  recovery shape; superseded by interrupt-then-prompt.
- Removal of the state-migration shim — filed as a follow-up PR
  once controllers are confirmed upgraded (per resolved Q1).
- T3code transport hung detection — server turn-state is
  authoritative there, so the substantive-diff layer adds no signal.
