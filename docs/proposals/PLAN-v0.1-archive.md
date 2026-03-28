# ludics Implementation Plan

This document tracks implementation tasks based on the architecture described in [ARCHITECTURE.md](ARCHITECTURE.md) and the current repo state.

## Legend

- [ ] Not started
- [~] Partially implemented
- [x] Completed

---

## 1. Core Infrastructure

### 1.1 CLI and Library (lib/*.sh)

- [x] `lib/common.sh` - Core utilities, config parsing, state repo functions
- [x] `lib/slots.sh` - Slot management (list, show, assign, clear, start, stop, note)
- [x] `lib/tasks.sh` - Task aggregation from GitHub issues and READMEs
- [x] `lib/flow.sh` - Flow engine (ready, blocked, critical, impact, context, check-cycle)
- [x] `lib/triggers.sh` - launchd/systemd trigger installation
- [x] `lib/notify.sh` - ntfy.sh notification system (pai, agents, public tiers)

### 1.2 Queue-Based Communication

- [x] `ludics_queue_request()` - Queue requests for Mag
- [x] `ludics_queue_pop()` - Read and remove requests (for stop hook)
- [x] `ludics_queue_pending()` - Check if queue has requests
- [x] `ludics_wait_for_result()` - Wait for Mag's result files
- [x] `ludics_write_result()` - Write result files (for Mag)

### 1.3 State Repository Management

- [x] `ludics_state_commit()` - Commit changes to state repo
- [x] `ludics_state_push()` - Push to remote
- [x] `ludics_state_sync()` - Commit and push
- [ ] `ludics_state_pull()` - Pull latest state (with safe conflict handling)
- [ ] `ludics state sync` (or `ludics sync`) - Pull before writes (slots/tasks/notify)

### 1.4 Slot/Task Integration + slots.md Parity

- [ ] Standardize `slots.md` format to match ARCHITECTURE (Process/Task/Mode/Session/Terminals/Runtime/Git)
- [ ] `slot assign` should accept task ids and update task files (status, slot, started, adapter)
- [ ] `slot clear` should optionally mark task done/abandoned and clear slot field in task
- [ ] `slot start` should parse slot metadata (Mode/Task/Session/Project) and pass to adapters
- [ ] `slot set-mode` / `slot edit` command to avoid manual `slots.md` edits
- [ ] `slots refresh` to read adapter state and update `slots.md` runtime fields
- [ ] Decide hardcoded 6 slots vs configurable; align code, templates, docs

---

## 2. Adapters

### 2.1 Implemented Adapters

- [x] `adapters/agent-duo.sh` - Full implementation (read_state, start, stop, watch_phase, get_status)
- [x] `adapters/claude-code.sh` - Full implementation (read_state, start, stop, doctor, restart, signal)
- [x] `adapters/claude-ai.sh` - Bookmark + metadata tracking (add/list/update/remove)
- [x] `adapters/codex.sh` - tmux/API sessions + ttyd + doctor/restart
- [x] `adapters/chatgpt-com.sh` - Bookmark + metadata tracking (add/list/update/remove)
- [x] `adapters/agent-solo.sh` - agent-duo-compatible solo workflow support
- [x] `adapters/manual.sh` - Human/manual tracking with notes + archive

### 2.2 Adapter Integration Gaps

- [ ] `ludics adapter <name> <action>` CLI to expose adapter helpers (add/list/update/doctor/restart/start-ttyd/list-sessions)
- [ ] Normalize adapter start/stop/read_state signatures for slot-driven usage
- [ ] Add adapter-facing docs (`docs/ADAPTERS.md`) and usage examples

### 2.3 Adapter Monitoring (Automation)

- [ ] Poll `.peer-sync/` and tmux to refresh `slots.md` runtime data
- [ ] Log phase changes to journal + notify (tiered priorities)
- [ ] Optional launchd/systemd trigger or loop for periodic adapter monitoring

---

## 3. Mag System

### 3.1 Mag Request Queue (CLI)

- [x] `ludics mag briefing|suggest|analyze|elaborate|health-check` queue requests
- [x] `ludics mag queue` - Show pending requests

### 3.2 Mag Session Management

- [ ] `ludics mag start` - Start Mag tmux session with Claude Code
- [ ] `ludics mag stop` - Stop Mag session gracefully
- [ ] `ludics mag status` - Show Mag session status
- [ ] `ludics mag attach` - Attach to Mag tmux session
- [ ] `ludics mag logs` - View Mag session logs

### 3.3 Stop Hook

- [x] `templates/hooks/ludics-on-stop.sh` - Template for Claude Code stop hook
- [x] `ludics init` installs the stop hook to `~/.local/bin/ludics-on-stop`
- [x] Stop hook delegates to `ludics mag queue-pop` for action mapping

### 3.4 Mag Skills (Claude Code skill files)

Architecture describes these Mag-invokable skills:

- [ ] `/ludics-briefing` - Generate morning briefing with strategic suggestions
- [ ] `/ludics-suggest` - Suggest next tasks based on flow state
- [ ] `/ludics-analyze-issue <repo> <issue>` - Analyze GitHub issue, create task file
- [ ] `/ludics-elaborate <task-id>` - Elaborate task into detailed specification
- [ ] `/ludics-health-check` - Detect stalled work, approaching deadlines
- [ ] `/ludics-learn` - Update institutional memory from corrections
- [ ] `/ludics-sync-learnings` - Consolidate scattered learnings into structured knowledge
- [ ] `/ludics-techdebt` - End-of-day/week technical debt review (ancillary)

**Implementation approach:**
Skills should be Markdown files in `skills/` directory that can be installed to `~/.claude/skills/` or used via a custom skills path. Format follows Claude Code skill specification.

### 3.5 Mag Memory System

- [ ] Create `templates/mag/` directory structure
- [ ] `mag/context.md` - Current operating context for Mag
- [ ] `mag/memory/corrections.md` - Recent corrections from user feedback
- [ ] `mag/memory/corrections-archive.md` - Archived/processed corrections
- [ ] `mag/memory/tools.md` - CLI tool gotchas and patterns
- [ ] `mag/memory/workflows.md` - Process patterns
- [ ] `mag/memory/projects/*.md` - Project-specific knowledge

### 3.6 Mag Outputs + Briefing Integration

- [ ] `ludics briefing` should queue Mag, wait for result, and render `briefing.md`
- [ ] `ludics status` should include flow summary (ready/critical) and Mag status
- [ ] `ludics mag wait <id>` helper to read result files

---

## 4. Web Dashboard

### 4.1 Dashboard Files

- [x] `templates/dashboard/index.html` - Main dashboard page
- [x] `templates/dashboard/style.css` - Dashboard styles
- [x] `templates/dashboard/dashboard.js` - Dashboard logic

### 4.2 Dashboard Data Generation

- [ ] `ludics dashboard generate` - Generate JSON data files from state
  - [ ] Generate `data/slots.json` from slots.md
  - [ ] Generate `data/ready.json` from flow ready
  - [ ] Generate `data/notifications.json` from journal/notifications.jsonl
  - [ ] Generate `data/mag.json` from Mag session status

### 4.3 Dashboard Serving

- [ ] `ludics dashboard serve` - Start local HTTP server for dashboard
- [ ] `ludics dashboard install` - Copy dashboard to state repo

### 4.4 Terminal Grid View

Architecture describes a separate terminal grid view:

- [ ] `templates/dashboard/terminals.html` - 3x2 grid of ttyd terminal iframes
- [ ] Tab support for slots with multiple terminals (agent-duo: orchestrator, claude, codex)
- [ ] Navigation between dashboard and terminal grid views

---

## 5. Notification System Enhancements

### 5.1 Current Implementation

- [x] Three-tier notification (pai, agents, public)
- [x] Local journal logging
- [x] `notify_recent` to show recent notifications

### 5.2 Missing Features

- [~] Priority-based notification levels from config (parser exists, not wired to events)
- [ ] Auto-publish filter for public notifications
- [ ] CI failure integration (`adapters/github-actions.sh`)

---

## 6. Installation and Setup

### 6.1 Current `ludics init`

- [x] Install ludics to `~/.local/ludics`
- [x] Create symlink in `~/.local/bin`
- [x] Copy example config to `~/.config/ludics/config.yaml`
- [x] Clone state repo if configured
- [x] Initialize harness directory structure

### 6.2 Missing Init Features

- [x] Install stop hook via `ludics init --hooks`
- [ ] Offer to install Mag skills to `~/.claude/skills/`
- [ ] Create Mag memory directory structure in harness
- [ ] Copy dashboard files to state repo's `dashboard/` directory
- [ ] Validate required tools (yq, jq, gh, tmux) with helpful messages

### 6.3 Dependency Checks

- [ ] `ludics doctor` - Comprehensive health check
  - [ ] Check for required commands (yq, jq, gh, tmux, tsort)
  - [ ] Check for optional commands (graphviz/dot, ntfy-cli)
  - [ ] Check Claude Code installation
  - [ ] Check state repo accessibility
  - [ ] Check Mag session status

---

## 7. Configuration Enhancements

### 7.1 Current Config

- [x] state_repo, state_path
- [x] slots.count
- [x] projects list (name, repo, readme_todos, issues)
- [x] adapters (agent-duo, claude-code, claude-ai)
- [x] triggers (startup, sync with interval and action)

### 7.2 Missing Config Sections

Per architecture, these config sections are described but not implemented:

```yaml
mag:
  enabled: true
  backend: tmux-ttyd
  session: ludics-mag
  ttyd_port: 7690
  autonomy_level:
    analyze_issues: auto
    elaborate_tasks: auto
    infer_dependencies: auto
    suggest_priorities: suggest
    assign_to_slots: manual
    start_sessions: manual
  schedule:
    briefing: "08:00"
    health_check: "every 4h"
    analyze_repos: "on_change"

notifications:
  provider: ntfy
  topics:
    pai: user-pai
    agents: user-agents
    public: user-public
  priorities:
    briefing: 3
    health_check: 3
    deadline_7days: 4
    deadline_3days: 5
    stall_detected: 4
    critical_alert: 5
  public_filter:
    auto_publish:
      - release_completed
      - paper_accepted
    never_publish:
      - debugging_info
      - private_deadlines
```

Additional alignment tasks:

- [ ] Decide whether to remove `slots.count` (hardcoded 6) or update ARCHITECTURE to allow config
- [ ] Extend config templates to include `mag` and `notifications` sections
- [ ] Add parser helpers for `mag.*` fields (backend/session/schedule)

---

## 8. Flow Engine Enhancements

### 8.1 Current Implementation

- [x] `flow ready` - Priority-sorted ready tasks
- [x] `flow blocked` - Tasks and their blockers
- [x] `flow critical` - Deadlines, stalled work, high-priority
- [x] `flow impact <id>` - What task unblocks
- [x] `flow context` - Context distribution across slots
- [x] `flow check-cycle` - Dependency cycle detection

### 8.2 Missing Features

- [ ] Graph visualization with graphviz (`flow graph` → generates DOT file)
- [ ] Generate `agenda.md` flow summary in harness
- [ ] Recurring tasks support (recurrence field that generates new tasks)

---

## 9. Triggers and Automation

### 9.1 Current Triggers

- [x] Startup trigger (launchd RunAtLoad / systemd oneshot)
- [x] Sync trigger (launchd StartInterval / systemd timer)

### 9.2 Missing Triggers

- [ ] Morning briefing trigger (specific time, e.g., 08:00)
- [ ] Repo change trigger (launchd WatchPaths)
- [ ] Health check trigger (periodic, e.g., every 4h)
- [ ] `ludics triggers status` - Show installed trigger status
- [ ] `ludics triggers uninstall` - Remove installed triggers

---

## 10. CI Integration (Ancillary)

- [ ] `adapters/github-actions.sh` - Poll for CI failures
- [ ] Deduplication via `ci-failures-seen.txt`
- [ ] Queue `analyze-ci-failure` requests for Mag

---

## 11. Read-Only Slot Mode (Ancillary)

- [ ] Support `mode: read-only` in slot assignment
- [ ] Document conventions for analysis/exploration slots

---

## 12. Journal + Audit Trail

- [ ] Daily journal files in `journal/YYYY-MM-DD.md`
- [ ] Append slot events (assign/clear/start/stop) to journal
- [ ] Append adapter phase changes + Mag summaries to journal

---

## Implementation Priority

### Phase 1: Slot/Adapter Parity + Briefing Loop
1. Slots/task integration and `slots.md` format parity
2. `slots refresh` + adapter monitoring basics
3. `ludics briefing` queue + wait + notify integration

### Phase 2: Core Mag Functionality
1. Mag session management commands (start, stop, status)
2. Stop hook installation in `ludics init`
3. Basic Mag skills (/ludics-briefing, /ludics-suggest, /ludics-health-check)

### Phase 3: Dashboard Completion
1. `ludics dashboard generate` command
2. `ludics dashboard serve` command
3. Terminal grid view

### Phase 4: Configuration + Reliability
1. Mag + notifications config section parsing + templates
2. `ludics doctor` command
3. Trigger schedule expansion (morning/health/watchpaths)
4. State repo pull/sync safeguards

### Phase 5: Ancillary Features
1. CI failure integration
2. /ludics-techdebt skill
3. Graph visualization + agenda generation
4. Read-only slot mode
5. Journal/audit trail
