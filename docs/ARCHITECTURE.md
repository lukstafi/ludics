# ludics Architecture

*Living document — describes the current implementation.*

## Overview

ludics is a lightweight personal AI infrastructure — a harness for humans working with AI agents. It manages concurrent agent sessions (slots), orchestrates autonomous task analysis (Mag), and maintains flow-based task management.

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
- Module system for clean separation of concerns (~22 modules, ~9K lines)

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
│                                                            │
│  Notifications (ntfy.sh):                                  │
│    • <user>-from-Mag: outgoing strategic updates (→ phone) │
│    • <user>-to-Mag: incoming messages (phone → Mag)        │
│    • <user>-agents: Worker task events (operational)        │
│                                                            │
│  Federation (TypeScript):                                  │
│    • Multi-machine Mag coordination                        │
│    • Seniority-based leader election                       │
│    • Heartbeat publishing via git-backed state             │
└────────────┬───────────────────────────────────────────────┘
             │ manages
             ▼
┌────────────────────────────────────────────────────────────┐
│              WORKER SLOTS (Ephemeral AI)                   │
│                     6 slots (default)                      │
│                                                            │
│  Slot 1: agent-duo on task-042 (coder + reviewer)          │
│  Slot 2: empty                                             │
│  Slot 3: claude-code on task-089                           │
│  Slot 4-6: empty                                           │
│                                                            │
│  Workers implement tasks, not strategy                     │
│  Preemption: stash current work for priority tasks         │
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

**Skills system** (`skills/` directory, 21 Markdown files — 15 skills + 6 workers):

| Skill | Purpose | Isolation |
|-------|---------|-----------|
| `/ludics-briefing` | Morning strategic briefing | Inline (needs strategic context) |
| `/ludics-draft-proposal` | Write proposal document, send launch buttons | Orchestrator + worker |
| `/ludics-elaborate` | Detailed spec for a task (early, for Mag context) | Orchestrator + worker |
| `/ludics-feedback-digest` | Summarize user feedback | Orchestrator + worker |
| `/ludics-health-check` | Detect approaching deadlines, queue completion checks | Inline |
| `/ludics-launch-session` | Find slot and start agent session for a task | Inline |
| `/ludics-learn` | Update institutional memory from corrections | Inline |
| `/ludics-new-quote` | Generate motivational quote | Inline |
| `/ludics-preempt` | Plan task preemption | Inline |
| `/ludics-read-inbox` | Process incoming messages | Inline |
| `/ludics-split-task` | Split multi-concern task into subtasks | Inline |
| `/ludics-suggest` | Task suggestions based on flow state | Inline |
| `/ludics-sync-learnings` | Consolidate learnings into structured memory | Direct fork |
| `/ludics-verify-completion` | Deep-inspect task completion, create follow-ups | Orchestrator + worker |

Skills are Markdown files with embedded instructions for Claude Code. Heavy skills use an **orchestrator/worker pattern** for context isolation — see [Skill Context Isolation](#skill-context-isolation) below.

**Elaboration vs. Proposal timing**: Elaborations run as early as possible — immediately when tasks are created or during briefing — so that Mag has detailed specs for dependency analysis, slot assignment, and priority decisions. Proposals are deferred until a task is actually assigned to a slot, giving the proposal the freshest codebase state and cross-task context. Since proposals are the last step before a coding agent starts work, they benefit from a fresh Opus context window with maximum brain power for disambiguating scope, surfacing staleness, and deciding whether to split multi-concern tasks.

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

**Mag lifecycle** (implemented in `src/mag.ts`, ~660 lines):
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
| Heavy (orchestrator + worker) | draft-proposal, verify-completion, elaborate, feedback-digest | Deep codebase exploration; tool outputs would pollute Mag's context |
| Direct fork | sync-learnings | Forked for isolation but no orchestrator needed — mostly mechanical processing |
| Light (inline) | launch-session, health-check, read-inbox, suggest, preempt, learn, split-task, new-quote | Mostly CLI commands with minimal reads |
| Strategic (inline, special) | briefing | Needs Mag's cross-task context for slot assignment; sub-operations (elaboration) are themselves forked |

### The Slot Model: Forcing Function for Parallelization

ludics defaults to **6 slots** (configurable in config.yaml) based on cognitive science and forcing functions.

```
┌─────────────────────────────────────────────────────────────┐
│                        SLOT                                 │
├─────────────────────────────────────────────────────────────┤
│  Process:     What's currently running (task/project)       │
│  Task:        Task ID assigned to this slot                 │
│  Mode:        How it's running (agent-duo, claude-code...)  │
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
- `slotStart()` / `slotStop()` — invoke adapter lifecycle
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
adapter: agent-duo
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
| `agent-duo` | Two agents + orchestrator | `.peer-sync/` |
| `agent-solo` | Single agent orchestration | `.peer-sync/` |
| `agent-claude` | Claude Code (SSH-based, tmux) | `.peer-sync/` + tmux |
| `agent-codex` | Codex (SSH-based, tmux) | `.peer-sync/` + tmux |
| `claude-ai` | Browser Claude conversation | URL bookmark |
| `chatgpt-com` | Browser ChatGPT conversation | URL bookmark |
| `manual` | Human, no agent | Status file + notes |
| `tmux` | Standalone tmux session | tmux |
| `bookmark` | Web bookmark collector | — |

**Shared utilities** (`src/adapters/base.ts`):
- State file I/O (key=value format, atomic writes)
- Status file format (pipe-delimited: `status|epoch|message`)
- Git worktree detection and branch reading
- MarkdownBuilder utility for structured state reports

**Registry pattern** (`src/adapters/index.ts`): Central dispatch maps adapter names to implementations.

### Messaging (ntfy.sh)

ludics uses **ntfy.sh** for bidirectional communication with three configurable topics:

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `outgoing` | Mag → user | Strategic briefings, high-priority alerts |
| `incoming` | user → Mag | Messages from phone (commands, replies, task input) |
| `agents` | system → user | Operational agent updates |

The `incoming` topic enables the user to converse with Mag from any device — respond to questions, approve elaborations, assign tasks, or send freeform instructions. Mag processes incoming messages via the `/ludics-read-inbox` skill.

Implementation (`src/notify.ts`): curl to `https://ntfy.sh/{topic}` with auth token. `ludics notify subscribe` long-polls the incoming topic. Notifications are logged to `journal/notifications.jsonl`.

### Federation

For multi-machine setups (e.g., laptop + always-on Mac Mini), ludics includes a federation system (`src/federation.ts`, ~276 lines):

- **Seniority-based leader election**: First online node (by config order) becomes Mag leader
- **Heartbeat mechanism**: Each node publishes `federation/heartbeats/{node}.json` with timestamp and Mag status
- **Stale timeout**: 900 seconds (configurable via `LUDICS_HEARTBEAT_TIMEOUT`)
- **Leader file**: `federation/leader.json` tracks current leader, election timestamp, term counter
- **Coordination**: Only the leader node runs Mag
- **Network support**: Tailscale hostname detection (`src/network.ts`)

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
  agent-duo:
    enabled: true
  claude-code:
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
  nodes:
    - name: primary
      tailscale_hostname: primary.tail123456.ts.net

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

### Adapter Args Layering (Orchestrated Adapters)

For `agent-duo` / `agent-pair*` starts, ludics composes adapter args from:

1. `adapters.<adapter>.default_args`
2. `projects[].adapter_profiles.<adapter>`
3. Slot `Adapter Args` field
4. Task frontmatter `adapter_args` (highest precedence)

Supported formats:

- shell-style string: `--clarify --plan --work-timeout 5400`
- argv list: `["--clarify", "--plan", "--work-timeout", "5400"]`
- project/task mode map: `{ agent-duo: [...], default: "..." }`

Example:

```yaml
adapters:
  agent-duo:
    enabled: true
    default_args: ["--clarify", "--plan"]

projects:
  - name: ocannl
    repo: lukstafi/ocannl
    adapter_profiles:
      agent-duo:
        args: ["--work-timeout", "5400", "--review-timeout", "2700"]
```

Task override (`tasks/task-042.md`):

```yaml
---
id: task-042
project: ocannl
proposal: docs/concat-einsum.md
adapter_args: ["--work-timeout", "7200"]
---
```

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
├── src/                              # TypeScript source (~22 modules, ~9K lines)
│   ├── index.ts                      # CLI entry point & command dispatcher
│   ├── config.ts                     # Two-tier config loading (YAML)
│   ├── types.ts                      # Shared type definitions
│   ├── state.ts                      # Git-backed state (commit/pull/push)
│   ├── flow.ts                       # Flow engine (ready/blocked/critical/impact)
│   ├── mag.ts                        # Mag lifecycle & queue management
│   ├── notify.ts                     # ntfy.sh integration
│   ├── journal.ts                    # JSONL activity log
│   ├── queue.ts                      # Async request queue for Mag
│   ├── triggers.ts                   # launchd/systemd trigger generation
│   ├── dashboard.ts                  # Dashboard data generation
│   ├── dashboard-server.ts           # HTTP server for dashboard
│   ├── network.ts                    # Hostname/URL helpers (Tailscale)
│   ├── federation.ts                 # Multi-machine leader election
│   ├── init.ts                       # Setup pipeline
│   ├── quote.ts                      # Random quotes
│   ├── slots/
│   │   ├── index.ts                  # Slot CLI + lifecycle (~515 lines)
│   │   ├── markdown.ts               # Parse/write slots.md
│   │   ├── paths.ts                  # Extract slot paths
│   │   ├── preempt.ts                # Stash/restore for preemption
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
│   │   ├── agent-duo.ts              # agent-duo orchestration
│   │   ├── agent-solo.ts             # Single agent orchestration
│   │   ├── agent-claude.ts           # Claude Code (SSH, tmux)
│   │   ├── agent-codex.ts            # Codex (SSH, tmux)
│   │   ├── agent-session.ts          # Shared agent session logic
│   │   ├── orchestrated-adapter.ts   # Base for orchestrated adapters
│   │   ├── peer-sync.ts              # .peer-sync/ file reading
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
├── skills/                           # Mag skills (15 orchestrators + 6 workers)
│   ├── ludics-briefing.md            # Inline (needs strategic context)
│   ├── ludics-draft-proposal.md      # Orchestrator
│   ├── ludics-draft-proposal-worker.md  # Worker (context: fork)
│   ├── ludics-elaborate.md           # Orchestrator
│   ├── ludics-elaborate-worker.md    # Worker (context: fork)
│   ├── ludics-feedback-digest.md     # Orchestrator
│   ├── ludics-feedback-digest-worker.md # Worker (context: fork)
│   ├── ludics-health-check.md        # Inline
│   ├── ludics-launch-session.md      # Inline
│   ├── ludics-learn.md               # Inline
│   ├── ludics-new-quote.md           # Inline
│   ├── ludics-preempt.md             # Inline
│   ├── ludics-read-inbox.md          # Inline
│   ├── ludics-split-task.md          # Inline
│   ├── ludics-suggest.md             # Inline
│   ├── ludics-sync-learnings.md      # Direct fork (context: fork)
│   ├── ludics-verify-completion.md   # Orchestrator
│   ├── ludics-verify-completion-worker.md # Worker (context: fork)
│   └── worker-conventions.md         # Shared worker conventions
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
    └── ...
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
    ├── journal/                   # Daily logs
    │   ├── 2026-01-31.md
    │   └── notifications.jsonl    # Notification history
    ├── mag/                       # Mag's persistent state
    │   ├── context.md             # Current understanding
    │   ├── queue.jsonl            # Request queue
    │   ├── results/               # Request result files
    │   ├── inbox.md               # Async messages from humans
    │   ├── session.state          # Persistent Mag state
    │   ├── session.status         # Current status (ready|waiting|error)
    │   ├── briefing-context.md    # Pre-computed briefing context
    │   └── memory/                # Long-term patterns
    │       └── user-preferences.md
    ├── federation/                # Multi-machine coordination
    │   ├── leader.json            # Current leader
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

**Serving:** Node.js-compatible HTTP server on configurable port (default 7678).

**Dashboard layout (slot tiles + sidebar):**

```
┌──────────────┬──────────────┬──────────────┬────────────────┐
│   Slot 1     │   Slot 2     │   Slot 3     │  Ready Queue   │
│  ■ Active    │  □ Empty     │  ■ Active    │  1. task-101   │
│  task-042    │              │  task-089    │  2. task-067   │
│  agent-duo   │              │  claude-code │                │
├──────────────┼──────────────┼──────────────┤  Project Stats │
│   Slot 4     │   Slot 5     │   Slot 6     │                │
│  □ Empty     │  □ Empty     │  □ Empty     │  Notifications │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

**Features:**
- Slot tiles with task Markdown content, scrollable details
- Project status indicators (priority projects highlighted)
- Dynamic details panel on tile click
- Responsive layout filling the viewport
- Read-only — all control via CLI

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
ludics slot <n> clear [done|abandoned]
ludics slot <n> start          # Start agent session (adapter)
ludics slot <n> stop           # Stop agent session
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
ludics mag inbox               # Show pending messages
ludics mag queue               # Show pending queue requests
ludics mag context             # Pre-compute briefing context file

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

# Federation (multi-machine)
ludics federation status       # Show federation status
ludics federation tick         # Publish heartbeat + run leader election
ludics federation elect        # Run leader election only
ludics federation heartbeat    # Publish heartbeat only

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
9. **Federation for scale** — Seniority-based leader election for multi-machine Mag coordination
10. **Bidirectional messaging via ntfy** — outgoing alerts push to user's phone; incoming topic lets user converse with Mag from any device

## Failure Modes and Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Mag crashes | tmux session exits, health check | Restart Mag; git state is last-committed |
| Git sync conflict | `git pull` fails | Notify user; manual resolution required |
| Trigger doesn't fire | Health check detects stale state | `ludics triggers status` to diagnose |
| ntfy.sh unreachable | curl returns error | Log locally; retry on next trigger |
| Claude API down | Task tool fails | Mag retries or skips, logs warning |
| Task file corrupted | YAML parse fails | Skip file; notify user |
| Federation: leader down | Heartbeat timeout (900s) | Next node by seniority becomes leader |

**Design for recovery:**
- All state changes go through git → crash-safe, auditable
- Adapters are stateless readers (can restart anytime)
- Triggers are idempotent (safe to re-run)
- Preemption uses stash files (recoverable if process crashes)

**What requires manual intervention:**
- Git merge conflicts (by design — human resolves semantic conflicts)
- Slot assignment (configurable: manual vs. auto)
- Starting agent sessions (configurable: manual vs. auto)
