# Changelog

## v0.4.0 — 2026-03-02

Cadence release. Skill context isolation, post-merge followup workflow, session adoption, structured event log, and a wave of notification and dashboard improvements.

### Breaking changes

- **Adapter aliases removed** — Runtime aliases (`claude-code`, `codex`, `agent-solo`, etc.) are dropped from adapter dispatch and orchestration. Only canonical adapter names (`agent-pair-claude`, `agent-pair-codex`, etc.) are accepted. Config files, slot assignments, and task frontmatter must use the canonical names.

### New features

- **Layered adapter args** — Adapter arguments now support four-level precedence: adapter defaults, project profiles, slot `Adapter Args`, and task frontmatter overrides. Shell-style quoted arg parsing replaces whitespace splitting to preserve passthrough flag values.
- **Skill context isolation** — Heavy skills (draft-proposal, elaborate, verify-completion, briefing, health-check, revise-proposal, sync-learnings) are split into orchestrator + worker pairs using `context: fork`, so codebase-heavy operations run in disposable subagent contexts instead of polluting Mag's persistent session. Shared conventions extracted to `worker-conventions.md`.
- **Post-merge followup notifications** — Pull-based followup detection for agent-duo/agent-pair sessions. Notifications offer followup/revise/done actions with pending feedback capture; Mag routes followup launches and task completion.
- **Proactive session-to-slot adoption** — New `/ludics-adopt-sessions` skill matches discovered agent sessions to projects and assigns them to available slots. A dedicated trigger runs session discovery + queues the skill every 5 minutes. Change detection guard prevents duplicate queue entries.
- **Structured event log** — `emitEvent()` writes append-only JSONL across 37 emission points (slot lifecycle, task state changes, Mag decisions, queue ops, GitHub sync, session discovery, federation, notifications). New `ludics events` CLI command with filtering by type, task, scope, source, since, limit.
- **Revise-proposal skill** — Orchestrator/worker pair for iterating on proposals via ntfy "revise" button or CLI. Pending-revise mode arms on tap; the next message becomes feedback. Timeout after 15 min queues revision without feedback.
- **Verify-completion skill** — Extracted from health-check into a dedicated skill with its own fresh Opus context for deep semantic completion detection, follow-up task creation, and notifications for uncertain completions.
- **Proactive slot filling** — Keepalive auto-assigns highest-priority ready elaborated tasks to empty slots and queues draft-proposal.
- **Launch-session skill** — Intercepts ntfy button-tap "Launch agent-X for task-Y" messages and routes them to start sessions in existing or fallback slots.
- **Automatic task completion detection** — Close GitHub issues when local tasks are done/abandoned (reverse sync in `tasks update`), `ludics mag completed <proposal-name>` for external completion signals, health-check semantic completion detection with auto-clear.
- **Abandon notification button** — ntfy notifications include an "abandon" action that clears the slot with abandoned status.
- **Questions in notifications** — Briefing, proposal, and elaboration skills send concise notifications when they surface ambiguities needing user input, enabling phone-based responses.
- **Deterministic task ID migration** — `tasks migrate-ids` (with `--dry-run`) migrates legacy `task-N` files to title-hash IDs and rewrites cross-references.
- **GitHub metadata refresh** — `tasks update` refreshes GitHub-backed task metadata with 3-way title merge preserving local edits while keeping source snapshots current.
- **Dashboard improvements** — Tasks pane with DAG tree view, styled task states, proposal highlighting, proposal detail improvements.
- **Configurable Mag nudge throttle** — `mag.nudge_throttle_seconds` config key (or `LUDICS_NUDGE_THROTTLE_SECONDS` env var) replaces hardcoded 15-minute throttle.
- **Cleanup detached sessions on 3rd sweep**, daily sweeps by default.

### Fixes

- Fixed orchestrated adapter launches: `start`/`stop` commands now run from adapter methods instead of returning suggestions; project cwd resolved from slot path/session with worktree-to-repo normalization.
- Fixed ntfy proposal notification delivery: resolve relative proposal paths using slot repo roots, attach proposals with descriptive filenames, split actions across follow-up messages to respect ntfy action limits.
- Fixed ntfy notification truncation for long messages.
- Fixed PR review issues in followup routing: task-id boundary matching for peer-sync sessions, quoted followup-msg payload.
- Fixed self-invocation for Mag subprocess commands in both bun/node script mode and compiled mode.
- Fixed draft-proposal config path to reference `$LUDICS_STATE_PATH/config.yaml` instead of the pointer file.
- Fixed feedback digest queue throttling.
- Used canonical adapter names in button messages, removing regex normalization.
- Hardened orchestrated launch metadata: derive feature names from proposal paths instead of task IDs, fail fast on missing metadata.
- Fixed followup launch syntax for orchestrated adapters: resolve and inject PR numbers, prefer merged PR detection for agent-duo.
- Fixed followup message flag/key naming (`--followup-msg`).

### Removals

- **`/ludics-analyze-issue` skill removed** — `tasks sync` + `/ludics-elaborate` already covers issue-to-task creation and enrichment.
- **`/ludics-techdebt` skill removed** — Orchestrator, worker, and mag.ts references all cleaned up.
- **"Core philosophy" slogan removed** from skills.

---

## v0.3.0 — 2026-02-19

Checkpoint release. Full rewrite from Bash to TypeScript, project rename, and a wave of Mag autonomy features. Not a stability milestone — a snapshot of fast-moving work.

### Breaking changes

- **TypeScript rewrite** — The entire codebase is now TypeScript on Bun, compiled to a standalone binary via `bun build --compile`. All legacy `lib/*.sh` scripts are deleted. The CLI interface is unchanged but internals are completely new.
- **Project rename** — "pai-lite" is now "Ludics"; "Mayor" is now "Mag". Config paths, launchd plists, systemd units, and template directories all reflect the new names.

### New features

- **Priority project preemption** — Slots support stash/restore: a high-priority project can preempt an occupied slot, and the previous work is restored when done.
- **Proactive Mag** — Direct queue injection for incoming messages (bypasses inbox file), feedback-digest action for agent-duo workflow, and auto-queued draft proposals for slot tasks missing them on keepalive.
- **Draft proposals and split-task** — New `ludics-draft-proposal` skill generates Why/What documents for tasks and notifies via ntfy with mobile action buttons. Multi-concern tasks bail out to `ludics-split-task`, which decomposes and reassigns the parent's slot to the first subtask. CLI: `mag draft-proposal`, `mag split-task`.
- **CLAUDE.md proposal staging** — Agent corrections and CLAUDE.md improvement proposals are appended to `AGENTS_STAGING.md` in the state repo (with per-entry project markers) instead of being lost in ephemeral sync reports. Human curates from staging.
- **Bidirectional ntfy.sh** — Incoming message subscriber enables two-way communication (not just outbound notifications).
- **Task .md as source of truth** — `tasks list` and `tasks show` read directly from Markdown files instead of the YAML intermediary.
- **Enriched task metadata** — `modified` timestamp, `relates_to`/`subtask_of` relationships, automatic `blocked_by` pruning of resolved deps.
- **Config schema validation** — Config keys are validated against a reference schema to catch typos early.
- **Dashboard improvements** — Viewport-filling slot grid, project status overview, scrollable task markdown content in slot tiles.
- **Mag terminal state publishing** — Keepalive publishes Mag terminal state to ntfy for remote visibility.
- **Mag keepalive speedup** — Interval reduced to 1 minute with throttled nudges to avoid noise.
- **Inbox archive-on-consume** — Inbox messages are archived when read, not left in place.
- **Mag files GitHub issues** — Mag can autonomously file GitHub issues for harness bugs and tech debt.
- **Adapter plumbing** — `uses_browser` and `adapter_args` fields; solo adapter migrated to pair adapters; agent-duo `modeFilter`.
- **`ludics quote`** — Girard quotes collection, because why not.

### Fixes

- Fixed missing `LUDICS_*` env vars for Mag skill sessions.
- Fixed repeated preemption queuing race condition.
- Fixed `slot_get_field` awk regex and stale session index fallback.
- Skip merged/done/abandoned tasks in needs-elaboration check.
- Reworked Claude Code session discovery: JSONL-primary with index as metadata cache.

### Removals

- **Stalled work detection removed** from `flow critical` and skills — was producing more noise than signal.
- **Legacy Bash scripts deleted** — all `lib/*.sh` files removed after TypeScript migration.

---

## v0.2.0 — 2026-02-11

Second release. Focus on robustness, better Mag workflows, and task management improvements.

### New features

- **Task merging and duplicate detection** — `flow duplicates` finds near-duplicate tasks; `tasks merge` combines them with dependency rewiring.
- **Content-fingerprint task IDs** — Watch-path tasks now use 8-char md5 of normalized text (`watch-<path>-<fingerprint>`) instead of line numbers, so IDs survive file edits. Old IDs are migrated automatically.
- **Cross-reference migration** — `tasks migrate-refs` updates `blocks`/`blocked_by` references after ID changes.
- **Pervasive session discovery** — `sessions list` scans tmux, screen, VS Code, and `.peer-sync/` directories to find all active agent sessions, enriching slot data.
- **Mag inbox** — Async message channel (`mag inbox send/read`) for non-blocking communication with Mag session. Briefing and health-check skills read the inbox automatically.
- **Briefing context pre-computation** — Bash pre-computes slot state, ready queue, and critical items before invoking the briefing skill, reducing token usage.
- **Proactive slot management** — Mag briefing now includes slot occupancy analysis and reassignment suggestions.
- **Dashboard briefing tab** — New tab renders the latest briefing as formatted Markdown alongside terminals and task views.
- **Lazy dashboard server** — Dashboard HTTP server auto-starts via launchd/systemd on first `dashboard open` and stops when idle.
- **Mag keepalive nudge** — When the keepalive trigger fires, if Mag queue is non-empty the nudge includes a timestamp and pending item count.
- **CLAUDE.md template for harness directories** — `ludics init` deploys a CLAUDE.md with project conventions and upstream-PR workflow into each harness directory.

### Fixes

- **Flow engine glob** — Fixed task file matching to include all `*.md` files with YAML frontmatter, not just `task-*.md`.
- **`printf` with dash-prefixed strings** — `log_info`/`log_error` no longer fail when the message starts with a dash.
- **Mag keepalive timestamp** — Nudge messages now include the current time for log traceability.
- Tiny fixes to task elaboration and slot assignment workflows.

### Other changes

- **Mag queue path** — `queue.jsonl` and `results/` moved from `harness/tasks/` to `harness/mag/` for clearer separation.
- **Removed `/ludics-context-sync` skill** — Redundant with existing automation; removed to reduce surface area.
- **Test script** — Added `tests/test.sh` with shellcheck linting and smoke tests for core commands.
- **Archived PLAN.md** — Original v0.1 plan moved to `docs/PLAN-v0.1-archive.md`.

---

## v0.1.0 — 2026-02-08

First release of ludics: a lightweight personal AI infrastructure for humans working with AI agents.

### What works well (tested in daily use)

- **macOS launchd integration** — Startup, periodic sync, and Mag keepalive triggers install and fire reliably. Templates include proper PATH for Homebrew Bash 4+.
- **Task generation from sources** — GitHub issues (via `gh`), Markdown checkboxes, and watch rules on file changes all aggregate into `tasks.yaml` and convert to individual `task-*.md` files with YAML frontmatter.
- **Briefings** — Morning briefing generation gathers slot state, ready queue, critical items, stalled work, and approaching deadlines into a Markdown report. Same-day briefings are amended rather than regenerated. Auto-committed to the state repo.
- **Elaboration** — High-level tasks are expanded into detailed specs with subtasks, file references, edge cases, and test suggestions. Proactive elaboration queues unprocessed ready tasks automatically.
- **Autonomous Mag operation** — A persistent Claude Code session in tmux with queue-based communication. Automation writes requests to `mag/queue.jsonl`; the stop hook drains the queue when Claude goes idle. Skills are invoked via tmux send-keys. ttyd provides web access.

### What's included but not yet battle-tested

These components are implemented and may work, but have seen little to no real-world use. Expect rough edges.

- **Slot system** — The 6-slot model for tracking parallel work: assign, clear, start, stop, notes. Adapter state refresh. The data model is there; the workflow around it hasn't been exercised.
- **Dashboard** — HTML5 + JS web UI with slot grid, task views, flow visualization, and terminal iframes. JSON generation from Markdown state works. The frontend renders but hasn't been polished.
- **Adapters** — Seven adapters (agent-duo, agent-solo, claude-code, claude-ai, chatgpt-com, codex, manual) following a consistent `read_state/start/stop` interface. Only claude-code has been used meaningfully.
- **Linux systemd support** — Service and timer unit templates mirror the launchd functionality. Untested on actual Linux systems.
- **Federation** — Multi-machine coordination with seniority-based leader election, heartbeats, and Tailscale networking. Implemented but not deployed.
- **Notification system** — 3-tier ntfy.sh integration (pai/agents/public) with local journal logging. Wiring is in place; delivery hasn't been verified end-to-end.

### Full feature list

#### Core CLI (`bin/ludics`)
- 35+ commands across slots, tasks, flow, mag, notify, dashboard, state, journal, network, federation, and setup
- Self-installing (`ludics init`) with hooks, triggers, and skills auto-deployment
- `ludics doctor` for environment validation

#### Task management
- Multi-source aggregation: GitHub issues, README checkboxes, file watch rules
- YAML frontmatter format: id, title, project, status, priority (A/B/C), deadline, dependencies, effort, context, adapter
- Dependency tracking with `blocks`/`blocked_by` and cycle detection via `tsort`
- Deterministic IDs: `gh-<repo>-<number>` for issues, `watch-<path>-<fingerprint>` for file sources (8-char md5 of normalized text; migrates old line-number-based IDs automatically)

#### Flow engine
- `flow ready` — priority-sorted, dependency-filtered, deadline-aware queue
- `flow blocked` — dependency graph of blocked tasks
- `flow critical` — approaching deadlines + stalled work (>7 days in-progress)
- `flow impact` — what completing a task unblocks
- `flow context` — active slots per context tag
- `flow check-cycle` — topological validation of dependency graph

#### Mag system
- Persistent Claude Code session in tmux with ttyd web access
- Queue-based communication (`queue.jsonl` + `results/<id>.json`)
- Stop hook fires on Claude idle to drain the queue
- Keepalive trigger (every 15 min) restarts Mag if needed
- Institutional memory: corrections, tools, workflows, project-specific knowledge

#### Skills (9 total)
- `ludics-briefing` — morning briefing with same-day amending
- `ludics-elaborate` — task-to-spec expansion
- `ludics-suggest` — next-task recommendations
- `ludics-analyze-issue` — GitHub issue to actionable task
- `ludics-health-check` — stalled work detection
- `ludics-learn` — record corrections to institutional memory
- `ludics-sync-learnings` — consolidate corrections into knowledge files
- `ludics-techdebt` — technical debt tracking

#### Triggers
- macOS launchd: startup, periodic sync, morning briefing, Mag keepalive
- Linux systemd: equivalent service + timer units
- Watch rules: file change triggers for task sync
- `ludics triggers install/status/uninstall`

#### Implementation
- Pure Bash 4+ with CLI tools: `yq`, `jq`, `tsort`, `gh`, `tmux`, `ttyd`
- Git-backed state in a separate private repo
- Config via YAML (`yq eval`), no awk parsing
- POSIX-compatible where possible

### Known issues

- `declare -gA` in `slots.sh` requires Bash 4+; macOS ships Bash 3. Launchd plists include `/opt/homebrew/bin` in PATH to find Homebrew's Bash.
- The installed copy at `~/.local/ludics/` is a file copy, not a symlink. Changes to the working copy must be manually re-installed.
- `[[ condition ]] && echo` at end of functions is unsafe under `set -e`; mitigated throughout but worth noting for contributors.
