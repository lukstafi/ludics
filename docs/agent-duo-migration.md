# Migration Plan: agent-duo → Ludics + t3code

## Overview

Discontinue agent-duo as a standalone Bash project. Fold its orchestration logic into
Ludics (TypeScript/Bun) and replace tmux+ttyd with t3code as the agent UI and runtime layer.

### Architecture Before

```
Ludics (slot mgmt, Mag, flow)
  └─→ agent-duo adapter (shells out to agent-duo CLI)
        └─→ agent-duo (5836L Bash orchestrator)
              ├─→ tmux sessions + ttyd web terminals
              ├─→ .peer-sync/ (file-based coordination)
              └─→ Claude / Codex (agent processes)
```

### Architecture After

```
Ludics (slot mgmt, flow, orchestration engine — purely algorithmic)
  ├─→ t3code adapter (WebSocket JSON-RPC)
  │     └─→ t3code server (UI, agent runtime, terminal, diffs)
  │           └─→ Codex / Claude Code (agent processes)
  ├─→ .peer-sync/ (agent-facing observation, Ludics writes, agents read)
  └─→ Mag (persistent Claude Code session, tmux+ttyd — unchanged)
        ├─→ Optional: tailors skill messages per agent context
        ├─→ Strategic coordination, queue processing, feedback digest
        └─→ NOT in the orchestration loop — reads events, doesn't drive phases
```

### What Gets Dropped

- agent-duo, agent-pair, agent-launch, agent-lib.sh (all Bash)
- tmux+ttyd as *worker agent* UI (replaced by t3code)
  - Mag keeps tmux+ttyd — it's a persistent strategic session, not a turn-based worker
- The `createOrchestratedAdapter()` factory and agent-duo/agent-pair adapters

### What Gets Preserved

- Phase state machine (clarify → pushback → plan → work → review → merge)
- Peer review loop with round tracking
- Merge voting / debate / cherry-pick / amend cycle
- `.peer-sync/` as agent-facing observation channel
- Skill templates (as input to Mag, not as final artifacts)
- Learning capture (AGENTS_STAGING.md, workflow feedback)
- Feedback digest pipeline (already in Ludics)
- Git worktree management for agent isolation
- Forced per-round commits (diffs via git, not explicit patches)

### Temporary Regression

t3code does not yet support Claude Code — only Codex. Until t3code ships Claude Code
support, duo workflows will be Codex-only (or Codex + Codex with different models).
Single-agent Claude Code workflows can continue using the existing `agent-claude` adapter
with tmux until t3code catches up.

---

## Phase 0: Preparation (No Code Changes)

### 0.1 — Stabilize current agent-duo

- Release final agent-duo version with recent changes
- Announce migration/discontinuation in agent-duo README
- Document which agent-duo features are being ported vs dropped

### 0.2 — Understand t3code's WebSocket protocol

- Map out the full request/response cycle for:
  - Starting a session (`ProviderStartSessionCommand`)
  - Sending a turn (`sendTurn` with message content)
  - Receiving turn completion events
  - Interrupting a turn
  - Stopping a session
- Identify how to set workspace path per thread (agent worktree)
- Test manually: spawn `t3 serve`, connect via WebSocket, drive a Codex session

### 0.3 — Define the Ludics orchestration module interface

Sketch the TypeScript types for the phase state machine before writing code.

---

## Phase 1: t3code Adapter (New Adapter Type)

### 1.0 — Singleton t3code server model

t3code assumes one server per client. Ludics manages a **single shared t3code server**
that all slots use. Threads within that server map to individual agent sessions.

```
Ludics
  └─→ single t3code server (long-running singleton)
        ├─→ Thread: slot-1-claude (workspace: ~/project-feat-claude/)
        ├─→ Thread: slot-1-codex  (workspace: ~/project-feat-codex/)
        ├─→ Thread: slot-2-codex  (workspace: ~/other-project/)
        └─→ ...
```

**Server lifecycle is separate from slot lifecycle:**
- Server starts on first slot assignment that needs t3code (or at Ludics startup)
- Server stays running across slot assign/clear cycles
- Server stops only on explicit `ludics t3code stop` or Ludics shutdown
- PID, port, and auth token stored in `harness/t3code/server.json`

### 1.1 — `src/t3code/server.ts` — Server lifecycle manager

**New files:**
- `src/t3code/server.ts` — singleton server management

**Responsibilities:**
- `ensureServer()`: Start t3code if not running, return connection info
- `stopServer()`: Graceful shutdown (SIGTERM → wait → SIGKILL)
- `serverStatus()`: Check if alive (PID + port probe)
- PID/port persistence in harness dir

**No `createServerAdapter()` factory needed** — t3code is the only server-style
integration, and the singleton model is specific to it. Keep it simple.

### 1.2 — `src/adapters/t3code.ts`

**Responsibilities:**
- `start()`: Call `ensureServer()`, create a t3code thread for this slot's workspace,
  store thread ID in slot state
- `readState()`: Query the shared server via WebSocket for this slot's threads,
  format as Markdown
- `stop()`: Stop/remove this slot's threads (do NOT stop the server)
- `lastActivity()`: Query thread activity via WebSocket or check `.peer-sync/` mtimes

**Key decisions:**
- Adapter does not own the server — just ensures it's running and manages threads
- Thread IDs stored per-slot in `harness/t3code/slot-<N>.json`
- Multiple threads per slot (e.g., 2 for duo mode)
- The shared server's WebSocket URL comes from `harness/t3code/server.json`

### 1.3 — Register the adapter

- Add to `src/adapters/index.ts` as `"t3code"`
- Initially supports single-agent workflows (one thread per slot)

**Milestone:** `ludics slot assign 1 my-task t3code` ensures the t3code server is
running, creates a thread, shows status. `ludics slot clear 1` removes the thread
but the server keeps running for other slots.

---

## Phase 2: WebSocket Client for t3code

### 2.1 — `src/t3code/client.ts`

A lightweight WebSocket JSON-RPC client for communicating with t3code.

**Capabilities:**
- Connect with optional auth token
- Send commands: `orchestration.dispatchCommand`, `orchestration.getSnapshot`
- Subscribe to push events: `orchestration.domainEvent`
- Reconnect on disconnect
- Clean shutdown

**No external dependencies** — use Bun's native WebSocket.

### 2.2 — `src/t3code/types.ts`

Minimal type definitions for the t3code protocol subset Ludics needs:
- Thread/session/turn IDs
- Snapshot shape (threads, sessions, turns, messages)
- Command types (createThread, sendMessage, startSession, stopSession)
- Push event types (turnCompleted, messageSent, approvalRequested)

**Do not import from t3code's `@t3tools/contracts`** — maintain our own minimal subset
to avoid coupling to their Effect-TS type system.

**Milestone:** Ludics can programmatically create a thread, send a message, and receive
the turn completion event.

---

## Phase 3: Orchestration Engine

Port agent-duo's phase state machine into Ludics as a TypeScript module.

### 3.1 — `src/orchestration/phases.ts`

The phase state machine:

```typescript
type Phase =
  | "gather"       // pair-only: reviewer collects context
  | "clarify"      // agents propose approaches
  | "pushback"     // agents suggest task improvements
  | "plan"         // agents write implementation plans
  | "plan-review"  // peer reviews plans
  | "work"         // agents implement (parallel)
  | "review"       // agents review peer work (parallel)
  | "update-docs"  // learning capture
  | "pr-create"    // agents create PRs
  | "pr-comments"  // monitor and address PR feedback
  | "merge-vote"   // agents analyze both PRs
  | "merge-debate" // if votes disagree
  | "merge-execute"// losing agent cherry-picks into winner
  | "merge-review" // winning agent reviews cherry-picks
  | "merge-amend"  // address merge review feedback
  | "final-merge"  // rebase, test, merge to main
  | "done";

interface PhaseTransition {
  from: Phase;
  to: Phase;
  condition: (state: OrchestrationState) => boolean;
}
```

The state machine is driven by Ludics polling agent status (from t3code events and
`.peer-sync/` files) and deciding transitions.

### 3.2 — `src/orchestration/state.ts`

Orchestration state per slot:

```typescript
interface OrchestrationState {
  slotId: number;
  feature: string;
  mode: "duo" | "pair";
  phase: Phase;
  round: number;
  agents: AgentState[];
  config: OrchestrationConfig;  // timeouts, flags, etc.
}

interface AgentState {
  name: string;                  // "claude", "codex", "codex-2"
  threadId: string;              // t3code thread ID
  worktreePath: string;
  branch: string;
  status: string;                // from .peer-sync/<agent>.status
  statusEpoch: number;
  prUrl: string | null;
}
```

State is persisted to the Ludics harness dir (e.g., `harness/orchestration/slot-1.json`)
and emitted to `events.jsonl` on every transition.

### 3.3 — `src/orchestration/runner.ts`

The orchestration loop, equivalent to agent-duo's main `while true` loop:

```typescript
async function runOrchestration(state: OrchestrationState): Promise<void> {
  while (state.phase !== "done") {
    // 1. Execute phase entry: write .peer-sync/, send skill messages via t3code
    await enterPhase(state);

    // 2. Wait for agents to complete (poll t3code events + .peer-sync/ status)
    await waitForAgents(state);

    // 3. Evaluate transition conditions
    const next = evaluateTransition(state);
    if (next) {
      emitEvent({ event_type: "phase_transition", ... });
      state.phase = next;
      persistState(state);
    }
  }
}
```

### 3.4 — `src/orchestration/skills.ts`

Skill message composition:

```typescript
interface SkillContext {
  phase: Phase;
  round: number;
  agent: AgentState;
  peer: AgentState | null;
  peerReview: string | null;     // previous round's review
  peerStatus: string | null;
  gitDiffStat: string | null;    // git diff --stat main...HEAD
  taskSpec: string;
}

/** Load skill template, optionally have Mag tailor it. */
async function composeSkillMessage(
  template: string,
  context: SkillContext,
  useMag: boolean,
): Promise<string> {
  const base = substituteTemplate(template, context);
  if (!useMag) return base;
  return await magTailorSkill(base, context);
}
```

Skill templates stay as Markdown files under `skills/` (ported from agent-duo).
Mag tailoring is optional — can be enabled per-slot or per-phase.

### 3.5 — `src/orchestration/worktrees.ts`

Git worktree management (ported from agent-duo):

- `createAgentWorktrees(projectDir, feature, agents)` — create branches + worktrees
- `symlinkPeerSync(worktreePath, peerSyncDir)` — set up `.peer-sync/` symlinks
- `cleanupWorktrees(projectDir, feature)` — remove worktrees on completion

### 3.6 — `src/orchestration/merge.ts`

Merge phase logic (voting, debate, cherry-pick):

- `conductMergeVote(state)` — send voting skill, collect votes
- `conductMergeDebate(state, round)` — send debate skill, collect revised votes
- `executeMerge(state, winner, loser)` — cherry-pick, review, amend loop

**Milestone:** Ludics can run a full duo workflow: create worktrees, start t3code threads,
cycle through work→review→work, create PRs, run merge vote.

---

## Phase 4: Integrate with Existing Ludics Systems

### 4.1 — Slot integration

- `ludics slot assign 1 my-task duo` triggers the full orchestration setup:
  worktrees, t3code server, threads, phase machine
- `ludics slot show 1` shows orchestration status (phase, round, agent statuses)
- `ludics slot clear 1` gracefully stops orchestration, cleans up worktrees

### 4.2 — Mag integration

**Design decision: Mag's role in orchestration is limited and optional.**

The orchestration engine is purely algorithmic — phase transitions, timeouts, polling,
round management all happen without LLM involvement (same as agent-duo today). Mag is
NOT in the orchestration loop.

Mag's involvement is confined to two optional roles:

1. **Skill message tailoring** (opt-in per slot or per phase): Mag takes a skill
   template + context and produces a more focused prompt for the specific agent/situation.
   Fallback: static template substitution (always works, no Mag dependency).

2. **Strategic decisions on escalation** (future, opt-in): When orchestration would
   normally escalate to the human (merge tie after debate, ambiguous task spec), Mag
   could handle it instead. But the default is human escalation, same as agent-duo.

Non-Mag interactions (unchanged):
- Mag can initiate duo/pair workflows via slot assignment (existing capability)
- Feedback digest pipeline continues unchanged
- Mag reads orchestration events from `events.jsonl` for situational awareness

### 4.3 — Flow integration

- Orchestration phase maps to flow status (work phase = in-progress, review = in-review)
- Flow engine can factor in orchestration round count for priority decisions
- Learning capture feeds back into task metadata

### 4.4 — Dashboard integration

- Dashboard shows orchestration state per slot
- Links to t3code web UI for each agent thread
- Phase timeline visualization

### 4.5 — CLI commands

New subcommands under `ludics orchestration` (or `ludics orch`):

```
ludics orch status <slot>        # Show phase, round, agent status
ludics orch confirm <slot>       # Approve clarify/pushback phase (like agent-duo confirm)
ludics orch interrupt <slot>     # Interrupt current phase
ludics orch skip <slot> <phase>  # Skip to next phase
ludics orch log <slot>           # Show phase transition history
```

---

## Phase 5: Migration Cleanup

### 5.1 — Remove old adapters

- Remove `src/adapters/agent-duo.ts`
- Remove `src/adapters/agent-pair-claude.ts`
- Remove `src/adapters/agent-pair-codex.ts`
- Remove `src/adapters/orchestrated-adapter.ts`
- Remove related peer-sync reading code that's been superseded

### 5.2 — Port skill templates

- Copy agent-duo's `skills/templates/` to Ludics' `skills/`
- Adapt template placeholders (no more `{{PEER_SYNC}}` shell vars — use
  structured context injection instead)
- Remove Codex-specific skill installation (`.codex/skills/` layout) — t3code
  handles skill delivery via turn messages

### 5.3 — Port tests

- Convert agent-duo's `tests/unit.t` assertions into TypeScript tests
- Focus on phase transition logic, worktree management, skill composition
- Integration tests against a mock t3code WebSocket server

### 5.4 — Update documentation

- Update `docs/ARCHITECTURE.md` with orchestration engine section
- Update adapter catalog
- Remove references to agent-duo CLI
- Add t3code integration guide

---

## Phasing / Priority

| Phase | Effort | Depends On | Unlocks |
|-------|--------|------------|---------|
| 0 — Preparation | Low | Nothing | Everything |
| 1 — t3code adapter | Medium | Phase 0 | Single-agent t3code workflows |
| 2 — WebSocket client | Medium | Phase 0 | Programmatic t3code control |
| 3 — Orchestration engine | High | Phases 1+2 | Full duo/pair workflows |
| 4 — System integration | Medium | Phase 3 | Production-ready |
| 5 — Cleanup | Low | Phase 4 | Clean codebase |

Phases 1 and 2 can be developed in parallel. Phase 3 is the bulk of the work.

---

## Risk Mitigation

**t3code Claude Code support delay:**
Keep the existing `agent-claude` adapter (tmux-based) as a fallback. Ludics can run
mixed workflows: orchestration engine manages phases, but launches Claude via tmux
instead of t3code until Claude Code support ships.

**t3code API instability:**
Maintain our own minimal type definitions (`src/t3code/types.ts`). Don't import
from `@t3tools/contracts`. If their protocol changes, we update one file.

**Gradual rollout:**
The old agent-duo adapters can coexist with the new t3code adapter during migration.
Users can choose which mode to use per slot. Remove old adapters only after the new
path is proven.

---

## Design Decisions (Resolved)

1. **Thread-to-project mapping:** `T3ThreadCreateCommand` has a `worktreePath` field —
   each thread can point to a different workspace directory. Mapping: one t3code project
   per feature (the main repo), with multiple threads per project pointing to different
   agent worktrees. `T3ProjectCreateCommand.workspaceRoot` is the main repo path.

2. **Agent signaling:** Keep `.peer-sync/<agent>.status` file writes (current pattern).
   Codex has shell access inside t3code, so skill templates instruct the agent to write
   status files. t3code turn completion events serve as a secondary signal. See Phase 3
   proposal for details.

3. **Approval routing:** Start simple — `full-access` runtime mode for all phases.
   Phase-specific sandbox modes (e.g., stricter during review) are a future optimization
   once the basic orchestration loop is proven. The `runtimeMode` parameter is already
   per-turn in `T3ThreadTurnStartCommand`, so tightening later is straightforward.

4. **Headless mode:** t3code server is HTTP + WebSocket. Ludics only uses the WebSocket
   API — no browser required. The web UI is optional; humans can open it for observation
   but the orchestration engine never needs it. Confirmed working for CI/SSH environments.

5. **Pair mode threads:** Two threads per slot, one per agent, even when backed by the
   same model. Role switching (coder ↔ reviewer) is via different skill messages per
   phase, not thread reuse. See Phase 3 proposal §3.3 for details.
