# Orchestration Phase Transitions — Ground Truth

This document captures the authoritative behavior of the t3code snapshot API,
the turn lifecycle, and the signal-precedence model used by the Ludics
orchestration runner to decide when a phase is complete.

## 1. Snapshot Field Semantics

The orchestration runner polls `orchestration.getSnapshot()` which returns an
`OrchestrationReadModel` containing threads.  Each thread exposes three
lifecycle-critical fields:

| Field | Type | Updated when |
|-------|------|--------------|
| `thread.latestTurn` | `OrchestrationLatestTurn \| null` | Session enters "running" (latestTurn set to running state), or turn-diff-completed event arrives (latestTurn set to completed state) |
| `thread.session.status` | `OrchestrationSessionStatus` | Provider status changes: `"idle"` → `"starting"` → `"running"` → `"ready"` (also `"error"`, `"interrupted"`, `"stopped"`) |
| `thread.session.activeTurnId` | `TurnId \| null` | Set when provider adapter calls `sendTurn()` (generates UUID turn ID); cleared when session returns to ready/error/stopped |

### State table

| Lifecycle point | `session.status` | `session.activeTurnId` | `latestTurn.state` | `latestTurn.turnId` |
|----------------|-------------------|------------------------|--------------------|---------------------|
| Before any turn | `"ready"` / `"idle"` | `null` | `null` (no turn) | — |
| After `thread.turn.start` accepted, before provider starts | `"starting"` or still `"ready"` | `null` (not yet set) | Previous turn's state | Previous turnId |
| Provider running turn | `"running"` | Current turnId | `"running"` | Current turnId |
| Turn just completed | `"ready"` | `null` | `"completed"` | Completed turnId |
| Turn errored | `"error"` | `null` | `"error"` | Failed turnId |
| Turn interrupted | `"interrupted"` or `"ready"` | `null` | `"interrupted"` | Interrupted turnId |

### Key insight

`latestTurn` is NOT updated atomically with `session.activeTurnId`.  The
projector updates `latestTurn` in two stages:

1. When `session.status` becomes `"running"` with an `activeTurnId`, the
   projector sets `latestTurn = { turnId: activeTurnId, state: "running", ... }`.
2. When a `thread.turn-diff-completed` event arrives, the projector sets
   `latestTurn = { turnId, state: "completed"|"error"|"interrupted", completedAt, ... }`.

Between stages, `latestTurn` may still show the *previous* turn's completed
state while the new turn is being started.

## 2. Turn Lifecycle Timeline

```
Time →
─────────────────────────────────────────────────────────────────────
Ludics:   thread.turn.start dispatched (commandId generated)
          │
t3code:   Command accepted → event sequence returned
          │  Decider emits: thread.message-sent, thread.turn-start-requested
          │
          ▼ (RACE WINDOW 1: snapshot still shows previous turn)
t3code:   ProviderCommandReactor processes turn-start-requested
          Provider adapter calls sendTurn()
          │  turnId = random UUID generated
          │  session.activeTurnId = turnId
          │  session.status = "running"
          │  Emits: thread.session.set (domainEvent broadcast)
          │
          ▼ (latestTurn now shows { turnId, state: "running" })
Agent:    Working on the turn...
          │  Activities emitted: tool.started, tool.updated, tool.completed, ...
          │
          ▼
Agent:    Turn finishes
          Provider emits: turn.completed
          │  session.activeTurnId = null
          │  session.status = "ready"
          │  Emits: thread.session.set
          │
          ▼ (RACE WINDOW 2: turn settled, peer-sync not yet written)
t3code:   CheckpointReactor processes completion
          Emits: thread.turn-diff-completed
          │  latestTurn = { turnId, state: "completed", completedAt }
          │
          ▼
Agent:    Stop hook fires (push signal)
          │  Writes .peer-sync status file
          │
Ludics:   Next poll sees settled turn + peer-sync status
```

### Concrete example

```
T+0.0s  Ludics dispatches thread.turn.start (commandId: cmd-abc)
T+0.1s  t3code accepts command, returns { sequence: 42 }
T+0.5s  Snapshot poll: latestTurn still shows PREVIOUS turn (completedAt: T-60s)
        session.status: "starting", activeTurnId: null
        → DANGER: old isTurnFresh() would see stale completedAt as "fresh"
T+1.2s  Provider starts, session.activeTurnId = "turn-xyz"
        session.status = "running"
T+1.5s  Snapshot poll: latestTurn = { turnId: "turn-xyz", state: "running" }
        session.status: "running", activeTurnId: "turn-xyz"
T+45.0s Agent finishes work
T+45.1s session.status = "ready", activeTurnId = null
T+45.3s latestTurn = { turnId: "turn-xyz", state: "completed", completedAt: T+45.1s }
T+45.5s Stop hook fires, agent writes .peer-sync/coder.status
T+46.0s Snapshot poll: all signals converge
```

## 3. Race Windows

### Race Window 1: Dispatch-to-Start Gap

**Duration**: Typically 0.1–2 seconds.

After `thread.turn.start` is dispatched but before the provider starts:
- `session.status` may still be `"ready"` or `"starting"`
- `session.activeTurnId` is still `null`
- `latestTurn` still shows the previous turn (possibly with `state: "completed"`)

**Why this causes premature transitions**: The old `isTurnFresh()` compares
`latestTurn.completedAt >= phaseDispatchedAt`.  If the previous turn completed
very recently (same second as dispatch), the stale completion appears "fresh."

**Solution**: Track the dispatched turn by binding to the first
`session.activeTurnId` observed after dispatch.  Never trust `latestTurn` alone.

### Race Window 2: Completion-to-Status Gap

**Duration**: Typically 0–5 seconds.

After the turn settles (`session.status = "ready"`, `activeTurnId = null`) but
before the agent writes its `.peer-sync` status file:
- Snapshot correctly shows the turn as completed
- `.peer-sync/agent.status` still shows the previous phase's status or "idle"

**Solution**: After observing a settled turn, allow a grace period (30s) for
the agent to write its status.  If no update, treat as done with a warning.

### Race Window 3: Phase Boundary

When the orchestration runner transitions to a new phase:
- The runner writes new phase/round to `.peer-sync`
- The runner dispatches new turns
- But a stop hook from the *previous* phase may still be in flight

**Solution**: Scope stop hooks with the phase token written to `.peer-sync/phase-token`.
Ignore any hook whose phase token doesn't match.

## 4. Available t3code API Endpoints

### WebSocket RPC Methods

| Method | Purpose | Returns |
|--------|---------|---------|
| `orchestration.getSnapshot` | Full read model (projects, threads, sessions) | `OrchestrationReadModel` |
| `orchestration.dispatchCommand` | Execute a command (turn start, thread create, etc.) | `{ sequence, eventId }` — **NOT** turnId |
| `orchestration.getTurnDiff` | Checkpoint diff for a specific turn | Diff data |
| `orchestration.getFullThreadDiff` | All diffs for a thread | Diff data |
| `orchestration.replayEvents` | Replay domain events from a sequence | Event stream |

### Push Channel

| Channel | Events |
|---------|--------|
| `orchestration.domainEvent` | All domain events: `thread.message-sent`, `thread.turn-start-requested`, `thread.session.set`, `thread.turn-diff-completed`, activity events, etc. |

### Known gaps

- **No `thread.turns.list`**: Cannot enumerate historical turns by ID.
- **No turnId from dispatch**: `dispatchCommand(thread.turn.start)` returns only
  `{ sequence, eventId }`.  The turnId is generated by the provider adapter
  asynchronously.  Must observe `session.activeTurnId` from the next snapshot.
- **No explicit turn-completed push**: Turn completion is observable via
  `thread.session.set` (activeTurnId cleared) and `thread.turn-diff-completed`
  domain events on the push channel.

## 5. Signal Roles

Each signal source has exactly one defined role:

| Signal | Role | Authority |
|--------|------|-----------|
| Snapshot `session.status` + `activeTurnId` | "Is the dispatched turn currently running?" | **Primary** — only source that can confirm a turn is active |
| Snapshot `latestTurn` | "Which turn settled and when?" | **Primary** — but only trusted after `activeTurnId` clears |
| Stop hook (`.peer-sync/<agent>.stop.json`) | "Agent process stopped, refresh now" | **Secondary** — triggers immediate refresh, not a phase-advance signal |
| `.peer-sync/<agent>.status` | Domain payload: verdict, PR URL, phase-done marker | **Domain** — never sufficient alone to advance a phase if turn is still running |
| Phase timeout | Failsafe | **Fallback** — interrupts agents and forces transition |

### Precedence rules

1. If tracked turn lifecycle says "running" → agent is NOT done, regardless of
   other signals.
2. If tracked turn lifecycle says "settled" AND `.peer-sync` status is a done
   status → agent IS done.
3. If tracked turn lifecycle says "settled" but `.peer-sync` status is unchanged
   → wait up to 30s grace period, then treat as done with warning.
4. If tracked turn lifecycle says "error" → agent IS done (error is a terminal
   state).
5. Stop hooks wake the poll loop immediately but do not directly advance phases.

## 6. Turn Tracking Model

Instead of comparing timestamps (`isTurnFresh()`), the runner tracks a
per-agent `AgentTurnLifecycle` for each phase:

```
                    ┌──────────┐
                    │dispatched│  turn.start sent, no activeTurnId yet
                    └────┬─────┘
                         │ activeTurnId observed in snapshot
                    ┌────▼─────┐
                    │ running  │  session.status=running, activeTurnId set
                    └────┬─────┘
                         │ activeTurnId cleared, latestTurn.state=completed
                    ┌────▼─────┐
                    │ settled  │  turn is done, awaiting peer-sync payload
                    └────┬─────┘
                         │ peer-sync status updated OR grace period elapsed
                    ┌────▼─────┐
                    │  done    │  (returned by isAgentDone)
                    └──────────┘

Error branch:  running → error (session.status=error)
```

This model eliminates timestamp-based freshness checks entirely.  The identity
of the tracked turn (via `observedTurnId`) provides unambiguous lifecycle
boundaries.
