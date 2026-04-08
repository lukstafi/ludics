# ludics Architecture

*Living document — describes the current implementation.*

## Overview

ludics is a lightweight personal AI infrastructure — a harness for humans working with AI agents. It manages concurrent agent sessions (slots), orchestrates autonomous task analysis (Mag), runs multi-agent coding workflows via t3code or tmux, and maintains flow-based task management.

## Technology Stack

ludics is implemented in **100% TypeScript**, compiled to a standalone binary via Bun:

- **Runtime**: [Bun](https://bun.sh/) (v1.1+) — fast TypeScript runtime with native compilation
- **Build**: `bun build --compile src/index.ts --outfile bin/ludics` → ~60MB standalone binary
- **Dependencies**: Minimal — only `yaml` (npm) for YAML parsing; everything else is stdlib
- **Shell integration**: Shell commands are invoked via `Bun.spawnSync()` / `Bun.spawn()` where needed (tmux, git, gh, curl, etc.)

**Why TypeScript + Bun?**
- Type safety for configuration parsing and adapter interfaces
- Fast startup (Bun's compiled binary is instant)
- Native async/await for shell process orchestration
- Single binary deployment (no runtime dependency for users)
- Module system for clean separation of concerns (~87 modules, ~52K lines)

## Architectural Layers

```
┌────────────────────────────────────────────────────────────┐
│              THE MAG (Autonomous - Lifelong)               │
│         Claude Opus 4.5 in Claude Code (tmux/ttyd)         │
│                                                            │
│  Invoked by automation when AI judgment needed:            │
│  • Analyze GitHub issues → create task files               │
│  • Generate strategic briefings                            │
│  • Detect approaching deadlines                            │
│  • Suggest next tasks based on flow state                  │
│                                                            │
│  Uses native Claude Code capabilities:                     │
│  • Task tool → Haiku/Sonnet subagents for fast tasks       │
│  • CLI tools (jq, tsort) for deterministic operations      │
│  • Skills with embedded delegation patterns                │
│                                                            │
│  Writes decisions to git-backed state (persistent)         │
└────────────┬───────────────────────────────────────────────┘
             │ supervises
             ▼
┌────────────────────────────────────────────────────────────┐
│           AUTOMATION LAYER (Deterministic - Always On)     │
│                                                            │
│  Flow Engine (TypeScript):                                 │
│    • Maintains dependency graph (Kahn's algorithm)         │
│    • Computes ready queue (priority + deadline sorting)    │
│    • Detects deadline violations                           │
│                                                            │
│  Orchestration Engine (TypeScript):                        │
│    • 21-phase state machine for multi-agent workflows      │
│    • Phase transitions, timeouts, skill dispatch           │
│    • Git worktree management per slot/agent                │
│    • Peer-sync coordination channel                        │
│    • Merge voting and consensus                            │
│                                                            │
│  t3code Integration (WebSocket):                           │
│    • Server lifecycle management                           │
│    • Thread creation and command dispatch                  │
│    • Agent session spawning (Claude Code, Codex)           │
│                                                            │
│  Trigger System (launchd / systemd):                       │
│    • 08:00 → invoke Mag for briefing                       │
│    • Periodic → sync, health check                         │
│    • WatchPaths → file changed, sync tasks                 │
│                                                            │
│  Session Discovery (TypeScript pipeline):                  │
│    • Discover → Enrich → Deduplicate → Classify            │
│    • Sources: tmux, ttyd, Claude Code, Codex, .peer-sync/  │
│                                                            │
│  State Sync (git):                                         │
│    • Pull from repos → aggregate issues                    │
│    • Commit Mag's changes                                  │
│    • Push to private repo                                  │
│    • Workers write via HTTP to controller (not git push)   │
│                                                            │
│  Events (JSONL):                                           │
│    • Append-only structured event log                      │
│    • Phase transitions, slot changes, task events          │
│    • Queryable via CLI with filters                        │
│                                                            │
│  Notifications (ntfy.sh):                                  │
│    • <user>-from-Mag: outgoing strategic updates (→ phone) │
│    • <user>-to-Mag: incoming messages (phone → Mag)        │
│    • <user>-agents: Worker task events (operational)        │
│                                                            │
│  Cluster (TypeScript):                                     │
│    • Multi-machine coordination                            │
│    • Static controller role (no election)                  │
│    • Heartbeat publishing via git-backed state             │
│    • HTTP transport for worker → controller writes         │
└────────────┬───────────────────────────────────────────────┘
             │ manages
             ▼
┌────────────────────────────────────────────────────────────┐
│              WORKER SLOTS (Ephemeral AI)                   │
│                     6 slots (default)                      │
│                                                            │
│  Slot 1: t3code --duo on task-042 (coder + reviewer)       │
│  Slot 2: empty                                             │
│  Slot 3: t3code --agent on task-089                         │
│  Slot 4-6: empty                                           │
│                                                            │
│  Workers implement tasks, not strategy                     │
│  Preemption: stash current work for priority tasks         │
│  Orchestration: phase-driven workflows with peer review    │
└────────────────────────────────────────────────────────────┘
```

## Core Concepts

### The Mag: Autonomous Coordinator

The **Mag** is a persistent Claude Code instance running in a dedicated tmux session (`ludics-mag`) with optional ttyd web access (default port 7679). It provides autonomous strategic thinking while the automation layer handles reliable execution.

**What Mag does (Claude Opus 4.5):**
- Analyzes GitHub issues for actionability and dependencies
- Generates morning briefings with strategic suggestions
- Suggests what to work on next based on priority, deadlines, and dependencies
- Elaborates high-level tasks into detailed Markdown specifications
- Publishes curated updates to notification channels
- **Learns from corrections** — updates institutional memory when mistakes are identified
- **Consolidates learnings** — periodically synthesizes scattered corrections into structured knowledge

**What Mag delegates:**

*Via Task tool (native Claude Code subagents):*
- **Haiku**: Fast extraction, parsing, simple validation
- **Sonnet**: Medium-complexity tasks, structured generation

*Via CLI tools (deterministic algorithms):*
- Dependency graph: `tsort` for topological order
- Priority filtering: `jq` for sorting and selection

**Skills system** (`skills/` directory, 23 Markdown files — 15 skills + 5 workers + orchestrator/worker conventions):

| Skill | Purpose | Isolation |
|-------|---------|-----------|
| `/ludics-adopt-sessions` | Adopt discovered sessions into slots | Inline |
| `/ludics-briefing` | Morning strategic briefing | Inline (needs strategic context) |
| `/ludics-draft-proposal` | Write proposal document, evaluate auto-start vs launch buttons | Orchestrator + worker |
| `/ludics-elaborate` | Detailed spec for a task (early, for Mag context) | Orchestrator + worker |
| `/ludics-feedback-digest` | Summarize user feedback | Orchestrator + worker |
| `/ludics-health-check` | Detect approaching deadlines, queue completion checks | Inline |
| `/ludics-learn` | Update institutional memory from corrections | Inline |
| `/ludics-new-quote` | Generate motivational quote | Inline |
| `/ludics-preempt` | Plan task preemption | Inline |
| `/ludics-process-suggestions` | Extract actionable items from REQUEST_CHANGES reviews | Inline |
| `/ludics-revise-proposal` | Revise existing proposal based on feedback | Orchestrator + worker |
| `/ludics-split-task` | Split multi-concern task into subtasks | Inline |
| `/ludics-suggest` | Task suggestions based on flow state | Inline |
| `/ludics-sync-learnings` | Consolidate learnings into structured memory | Direct fork |
| `/ludics-verify-completion` | Deep-inspect task completion, create follow-ups | Orchestrator + worker |

Skills are Markdown files with embedded instructions for Claude Code. Heavy skills use an **orchestrator/worker pattern** for context isolation — see [Skill Context Isolation](#skill-context-isolation) below.

**Elaboration vs. Proposal timing**: Elaborations run as early as possible — immediately when tasks are created or during briefing — so that Mag has detailed specs for dependency analysis, slot assignment, and priority decisions. Proposals are deferred until a task is actually assigned to a slot, giving the proposal the freshest codebase state and cross-task context. Since proposals are the last step before a coding agent starts work, they benefit from a fresh Opus context window with maximum brain power for disambiguating scope, surfacing staleness, and deciding whether to split multi-concern tasks.

**Auto-start decision** (`evaluateAutoStartDecisionPure` in `src/mag.ts`):

When a proposal is ready, ludics evaluates whether to automatically launch a coding session or defer to the user:

1. If `autonomy` config is `manual` or `suggest` → defer to user
2. If worker confidence is not `high` → defer
3. **Safety net**: scan rationale for ambiguity signals (`"ambiguous"`, `"unclear"`, `"open question"`, `"speculative"`, `"uncertain scope"`) → defer despite "high" confidence
4. If no slot available → defer
5. Otherwise → auto-start

Exposed via `ludics auto-start-evaluate <taskId> [high|low] [rationale...]`.

**Deferred launch** (task `status: deferred`):

When auto-start defers to the user, the task gets `status: deferred`. The dashboard shows a Deferred Launch tile with View/Approve/Abandon buttons. On approve: the status transitions to `ready`, and the keepalive picks it up for auto-start. On proposal revision, the status is set back to `deferred` to require re-approval.

**Project health test monitoring** (`src/health.ts`, ~166 lines):

Projects can have an optional `test_command` (auto-detected from build system files). Tests run during night window `[0, 6)` or every 24h. Results stored in `mag/test-health.json`. On test failure, a priority-A fix task is auto-filed with content-fingerprint dedup. CLI: `ludics health run-tests [--project=NAME] [--force]`.

**How automation invokes Mag:**

Automation writes requests to a JSONL queue (`mag/queue.jsonl`). Mag's stop hook fires when Claude finishes a turn, reads the queue, and processes requests:

```
Automation Layer                      Mag (Claude Code)
     │                                      │
     │ 1. Writes request                    │
     ├──────────────────────────────────────>│
     │    to mag/queue.jsonl                │
     │                                      │
     │                                      │ 2. Stop hook fires
     │                                      │    when Claude ready
     │                                      │
     │                                      │ 3. Reads queue
     │ 4. Reads result                      │    Processes requests
     <──────────────────────────────────────┤    Writes to mag/results/
```

The queue module (`src/queue.ts`) handles FIFO request/response:
- `queueRequest()` — append request, return ID
- `queuePop()` — FIFO dequeue
- `writeResult()` — store response to `mag/results/{id}.json`

**Mag lifecycle** (implemented in `src/mag.ts`, ~3.5K lines):
- `magStart()` — create tmux session, optionally wrap with ttyd
- `magStop()` — kill tmux session
- `magAttach()` — connect to tmux session
- `magLogs()` — show recent terminal activity
- `magDoctor()` — health check for Mag setup
- Keepalive/nudge mechanism to keep Mag responsive
- Terminal publishing: captures last 50 tmux lines, deduplicates via hash, publishes to ntfy.sh

### Skill Context Isolation

Mag is a persistent, long-running Claude Code session. Every skill invocation injects the full skill markdown plus all tool outputs into Mag's conversation context. Heavy skills that do deep codebase exploration (reading source files, git logs, grepping across projects) accumulate significant context that pushes out Mag's strategic memory: cross-task awareness, user preferences, prior decisions, and institutional knowledge.

**Solution: Orchestrator/Worker pattern using `context: fork`**

Heavy skills are split into two files each:

- **Orchestrator** (`ludics-<name>.md`) — runs inline in Mag's context. Reads the task file (small, gives Mag awareness), composes a context brief, makes strategic decisions (proceed/bail/split), invokes the worker, interprets the result, handles notifications and result JSON.
- **Worker** (`ludics-<name>-worker.md`) — runs in an isolated subagent via Claude Code's `context: fork` frontmatter. Does the heavy codebase exploration, writes artifacts to disk, returns a structured summary. Hidden from the user's `/` menu via `user-invocable: false`. All workers follow shared conventions in `skills/worker-conventions.md`.

For simpler skills where the orchestrator adds no strategic value, a **direct fork** pattern is used instead: the skill has `context: fork` directly and handles everything (including result JSON) in the isolated context. `sync-learnings` uses this pattern.

```
Mag's context:                    Isolated context:
┌─────────────────────┐           ┌─────────────────────┐
│  Orchestrator       │           │  Worker             │
│  • Read task file   │──invoke──>│  • Explore codebase │
│  • Compose brief    │  + brief  │  • Read source files│
│  • Decide proceed   │           │  • Write artifacts  │
│  • Parse result     │<─summary──│  • Git commit/push  │
│  • Send notifs      │           └─────────────────────┘
│  • Write result JSON│
└─────────────────────┘
```

**Context brief**: Judgment-heavy workers (draft-proposal, elaborate, verify-completion) receive a free-form context brief (3-10 lines) from the orchestrator, distilling relevant background from Mag's conversation history. This bridges the gap between context isolation and cross-task awareness.

Worker frontmatter pattern:
```yaml
---
name: ludics-<name>-worker
description: <what the worker does>
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write
---
```

**Workers can make state changes** (git commits, `ludics notify`, `ludics slot clear`, `gh issue create`) when the contract is clear — the orchestrator specifies what should happen and the worker follows through. This avoids unnecessary round-trips.

**Classification:**

| Category | Skills | Rationale |
|----------|--------|-----------|
| Heavy (orchestrator + worker) | draft-proposal, revise-proposal, verify-completion, elaborate, feedback-digest | Deep codebase exploration; tool outputs would pollute Mag's context |
| Direct fork | sync-learnings | Forked for isolation but no orchestrator needed — mostly mechanical processing |
| Light (inline) | health-check, suggest, preempt, learn, split-task, new-quote, adopt-sessions, process-suggestions | Mostly CLI commands with minimal reads |
| Strategic (inline, special) | briefing | Needs Mag's cross-task context for slot assignment; sub-operations (elaboration) are themselves forked |

### Orchestration Engine

The orchestration engine (`src/orchestration/`, ~9K lines) runs multi-agent coding workflows within slots. It implements the phase state machine, skill dispatch, peer coordination, and merge logic that were previously handled by agent-duo's Bash scripts.

**Phases** (21 total, defined in `src/orchestration/phases.ts`):

```
setup → [gather] → [clarify] → [pushback] → [plan] → [plan-merge] → [plan-review]
      → work → review → [update-docs]
      → [pr-create] → [pr-comments]
      → [merge-vote] → [merge-debate] → [merge-execute] → [merge-review] → [merge-amend]
      → [suggest-refactor] → [forward-pr] → [final-merge]
      → done
```

The `forward-pr` phase handles staging final-merge operations for cross-slot merge coordination in hierarchical duo mode.

Phases in brackets are optional, gated by configuration flags (`enableClarify`, `enablePushback`, `enablePlan`, `enableGather`, `autoFinish`) and runtime conditions (PR existence, merge consensus).

**Orchestration state** (`src/orchestration/state.ts`):

```typescript
interface OrchestrationState {
  slot: number;
  feature: string;
  mode: "duo" | "pair";           // duo = same roles, pair = coder + reviewer
  phase: PhaseId;
  round: number;
  agents: AgentConfig[];          // name, provider, role, model, branch, worktreePath
  agentStates: Record<string, AgentRuntimeState>;  // status, PR URL, interrupted, turn state
  config: OrchestrationConfig;    // timeouts, poll intervals, feature flags
  phaseDispatched: boolean;       // prevents infinite re-entry
  rootWorktree?: string;
  peerSyncDir?: string;
}
```

**Runner** (`src/orchestration/runner.ts`, ~330 lines):

The runner is spawned as a background subprocess (`ludics orch run-internal <slot>`) by the t3code adapter. It:

1. Loads orchestration state from `orchestration/slot-{n}.json`
2. Enters the current phase — marks agents active, dispatches skill messages to t3code threads
3. Polls until all agents complete their turn or the phase times out
4. Evaluates the transition to determine the next phase
5. Emits `phase_transition` events to the event log
6. Repeats until reaching a terminal phase (`done`)

**Skill dispatch** (`src/orchestration/skills.ts`):

Each phase has a corresponding skill template in `skills/orchestration/`. The runner:
1. Resolves the template path based on phase, mode, and agent role
2. Builds a skill context (task spec, peer status, git diff, merge votes, file paths)
3. Substitutes `{{PLACEHOLDER}}` variables in the template
4. Sends the composed message to the agent's t3code thread

**Peer-sync** (`src/orchestration/peer-sync.ts`):

The `.peer-sync/` directory in the root worktree serves as the coordination channel — ludics writes, agents read:

```
.peer-sync/
├── feature           # Feature/task name
├── mode              # duo or pair
├── phase             # Current phase ID
├── phase-token       # Unique token per phase entry
├── round             # Current round number
├── {agent}-status    # Agent status files
├── plans/            # Agent-submitted plans
├── reviews/          # Agent-submitted reviews
├── merge-votes/      # Merge vote files
└── worktrees.json    # Worktree paths for all agents
```

**Worktrees** (`src/orchestration/worktrees.ts`):

Each orchestrated slot creates git worktrees:
- Root worktree: `{repo}-{feature}-s{slot}` on branch `ludics/{feature}/root`
- Per-agent worktrees: `{repo}-{feature}-s{slot}-{agent}` on branch `ludics/{feature}/{agent}`

Worktrees are cleaned up when the orchestration stops.

**Merge logic** (`src/orchestration/merge.ts`):

Multi-agent merge uses a voting protocol:
- Each agent writes a merge vote (accept/reject with rationale)
- Consensus check determines if merge can proceed
- Debate phase if agents disagree
- Execute → review → amend cycle for the actual merge

**Pair mode — collaborative planning workflow**:

In `pair` mode, agents have distinct roles with a structured planning collaboration:
- **Coder**: clarify → plan → plan-merge → work → pr-create (writes code)
- **Reviewer**: gather → pushback → plan → plan-review → review (provides feedback)

The planning phases implement an iterative merge-and-review cycle:

1. **Plan** — both agents write independent plans in parallel (`round-N-{agent}.md`)
2. **Plan-merge** (coder only) — coder reads both plans and produces a merged plan (`round-N-merged-{planMergeRound}.md`), integrating the strongest approaches from each
3. **Plan-review** (reviewer only) — reviewer votes `APPROVE` or `REQUEST_CHANGES` (`plan-merge-{planMergeRound}-{agent}.md`)
4. If `REQUEST_CHANGES` and `planMergeRound < 3`: loop back to plan-merge with reviewer feedback
5. If `planMergeRound >= 3` or `APPROVE`: proceed to work phase

This cycle ensures both agents contribute to the plan while keeping the coder as the single integrator, avoiding merge conflicts in the plan itself.

Phase-specific templates exist for each role (`pair-coder-*.md`, `pair-reviewer-*.md`).

**Hierarchical duo mode** (`src/slots/duo-expand.ts`, `src/orchestration/cross-slot.ts`):

The `--duo` flag now expands into two paired slots via `expandDuoSlots()`. Each slot runs a full pair-mode orchestration with swapped roles. State fields:

- `duoPeerSlot` — partner slot number for cross-slot coordination
- `duoAwaitingPeer` — sync flag for merge coordination

Cross-slot merge coordination (`bothSlotsReadyForMerge()`, `isMergeCoordinator()`) ensures both slots reach merge readiness before either proceeds. The merge coordinator (lower slot number) drives the merge while the peer waits.

**PR merge conflict detection** (`src/orchestration/runner.ts`):

During `pr-comments` phase, the runner tracks PR mergeable state transitions. When a PR goes from conflicted to clean (or vice versa), the coder is redispatched with a `pr-conflict-resolve.md` template to rebase and resolve conflicts.

**Hung agent detection** (`src/orchestration/runner.ts`):

Three detection modes with escalating nudges:
1. **Running-hung**: Agent status is "done" but tmux pane is static >180s
2. **Dispatch-hung**: Agent dispatched but pane static >90s
3. **Idle-running-hung**: Agent running (not done) but pane static >180s — detects prompt injection failures and incoherent agents

Escalation: Enter key → "Continue." message → full re-dispatch → force-settle. Uses unified `sendPromptToAgent()` with load-buffer/paste-buffer for all providers.

### t3code Integration

t3code is a Web GUI for AI coding agents (Node.js + React + Electron, Effect-TS, event-sourced with SQLite, WebSocket JSON-RPC). ludics integrates with t3code as an alternative runtime layer for spawning and managing AI agent sessions. Currently, tmux-based adapters (`agent-claude`, `agent-codex`) are used for most orchestrated work due to t3code stability issues; t3code remains the target runtime as its stability and observability improve.

**Architecture** (`src/t3code/`, ~1K lines):

```
ludics ──WebSocket──> t3code server ──spawns──> AI agents (Claude Code, Codex)
                           │
                      SQLite + React UI
```

**Client** (`src/t3code/client.ts`):
- `T3CodeClient`: WebSocket client with JSON-RPC protocol
- Methods: `getSnapshot()`, `dispatchCommand()`, `close()`
- Commands: project/thread creation, turn dispatch, snapshot retrieval

**Server management** (`src/t3code/server.ts`):
- `ensureServer()` — starts t3code server if not running, returns connection record
- `serverStatus()` — checks running status and gets snapshot
- `stopServer()` — graceful shutdown
- Port scanning (3773+) for available ports
- Health check via HTTP and process inspection
- Per-slot state: `{harnessDir}/t3code/slot-{n}.json` (thread IDs, orchestration metadata)

**Concurrency safety** (prevents race conditions when multiple callers invoke `ensureServer()` simultaneously):
- **File-based lock** (`server.lock`) — atomic `wx` create; dead-process stealing via PID check; 20s timeout before forced acquisition
- **Startup grace period** (15s) — if an existing server process was started recently, poll for readiness instead of killing it; prevents crash loops where concurrent callers SIGTERM each other's startups

**Provider mapping**:
- `codex` → `codex` (wire format)
- `claude-code` → `claudeAgent` (wire format)
- Conversion via `toWireProvider()` / `fromWireProvider()`

**t3code adapter** (`src/adapters/t3code.ts`, ~1.1K lines):

The t3code adapter supports two modes:

1. **Single-thread mode** (`slot start -a t3code`): Creates one t3code thread for manual coding
2. **Orchestrated mode** (`slot start -a t3code --duo/--pair`): Creates multiple threads + spawns orchestration subprocess

Orchestrated mode argument parsing:
```
--duo                     # Two agents, same roles
--pair                    # Coder + reviewer roles
--coder <provider>        # e.g., claude-code, codex
--reviewer <provider>
--feature <name>          # Feature branch name
--enable-clarify          # Enable clarify phase
--enable-plan             # Enable plan phase
--enable-gather           # Enable gather phase
--auto-finish             # Auto-finish after review
```

Thread reuse: checks if existing threads can be reused based on workspace/title/model/runtime/interaction mode.

### The Slot Model: Forcing Function for Parallelization

ludics defaults to **6 slots** (configurable in config.yaml) based on cognitive science and forcing functions.

```
┌─────────────────────────────────────────────────────────────┐
│                        SLOT                                 │
├─────────────────────────────────────────────────────────────┤
│  Process:     What's currently running (task/project)       │
│  Task:        Task ID assigned to this slot                 │
│  Mode:        How it's running (t3code, agent-claude...)    │
│  Session:     Named session identifier                      │
│  Path:        Working directory path                        │
│  Started:     Timestamp when assigned                       │
│  Runtime:     State held while active (context, questions)  │
│  Terminals:   Links to TUIs, orchestrators                  │
│  Git:         Worktrees, branches                           │
└─────────────────────────────────────────────────────────────┘
```

**Why fixed slots (hardcoded)?**

1. **Cognitive science**: Human working memory holds roughly 4–7 items. Six slots sits at the upper bound of focused attention.
2. **Forcing function**: Fixed capacity creates pressure to parallelize.
3. **Like Kanban WIP limits**: The constraint drives the behavior, not bikeshedding about "how many slots today."
4. **You don't have to use all slots**: Having 6 defined with 2 active is fine. Empty slots create pressure, not waste.

**Key properties:**
- Slots have no persistent identity — slot 3 isn't "the OCANNL slot"
- Context switching has a cost (like real CPUs)
- Runtime state is lost when the slot is cleared
- The work itself persists (commits, task files) — only the "registers" are ephemeral

**Preemption** (implemented in `src/slots/preempt.ts`):

Slots support preemption for priority tasks:
- `slot <n> preempt <task-id>` — stashes the current slot state, assigns the priority task
- `slot <n> restore` — restores the previously stashed state
- Stash includes: process, task, mode, session, path, started timestamp

**Slot operations** (implemented in `src/slots/index.ts`, ~515 lines):
- `slotAssign()` — assign task/description to slot (sets adapter, session, started time)
- `slotClear()` — clear slot, optionally mark task done/abandoned
- `slotStart()` / `slotStop()` — invoke adapter lifecycle (start guards against recoverable orchestration state for same task)
- `slotResume()` — crash recovery for orchestrated t3code sessions: validates persisted threads still exist on server, spawns new orchestration runner from saved state (distinct from `slotStart()` which creates fresh sessions)
- `slotsRefresh()` — poll adapters for state updates
- Slot changes automatically sync task file frontmatter (status, slot, adapter, started, completed)

### Flow-Based Task Management

ludics uses **flow-based scheduling** (throughput over latency), not time-based scheduling.

**What matters:**
- **Dependencies**: What blocks what (can't start B until A is done)
- **Hard deadlines**: External events only (paper due Feb 14, conference Mar 20)
- **Priority**: A (critical) / B (important) / C (nice-to-have)
- **Readiness**: Is `blocked_by` empty? Can we start now?
- **Status**: `ready` → `in-progress` → `done` (also: `abandoned`, `preempted`, `merged`)
- **Effort**: Small / medium / large (for WIP balancing)
- **Context**: Tags for minimizing context switches

**Flow engine** (implemented in `src/flow.ts`, ~350 lines):

All flow logic is native TypeScript — no external tools (yq, jq, tsort) needed:
- Reads task Markdown files directly, parses YAML frontmatter
- Cycle detection via Kahn's algorithm (topological sort)
- Priority sorting: A > B > C, then deadline proximity

```typescript
// Flow views
flowReady()      // Unblocked ready tasks, sorted by priority then deadline
flowBlocked()    // Tasks with unmet dependencies
flowCritical()   // Approaching deadlines (≤30 days) + high-priority
flowImpact(id)   // What tasks unblock if given task completes
flowContext()     // Distribution of work contexts across active slots
flowCheckCycle() // Detect circular dependencies
```

**Task representation** (stored as `task-NNN.md` with YAML frontmatter):
```yaml
---
id: task-042
title: "Implement tensor concatenation with einsum notation"
project: ocannl
status: in-progress
priority: A
deadline: 2026-05-15
dependencies:
  blocks: [task-043, task-044]
  blocked_by: []
  relates_to: [task-055]
  subtask_of: task-040
effort: large
context: einsum
slot: 1
adapter: t3code
created: 2026-01-29
started: 2026-01-29
completed: null
modified: 2026-02-15T10:30Z
elaborated: false
---

# Context
Roadmap item: Support `^` operator for tensor concatenation...
```

**Dependency fields:**
- `blocks` — tasks that cannot start until this one completes (authoritative direction)
- `blocked_by` — inverse of `blocks`; auto-pruned on completion (moved to `relates_to`)
- `relates_to` — related tasks (informational, no blocking semantics); also receives pruned `blocked_by` entries
- `subtask_of` — parent task ID (singular); groups subtasks in `flow impact`

**`modified` field** — ISO timestamp of last real work activity (commits, agent status changes), updated by adapters during `slots refresh`.

**Task aggregation** (`src/tasks/sync.ts`):
- Fetches GitHub issues (via `gh`) for configured projects
- Scans watched files for `- [ ]` checkboxes and `TODO:` lines
- Generates deterministic IDs (`gh-<repo>-<number>`, `watch-<path>-<fingerprint>`)
- Converts to individual task files, preserving existing user edits
- Refreshes metadata for existing GitHub-backed task files (including closed state, while preserving local title edits)
- `tasks merge` — merge duplicate/related tasks
- `tasks duplicates` — fingerprint titles to find potential duplicates

**Source of truth**: Individual `.md` task files in `tasks/` are the authoritative source. `tasks.yaml` is an auto-generated import manifest from `tasks sync`; processes (adapters, Mag, slots) read and update the `.md` files directly. All CLI commands (`list`, `show`, `files`, `flow`) read from `.md` files; `tasks.yaml` is only a fallback for tasks not yet converted.

### Events

ludics maintains a structured, append-only event log (`src/events.ts`, ~130 lines) for observability:

```typescript
interface LudicsEvent {
  ts: string;           // ISO timestamp
  epoch: number;        // Unix epoch
  event_type: string;   // e.g., "phase_transition", "slot_change"
  source: string;       // e.g., "orchestration", "slots"
  scope?: string;       // e.g., "slot-1"
  slot?: number;
  task?: string;
  adapter?: string;
  action?: string;
  status?: string;
  message?: string;
}
```

- `emitEvent()` — best-effort append to `journal/events.jsonl` (never fails caller)
- Events are emitted by the orchestration runner (phase transitions), adapters, and slot operations
- Queryable via CLI with filters: `--type`, `--task`, `--scope`, `--source`, `--since`, `--limit`

### Retrospectives

When a task completes, ludics collects a retrospective (`src/retrospective.ts`, ~555 lines) — a structured record of the entire orchestration lifecycle for post-hoc analysis.

**Data collected:**
- **Phase timeline** — ordered phases traversed, reconstructed from `journal/events.jsonl` phase_transition events
- **Verdicts** — `APPROVE` / `REQUEST_CHANGES` / `timeout` per review and plan-review round, parsed from artifact files (`round-N-{agent}.md`, `plan-merge-M-{agent}.md`)
- **Thread transcripts** — last assistant message from each turn in each t3code thread, annotated with phase-at-timestamp
- **Metadata** — task ID, agents, mode, rounds, PR URL, proposal path, suggest-refactor and workflow-feedback summaries

**Collection paths:**
- **Primary** (`collectAndWriteRetrospective`) — called by the orchestration runner when entering `done` phase, with full `OrchestrationState` available
- **Fallback** (`collectRetrospectiveFallback`) — called by Mag's keepalive before thread cleanup, using only task frontmatter (for orphaned/manually-completed tasks)

**Output:** JSON files in `retrospectives/` directory, viewable via the dashboard's retrospective page (`templates/dashboard/retrospective.html`). The dashboard shows phase badges, verdict history, per-agent thread cards, and a chronological turn log.

### Session Discovery

ludics includes a multi-stage pipeline (`src/sessions/`) that discovers running agent sessions across the system:

```
Discover → Enrich → Deduplicate → Classify
```

1. **Discovery** — scan multiple sources in parallel:
   - `discover-claude.ts` — parse Claude Code runtime state
   - `discover-codex.ts` — parse Codex CLI state
   - `discover-tmux.ts` — enumerate tmux sessions
   - `discover-ttyd.ts` — find ttyd web terminal instances

2. **Enrichment** (`enrich.ts`) — cross-reference with `.peer-sync/` orchestration data

3. **Deduplication** (`dedup.ts`) — merge duplicate sessions from multiple sources

4. **Classification** (`classify.ts`) — map discovered sessions to slot working directories

Output: `MergedSession` objects with agents, IDs, last activity, stale flag, assigned slot.

### Adapters

ludics doesn't run agents — it coordinates whatever you're using. Adapters are TypeScript modules implementing a common interface:

```typescript
interface Adapter {
  readState(ctx: AdapterContext): MaybePromise<string | null>;
  start(ctx: AdapterContext): MaybePromise<string>;
  stop(ctx: AdapterContext): MaybePromise<string>;
  lastActivity(ctx: AdapterContext): MaybePromise<string | null>;
}

interface AdapterContext {
  slot: number;
  mode: string;
  session: string;
  taskId: string;
  process: string;
  harnessDir: string;
  stateRepoDir: string;
}
```

**Implemented adapters** (`src/adapters/`):

| Adapter | What it manages | State source |
|---------|-----------------|--------------|
| `t3code` | Multi-agent orchestration or single-thread coding via t3code | t3code WebSocket + orchestration state |
| `agent-claude` | Claude Code (tmux-based, currently primary for orchestrated work) | `.peer-sync/` + tmux |
| `agent-codex` | Codex (tmux-based, currently primary for orchestrated work) | `.peer-sync/` + tmux |
| `claude-ai` | Browser Claude conversation | URL bookmark |
| `chatgpt-com` | Browser ChatGPT conversation | URL bookmark |
| `manual` | Human, no agent | Status file + notes |

**Shared utilities** (`src/adapters/base.ts`):
- State file I/O (key=value format, atomic writes)
- Status file format (pipe-delimited: `status|epoch|message`)
- Git worktree detection and branch reading
- MarkdownBuilder utility for structured state reports

**Task-launch utility** (`src/adapters/task-launch.ts`):
- Shared logic for launching tasks in adapters

**Registry pattern** (`src/adapters/index.ts`): Central dispatch maps adapter names to implementations.

### Messaging (ntfy.sh)

ludics uses **ntfy.sh** for bidirectional communication with three configurable topics:

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `outgoing` | Mag → user | Strategic briefings, high-priority alerts |
| `incoming` | user → Mag | Messages from phone (commands, replies, task input) |
| `agents` | system → user | Operational agent updates |

The `incoming` topic enables the user to converse with Mag from any device — respond to questions, approve elaborations, assign tasks, or send freeform instructions. Mag processes incoming messages by inserting message content directly as a user turn.

Implementation (`src/notify.ts`): curl to `https://ntfy.sh/{topic}` with auth token. `ludics notify subscribe` long-polls the incoming topic. Notifications are logged to `journal/notifications.jsonl`.

### Cluster (Multi-Machine Coordination)

For multi-machine setups (e.g., laptop + always-on Mac Mini), ludics includes a cluster system (`src/cluster.ts`, ~420 lines + `src/cluster-http.ts`, ~657 lines):

- **Static controller role**: The controller is determined by `role: "leader"` in machine config — no dynamic election. Only the controller runs Mag.
- **Heartbeat mechanism**: Each node publishes `cluster/heartbeats/{node}.json` with timestamp and Mag status
- **Stale timeout**: 900 seconds (configurable via `LUDICS_HEARTBEAT_TIMEOUT`)
- **Network support**: Tailscale hostname detection (`src/network.ts`)
- **HTTP transport** (`src/cluster-http.ts`): Worker nodes write state changes to the controller via HTTP instead of git push. Endpoints: `/api/cluster/journal`, `/event`, `/orchestration-state`, `/task-update`, `/slot-update`, `/intent`. Intents are stored in-memory on the controller; workers poll via HTTP (pure-pull flow). Git commits happen only at natural checkpoints (health-check, shutdown).
- **Worker keepalive** (`src/cluster.ts`): Separate from the cluster trigger, worker nodes run their own keepalive that detects dispatched-but-lost slots (proposal exists, no active session) and auto-starts them via intent consumption.
- **Machine selection** (`selectMachineForSlot` in `src/cluster.ts`): Tasks with `requirements` frontmatter (optional `os`, `gpu` fields) are matched against cluster machine capabilities. Project-level `requirements` are also matched. Selection priority: (1) filter by requirements, (2) prefer `always_on` machines, (3) tiebreak by preferring non-current machine for load balance. Returns `null` (blocks assignment) if no cluster machine matches requirements. Offline but matching machines are still selected — the slot is assigned but start is blocked until the machine comes online, with an "offline" badge on the dashboard.

### Triggers

Events that fire automation (implemented in `src/triggers.ts`, ~400 lines):

| Trigger | Mechanism | Example action |
|---------|-----------|----------------|
| Startup | launchd `RunAtLoad` / systemd `WantedBy` | `mag start` |
| Sync | launchd `StartInterval` / systemd timer | `tasks sync` |
| Morning | launchd `StartCalendarInterval` | `mag briefing` |
| Health | launchd `StartInterval` | `mag health-check` |
| Watch | launchd `WatchPaths` / inotify | `tasks sync` |

**Cross-platform**: Generates launchd plists (macOS) or systemd service/timer units (Linux). Plist generation includes custom `EnvironmentVariables` (PATH includes `~/.bun/bin`).

**Idempotency**: All triggers are safe to re-fire. `tasks sync` regenerates from scratch each run (deterministic IDs ensure no duplicates), then skips existing task files to preserve user edits.

## Configuration

ludics uses a **two-tier configuration system**:

### Pointer config (`~/.config/ludics/config.yaml`)

Points to the state repo:
```yaml
state_repo: lukstafi/self-improve
state_path: harness
```

### Full config (in state repo, e.g., `~/self-improve/harness/config.yaml`)

```yaml
slots:
  count: 6

projects:
  - name: ocannl
    repo: lukstafi/ocannl
    issues: true
    priority: true

  - name: ppx-minidebug
    repo: lukstafi/ppx_minidebug
    issues: true

adapters:
  t3code:
    enabled: true
  agent-claude:
    enabled: true

mag:
  enabled: true
  ttyd_port: 7679
  autonomy_level:
    elaborate_tasks: auto
    preempt_slots: auto

notifications:
  provider: ntfy.sh
  topics:
    outgoing: lukstafi-from-Mag
    incoming: lukstafi-to-Mag
    agents: lukstafi-agents
  token: sk_ntfy_...

dashboard:
  port: 7678

network:
  mode: tailscale
  hostname: machine.example.com

cluster:
  machines:
    - name: primary
      host: primary.tail123456.ts.net
      os: macos
      role: leader
      always_on: true
      gpu: ""            # empty string = no GPU; matched against task requirements.gpu

triggers:
  startup:
    enabled: true
    action: mag start
  sync:
    enabled: true
    interval: 3600
    action: tasks sync
  morning:
    enabled: true
    hour: 8
    minute: 0
    action: mag briefing
  watch:
    - paths:
        - ~/repos/ocannl/README.md
      action: tasks sync
```

### Adapter Args Layering (t3code Orchestrated Adapters)

For t3code orchestrated starts, ludics composes adapter args from:

1. `adapters.t3code.default_args`
2. `projects[].adapter_profiles.t3code`
3. Slot `Adapter Args` field
4. Task frontmatter `adapter_args` (highest precedence)

Supported formats:

- shell-style string: `--duo --enable-clarify --enable-plan`
- argv list: `["--duo", "--enable-clarify", "--feature", "my-feature"]`
- project/task mode map: `{ t3code: [...], default: "..." }`

## Directory Structure

### Public repo (`ludics`)

```
ludics/
├── CLAUDE.md                         # Instructions for AI agents
├── CHANGELOG.md                      # Release notes
├── package.json                      # Bun project config (yaml dependency)
├── tsconfig.json                     # TypeScript config
├── bin/
│   └── ludics                        # Compiled standalone binary (~60MB)
├── src/                              # TypeScript source (~87 modules, ~52K lines)
│   ├── index.ts                      # CLI entry point & command dispatcher
│   ├── config.ts                     # Two-tier config loading (YAML)
│   ├── types.ts                      # Shared type definitions
│   ├── state.ts                      # Git-backed state (commit/pull/push)
│   ├── flow.ts                       # Flow engine (ready/blocked/critical/impact)
│   ├── events.ts                     # Structured event log (JSONL)
│   ├── mag.ts                        # Mag lifecycle & queue management (~3.5K lines)
│   ├── health.ts                     # Project test suite monitoring (~166 lines)
│   ├── notify.ts                     # ntfy.sh integration
│   ├── journal.ts                    # JSONL activity log
│   ├── queue.ts                      # Async request queue for Mag
│   ├── triggers.ts                   # launchd/systemd trigger generation
│   ├── dashboard.ts                  # Dashboard data generation
│   ├── dashboard-server.ts           # HTTP server for dashboard
│   ├── retrospective.ts              # Retrospective collection at task completion (~555 lines)
│   ├── network.ts                    # Hostname/URL helpers (Tailscale)
│   ├── cluster.ts                    # Multi-machine coordination (~420 lines)
│   ├── cluster-http.ts               # HTTP transport for worker writes (~657 lines)
│   ├── config-cli.ts                 # Config CLI commands
│   ├── spawn.ts                      # safeSyncOutput helper for Bun.spawnSync
│   ├── remote.ts                     # Remote/HTTP communication helpers
│   ├── skill-queue-registry.ts       # Skill queue action registry
│   ├── init.ts                       # Setup pipeline
│   ├── quote.ts                      # Random quotes
│   ├── orchestration/                # Multi-agent workflow engine (~9K lines)
│   │   ├── index.ts                  # Orchestration CLI (status, confirm, interrupt, skip, log)
│   │   ├── state.ts                  # OrchestrationState, AgentConfig, AgentRuntimeState
│   │   ├── phases.ts                 # 21-phase state machine, transition rules
│   │   ├── runner.ts                 # Main orchestration loop (~330 lines)
│   │   ├── skills.ts                 # Template resolution, context building, substitution
│   │   ├── peer-sync.ts             # .peer-sync/ directory management
│   │   ├── worktrees.ts             # Git worktree creation and cleanup
│   │   ├── merge.ts                 # Merge voting and consensus
│   │   ├── learning.ts              # Update-docs phase gating
│   │   ├── cross-slot.ts            # Cross-slot merge coordination (~71 lines)
│   │   ├── review-files.ts          # Shared review filename logic (~39 lines)
│   │   └── util.ts                  # Shared orchestration utilities
│   ├── t3code/                       # t3code server integration (~1K lines)
│   │   ├── index.ts                  # t3code CLI (start, stop, status)
│   │   ├── types.ts                  # T3 types, provider mapping, WebSocket commands
│   │   ├── client.ts                 # WebSocket JSON-RPC client
│   │   └── server.ts                 # Server lifecycle, port scanning, health check
│   ├── slots/
│   │   ├── index.ts                  # Slot CLI + lifecycle (~515 lines)
│   │   ├── markdown.ts               # Parse/write slots.md
│   │   ├── paths.ts                  # Extract slot paths
│   │   ├── preempt.ts                # Stash/restore for preemption
│   │   ├── duo-expand.ts             # Hierarchical duo slot expansion (~87 lines)
│   │   └── types.ts
│   ├── tasks/
│   │   ├── index.ts                  # Task CLI + operations (~372 lines)
│   │   ├── sync.ts                   # Aggregation from GitHub + READMEs
│   │   ├── markdown.ts               # Frontmatter parsing
│   │   └── types.ts
│   ├── adapters/
│   │   ├── index.ts                  # Adapter registry (dispatch by name)
│   │   ├── types.ts                  # Adapter interface
│   │   ├── base.ts                   # Shared utilities (state I/O, git)
│   │   ├── t3code.ts                 # t3code adapter (~1.1K lines) — orchestrated + single-thread
│   │   ├── agent-claude.ts           # Claude Code (SSH, tmux)
│   │   ├── agent-codex.ts            # Codex (SSH, tmux)
│   │   ├── agent-session.ts          # Shared agent session logic
│   │   ├── peer-sync.ts              # .peer-sync/ file reading
│   │   ├── task-launch.ts            # Shared task-launch logic
│   │   ├── claude-ai.ts              # Browser Claude
│   │   ├── chatgpt-com.ts            # Browser ChatGPT
│   │   ├── manual.ts                 # Human work tracking
│   │   ├── tmux.ts                   # Standalone tmux sessions
│   │   ├── bookmark.ts               # Web bookmark collector
│   │   └── markdown.ts               # MarkdownBuilder utility
│   └── sessions/
│       ├── index.ts                  # Discovery pipeline orchestration
│       ├── discover-claude.ts        # Claude Code session discovery
│       ├── discover-codex.ts         # Codex session discovery
│       ├── discover-tmux.ts          # tmux session enumeration
│       ├── discover-ttyd.ts          # ttyd instance discovery
│       ├── enrich.ts                 # Cross-reference with .peer-sync/
│       ├── dedup.ts                  # Merge duplicate sessions
│       ├── classify.ts               # Map sessions to slots
│       ├── report.ts                 # Markdown/JSON report generation
│       └── read-lines.ts             # Line reading utility
├── skills/                           # Mag skills (23 files: 15 skills + 5 workers + conventions)
│   ├── ludics-adopt-sessions.md      # Inline
│   ├── ludics-briefing.md            # Inline (needs strategic context)
│   ├── ludics-draft-proposal.md      # Orchestrator
│   ├── ludics-draft-proposal-worker.md  # Worker (context: fork)
│   ├── ludics-elaborate.md           # Orchestrator
│   ├── ludics-elaborate-worker.md    # Worker (context: fork)
│   ├── ludics-feedback-digest.md     # Orchestrator
│   ├── ludics-feedback-digest-worker.md # Worker (context: fork)
│   ├── ludics-health-check.md        # Inline
│   ├── ludics-learn.md               # Inline
│   ├── ludics-new-quote.md           # Inline
│   ├── ludics-preempt.md             # Inline
│   ├── ludics-process-suggestions.md # Inline (REQUEST_CHANGES review extraction)
│   ├── ludics-revise-proposal.md     # Orchestrator
│   ├── ludics-revise-proposal-worker.md # Worker (context: fork)
│   ├── ludics-split-task.md          # Inline
│   ├── ludics-suggest.md             # Inline
│   ├── ludics-sync-learnings.md      # Direct fork (context: fork)
│   ├── ludics-verify-completion.md   # Orchestrator
│   ├── ludics-verify-completion-worker.md # Worker (context: fork)
│   ├── orchestrator-conventions.md   # Shared orchestrator conventions
│   └── worker-conventions.md         # Shared worker conventions
├── skills/orchestration/             # Orchestration phase templates (25 files)
│   ├── clarify.md                    # Clarify phase instructions
│   ├── gather.md                     # Gather context phase
│   ├── pushback.md                   # Reviewer pushback phase
│   ├── plan.md                       # Plan phase
│   ├── plan-review.md                # Plan review phase
│   ├── work.md                       # Main work phase
│   ├── review.md                     # Review phase
│   ├── update-docs.md                # Learning/docs phase
│   ├── pr-create.md                  # PR creation phase
│   ├── pr-comments.md                # PR comments phase
│   ├── merge-vote.md                 # Merge voting
│   ├── merge-debate.md               # Merge debate
│   ├── merge-execute.md              # Merge execution
│   ├── merge-review.md               # Post-merge review
│   ├── merge-amend.md                # Merge amendments
│   ├── suggest-refactor.md           # Post-merge refactoring suggestions
│   ├── forward-pr.md                 # Forward PR for cross-slot merge
│   ├── upstream-final-merge.md        # Upstream final merge
│   ├── pr-conflict-resolve.md        # PR merge conflict resolution
│   ├── final-merge.md                # Final merge
│   ├── pair-coder-clarify.md         # Pair mode: coder clarify
│   ├── pair-coder-plan.md            # Pair mode: coder plan
│   ├── pair-coder-plan-merge.md      # Pair mode: coder merges independent plans
│   ├── pair-coder-pr-create.md       # Pair mode: coder PR creation
│   ├── pair-coder-update-docs.md     # Pair mode: coder update docs
│   ├── pair-coder-work.md            # Pair mode: coder work
│   ├── pair-reviewer-clarify.md      # Pair mode: reviewer clarify
│   ├── pair-reviewer-gather.md       # Pair mode: reviewer gather
│   ├── pair-reviewer-plan.md         # Pair mode: reviewer independent plan
│   ├── pair-reviewer-plan-review.md  # Pair mode: reviewer votes on merged plan
│   ├── pair-reviewer-pushback.md     # Pair mode: reviewer pushback
│   └── pair-reviewer-review.md       # Pair mode: reviewer review
├── templates/
│   ├── config.reference.yaml         # Example config
│   ├── slots.example.md
│   ├── Girard_quotes.txt             # Quote source
│   ├── harness/                      # Initial harness layout
│   ├── hooks/                        # Stop hook templates
│   ├── mag/                          # Mag initial state templates
│   ├── dashboard/                    # HTML/CSS/JS for web dashboard
│   ├── launchd/                      # LaunchAgent plist templates
│   └── systemd/                      # systemd unit templates
├── tests/                            # Test suite
└── docs/
    ├── ARCHITECTURE.md               # This file
    ├── implemented/                   # Proposals/plans that have been implemented
    └── proposals/                     # Active proposals for future work
```

### Private repo (user's choice, e.g., `self-improve`)

```
your-private-repo/
└── harness/
    ├── config.yaml                # Full configuration
    ├── slots.md                   # Current slot states
    ├── tasks.yaml                 # Import manifest (auto-generated, not source of truth)
    ├── tasks/                     # Individual task files — source of truth (git-backed)
    │   ├── task-001.md
    │   ├── task-002.md
    │   └── ...
    ├── orchestration/             # Orchestration state per slot
    │   └── slot-{n}.json         # OrchestrationState for active orchestrations
    ├── t3code/                    # t3code integration state
    │   ├── server.json           # Server connection record (pid, urls, auth)
    │   ├── server.lock           # Startup lock (prevents concurrent ensureServer races)
    │   └── slot-{n}.json        # Per-slot thread/metadata
    ├── journal/                   # Daily logs
    │   ├── 2026-01-31.md
    │   ├── events.jsonl          # Structured event log
    │   └── notifications.jsonl    # Notification history
    ├── mag/                       # Mag's persistent state
    │   ├── context.md             # Current understanding
    │   ├── queue.jsonl            # Request queue
    │   ├── results/               # Request result files
    │   ├── session.state          # Persistent Mag state
    │   ├── session.status         # Current status (ready|waiting|error)
    │   ├── briefing-context.md    # Pre-computed briefing context
    │   └── memory/                # Long-term patterns
    │       └── user-preferences.md
    ├── retrospectives/            # Post-completion retrospective data
    │   └── {taskId}.json         # Per-task retrospective JSON
    ├── cluster/                   # Multi-machine coordination
    │   └── heartbeats/            # Per-node heartbeat files
    └── dashboard/                 # Generated dashboard data
        └── data/
            └── slots.json
```

## Web Dashboard

ludics provides a web dashboard for at-a-glance status monitoring (`src/dashboard.ts`, ~254 lines + `dashboard-server.ts`).

**Data generation:**
- `generateSlots()` → JSON with slot status, task content (Markdown), preemption info
- `generateReady()` → ready tasks sorted by priority/deadline
- `generateProjects()` → project statistics
- `generateRecentlyCompleted()` → recently completed tasks with retrospective links

**Serving:** Node.js-compatible HTTP server on configurable port (default 7678).

**Dashboard layout (slot tiles + sidebar):**

```
┌──────────────┬──────────────┬──────────────┬────────────────┐
│   Slot 1     │   Slot 2     │   Slot 3     │  Ready Queue   │
│  ■ Active    │  □ Empty     │  ■ Active    │  1. task-101   │
│  task-042    │              │  task-089    │  2. task-067   │
│  t3code      │              │  agent-claude│                │
├──────────────┼──────────────┼──────────────┤  Project Stats │
│   Slot 4     │   Slot 5     │   Slot 6     │                │
│  □ Empty     │  □ Empty     │  □ Empty     │  Notifications │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

**Features:**
- Slot tiles with task Markdown content, scrollable details
- Recently-completed tasks tile with links to retrospective viewer
- Deferred Launch tile — tasks awaiting user approval with View/Approve/Abandon buttons
- Unanswered Questions tile — tasks flagged with `has_questions: true`
- Adapter toggle button on slot tiles — reads global adapter from `adapter.json`
- Shared tile abstraction (`FilteredTaskTileConfig`) for filtered-task dashboard tiles
- Project status indicators (priority projects highlighted)
- Dynamic details panel on tile click
- Retrospective viewer page (`retrospective.html`) — phase timeline, verdict history, chronological turn log
- Responsive layout filling the viewport
- Read-only — all control via CLI (except approve/abandon buttons)

**CLI commands:**
- `ludics dashboard generate` — generate JSON data
- `ludics dashboard serve [port]` — serve dashboard
- `ludics dashboard install` — copy assets to state repo

## CLI Interface

```bash
# Slot management
ludics slots                   # Show all slots
ludics slots refresh           # Refresh slot state from adapters
ludics slot <n>                # Show slot n
ludics slot <n> assign <task|desc> [-a adapter] [-s session] [-p path]
ludics slot <n> clear [in-progress|done|abandoned]
ludics slot <n> start          # Start fresh agent session (fails if recoverable state for same task)
ludics slot <n> stop [--preserve-state]  # Stop agent session (preserve state for mode toggle)
ludics slot <n> resume         # Resume orchestrated t3code session (crash recovery)
ludics slot <n> mode <mode>    # Toggle adapter mode (e.g., manual ↔ t3code) with preserveState
ludics slot <n> note "text"    # Add runtime note
ludics slot <n> preempt <task-id> [-a adapter] [-s session] [-p path]
ludics slot <n> restore        # Restore previously preempted work

# Task management
ludics tasks sync              # Aggregate tasks, convert files, refresh existing GitHub task metadata
ludics tasks list              # Show unified task list
ludics tasks show <id>         # Show task details
ludics tasks convert           # Convert tasks.yaml to individual task files
ludics tasks update            # Refresh GitHub metadata for existing tasks (preserves local title edits)
ludics tasks create <title>    # Create a new task manually
ludics tasks files             # List individual task files
ludics tasks needs-elaboration # List tasks needing elaboration
ludics tasks queue-elaborations # Queue elaboration for unprocessed ready tasks
ludics tasks check <id>        # Check if task needs elaboration
ludics tasks merge <tgt> <src> # Merge source task(s) into target
ludics tasks duplicates        # Find potential duplicate tasks

# Flow views (not calendar-based)
ludics flow ready              # Priority-sorted ready tasks
ludics flow blocked            # What's blocked and why
ludics flow critical           # Deadlines + high-priority
ludics flow impact <id>        # What this task unblocks
ludics flow context            # Context distribution across slots
ludics flow check-cycle        # Check for dependency cycles

# Orchestration control
ludics orch status <slot>      # Show orchestration state for slot
ludics orch confirm <slot>     # Confirm current phase
ludics orch interrupt <slot>   # Interrupt active agents
ludics orch skip <slot> <phase> # Force to specific phase
ludics orch log <slot>         # Show phase transition log
ludics orch run-internal <slot> # Internal: run orchestration loop (spawned as subprocess)

# t3code server management
ludics t3code [status]         # Show t3code server status
ludics t3code start            # Start t3code server
ludics t3code stop             # Stop t3code server

# Events
ludics events [--type X] [--task Y] [--scope S] [--source R] [--since T] [--limit N]

# Mag interaction
ludics mag start [--no-ttyd]   # Start Mag tmux session
ludics mag stop                # Stop Mag tmux session
ludics mag status              # Show Mag status
ludics mag attach              # Attach to Mag tmux session
ludics mag logs [n]            # Show recent Mag activity
ludics mag doctor              # Health check for Mag setup
ludics mag briefing            # Request morning briefing
ludics mag suggest             # Get task suggestions
ludics mag analyze <issue>     # Analyze GitHub issue
ludics mag elaborate <id>      # Elaborate task into detailed spec
ludics mag health-check        # Check for deadlines, issues
ludics mag message "text"      # Send async message to Mag
ludics mag queue               # Show pending queue requests
ludics mag queue pop one       # Atomic dequeue of one request
ludics mag queue pop all       # Atomic dequeue of all requests
ludics mag context             # Pre-compute briefing context file
ludics auto-start-evaluate <id> [confidence] [rationale...]  # Evaluate auto-start decision

# Session discovery
ludics sessions [--json]       # Discover and classify all agent sessions
ludics sessions report [--json] # Generate sessions report for Mag
ludics sessions refresh [--json] # Re-run discovery and update report
ludics sessions show [filter]  # Show detailed session info

# Notifications
ludics notify outgoing <msg>   # Send strategic notification
ludics notify agents <msg>     # Send operational notification
ludics notify subscribe        # Subscribe to incoming messages (long-running)
ludics notify recent [n]       # Show recent notifications

# Dashboard
ludics dashboard generate      # Generate JSON data for dashboard
ludics dashboard serve [port]  # Serve dashboard (default: 7678)
ludics dashboard install       # Install dashboard to state repo

# State synchronization
ludics sync                    # Full sync (pull + push)
ludics state pull              # Pull latest from remote
ludics state push              # Push local changes

# Journal
ludics journal                 # Show today's journal entries
ludics journal recent [n]      # Show last n entries
ludics journal list [days]     # List journal files from last n days

# Cluster (multi-machine)
ludics cluster status          # Show cluster status
ludics cluster tick            # Publish heartbeat
ludics cluster heartbeat       # Publish heartbeat only

# Health monitoring
ludics health run-tests [--project=NAME] [--force]  # Run project test suites

# Network
ludics network status          # Show network configuration

# Setup & diagnostics
ludics init [--no-hooks] [--no-dashboard] [--no-triggers]
ludics stop [pause|uninstall]  # Stop scheduled trigger activity
ludics triggers install        # Install launchd/systemd triggers
ludics triggers pause          # Pause triggers without deleting unit files
ludics triggers status         # Show trigger status
ludics triggers uninstall      # Remove all triggers
ludics doctor                  # Check system health and dependencies
ludics status                  # Overview of slots + tasks
ludics briefing                # Morning briefing (invokes Mag)
ludics quote                   # Print a random quote
```

## Design Principles

1. **Autonomous minds, deterministic rails** — AI makes decisions, deterministic code executes reliably
2. **Flow-based, not time-based** — Throughput over latency, dependencies over deadlines
3. **Coordination layer** — ludics coordinates, doesn't replace existing tools
4. **Adapter pattern** — Support any agent system via a common TypeScript interface
5. **Git-backed persistence** — Everything version controlled, survives agent crashes
6. **Hardcoded constraints as forcing functions** — Fixed slots create pressure to parallelize
7. **One lifelong Mag** — Builds memory, consistent decisions, sees cross-project connections
8. **TypeScript + Bun** — Type-safe, fast startup, single binary, shell commands where needed
9. **Cluster for scale** — Static controller role with HTTP transport for multi-machine coordination
10. **Bidirectional messaging via ntfy** — outgoing alerts push to user's phone; incoming topic lets user converse with Mag from any device
11. **Dual runtime paths** — t3code (Web GUI) and tmux both supported for agent sessions; tmux currently primary for stability, t3code is the target as it matures. ludics manages lifecycle and phases regardless of runtime.

## Failure Modes and Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Mag crashes | tmux session exits, health check | Restart Mag; git state is last-committed |
| Git sync conflict | `git pull` fails | Notify user; manual resolution required |
| Trigger doesn't fire | Health check detects stale state | `ludics triggers status` to diagnose |
| ntfy.sh unreachable | curl returns error | Log locally; retry on next trigger |
| Claude API down | Task tool fails | Mag retries or skips, logs warning |
| Task file corrupted | YAML parse fails | Skip file; notify user |
| Cluster: controller down | Heartbeat timeout (900s) | Manual intervention — static controller role, no automatic failover |
| t3code server crashes | Health check, PID inspection | `ludics t3code start` restarts; orchestration state persists |
| t3code concurrent startup | File lock + grace period | `server.lock` serializes callers; 15s grace prevents SIGTERM of starting processes |
| Orchestration runner crashes | PID check in readState | Restart via `slot resume`; state persists in `orchestration/slot-{n}.json`; phase token dedup prevents duplicate agent dispatches |
| Phase timeout | Runner polling detects expiry | Automatic transition to next phase |
| Agent hung (idle/stuck) | Pane static >90–180s | Escalating nudges: Enter → "Continue." → re-dispatch → force-settle |
| PR merge conflict | Mergeable state transition | Coder redispatched with conflict-resolve template |
| Cross-machine slot dispatch lost | Worker keepalive | Auto-start via HTTP intent consumption |

**Design for recovery:**
- All state changes go through git → crash-safe, auditable
- Orchestration state persists to JSON files → recoverable after runner restart
- Adapters are stateless readers (can restart anytime)
- Triggers are idempotent (safe to re-run)
- Preemption uses stash files (recoverable if process crashes)
- t3code threads persist in SQLite → survive server restarts

**What requires manual intervention:**
- Git merge conflicts (by design — human resolves semantic conflicts)
- Slot assignment (configurable: manual vs. auto)
- Starting agent sessions (configurable: manual vs. auto)
