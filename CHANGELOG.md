# Changelog

## v0.7.0 — 2026-04-08

Federation-to-cluster rename, HTTP transport for multi-machine worker writes, project health test monitoring, upstream_repo semantics, and orchestration workflow improvements.

### Breaking changes

- **Federation → Cluster rename** — With leader election removed in favor of a fixed controller machine (`role: "leader"` in config), the "federation" terminology no longer applies. Renamed to "cluster" throughout: config keys, CLI commands (`ludics cluster status/tick/heartbeat`), HTTP paths (`/cluster/*`), source files (`cluster.ts`, `cluster-http.ts`). Old `federation` config keys are read as legacy fallback in `networkMode()`.
- **`staging_repo` → `upstream_repo`** — Semantic inversion: `repo` now means the working repo (fork agents work in), `upstream_repo` is the forwarding target. All identifiers renamed (`stagingRepo` → `upstreamRepo`, `isStaging` → `hasUpstream`, etc.). Template renamed: `staging-final-merge.md` → `upstream-final-merge.md`. No migration — drain slots before deploying.

### New features

- **Cluster HTTP transport** — Worker nodes now write state changes (journal, events, orchestration state, task updates, slot updates) via HTTP to the controller instead of git push. New endpoints in `cluster-http.ts` (~657 lines). Intent flow is pure-pull: controller stores intents in memory, workers poll via HTTP. `slot-intents.ts` deleted. `statePush` simplified — squash/rebase/conflict machinery removed. Commits reduced to natural checkpoints (health-check, shutdown, handoff).
- **Static controller role** — Leader election removed. Controller is determined statically by `role: "leader"` in machine config. `leader.json`, `computeController()`, `updateLeader()` eliminated. `clusterTick()` simplified to heartbeat-only.
- **Project health test suite monitoring** — Optional `test_command` per project (auto-detected from `dune-project`, `bun.lockb`, `package.json`, `Makefile`). New `src/health.ts` (~166 lines) runs tests during night window or every 24h. Results stored in `mag/test-health.json`. Auto-files priority-A fix tasks on failure with content-fingerprint dedup. CLI: `ludics health run-tests [--project=NAME] [--force]`.
- **Deferred slot artifact cleanup** — Slot artifact cleanup (worktrees, peer-sync) deferred by 25–48h after task completion, providing a post-mortem inspection window.
- **Project-level requirements matching** — Slot assignment now matches project-level `requirements` in addition to task-level requirements.
- **Final-merge shortcut** — After coder addresses PR review comments, the orchestration can shortcut directly to final-merge when the comment poll is fresh and Codex review is resolved.
- **Test baseline step** — Orchestration templates include a test baseline step to capture pre-work test failures before agents begin coding.
- **Unified health-check schedule** — Health-check trigger unified to a wall-clock 6h cycle (at 02:20, 08:20, 14:20, 20:20 local time), combining briefing and health-check cadences.
- **Pre-done acceptance criteria checklist** — Coder work template includes a checklist of acceptance criteria to verify before marking work as done.

### Fixes

- **Slotted tasks excluded from ready queue** — Tasks already assigned to a slot no longer appear in `flow ready`.
- **Auto-start ambiguity filter** — Tightened to exclude negated signals (e.g. "not ambiguous" no longer triggers deferral).
- **Artifact fallback scoped** — Artifact fallback logic now applies only to artifact-gated phases; nudge includes status-write command.
- **Init validation** — Fixed init validation for same-tail repos; issue sync uses `upstream_repo`.
- **Final-merge gating** — Final-merge shortcut gated on fresh comment poll and resolved Codex review.
- **Settled agent done detection** — Treat settled agent as done when artifact exists after repeated nudges.
- **Async slotStart race** — `await slotStart` in `maybeAutoStartSlots` to prevent "Session Started" race condition.
- **JSON queue handling** — Replaced brittle JSON template strings with typed `JSON.stringify` in queue operations.
- **Health check stdout** — Handle blank `test_command` and avoid stdout corruption in health check.
- **Approve handler guard** — Approve handlers now only transition tasks with `deferred` status.
- **Tmux capture extraction** — Made tmux capture entry extraction provider-specific.
- **Stale lifecycle cleanup** — Clear stale lifecycle/fingerprint on `pr-comments` entry and `skipToPhase`.
- **Worker-safe slots** — Added worker-safe annotations to slots module, preventing workers from writing to local harness.
- **Guard/dedup hardening** — Hardened guard/dedup functions against JSON shape mismatches.
- **prUrl validation** — Validate `prUrl` is an actual URL before skipping `pr-create` phase.
- **ttyd auto-restart** — Auto-restart dead ttyd processes during orchestration polling.
- **Large Codex prompts** — Scale paste delay and verify Enter for large Codex prompts.
- **Worker intent persistence** — Persist intents to runtime files instead of process-local memory.
- **Worker state isolation** — Worker `slotStart`/`slotsRefresh` no longer write to local harness.
- **State push simplification** — Simplified `statePush` by removing squash/rebase/conflict machinery.
- **Worker fresh state** — Worker intents use fresh controller state; slot runtime updates via HTTP.
- **Freshness gate** — Added freshness gate to `isAgentDone` settled branch; fixed `skipToPhase` lifecycle cleanup.
- **Case-insensitive project matching** — `findProjectConfigByName` now case-insensitive.

### Refactoring

- Renamed `federation` to `cluster` throughout codebase (files, symbols, config, HTTP paths, CLI).
- Removed leader election logic; simplified to static controller role.
- Extracted `safeSyncOutput` helper and migrated all `Bun.spawnSync` callers.
- Extracted `validateSignal` pure function from federation HTTP handling.
- Extracted config CLI to `config-cli.ts` with `findProjectConfig` helper.
- Deleted dead code: `slot-intents.ts`, `worker-signal.ts`, squash-rebase machinery, excess `stateCommit()` calls.
- Pure-pull intent flow replaces file-based cross-node intent files.
- Replaced `deferred_launch`/`approved` fields with unified `status: deferred`.
- Added `PROPOSAL_INSTRUCTION` to 4 additional orchestration templates.

### Tests

- Regression tests for `writeResult` and queued-preemption scan.
- Rendering tests for 4 newly updated orchestration templates.
- Federation HTTP test coverage with `validateSignal` extraction.
- Freshness gate and `skipToPhase` lifecycle tests.
- Replaced `mock.module` with `spyOn` in tests to prevent mock leakage.
- Documented safe Bun `mock.module` pattern.

### Removals

- **`slot-intents.ts`** — Replaced by HTTP-based intent flow in `cluster-http.ts`.
- **`worker-signal.ts`** — Worker signaling now via HTTP transport.
- **Leader election** — `leader.json`, `computeController()`, `updateLeader()`, `clusterElect()` removed. Static `role: "leader"` config replaces dynamic election.
- **`staging_repo` config key** — Renamed to `upstream_repo` with inverted semantics.
- **State push complexity** — Squash-before-rebase strategy and conflict machinery removed from `statePush`.

## v0.6.0 — 2026-04-06

Hardening release. Hierarchical duo mode with cross-slot merge coordination, federation intent files replacing SSH dispatch, deferred launch approval flow, hung agent detection, PR conflict auto-resolution, robust state sync, and CLI ergonomics.

### New features

- **Hierarchical duo mode** — `--duo` now expands into two paired slots via `expandDuoSlots()` with swapped coder/reviewer roles. Cross-slot merge coordination (`bothSlotsReadyForMerge()`, `isMergeCoordinator()`) ensures both slots synchronize at merge time. New `forward-pr` phase and `duoPeerSlot`/`duoAwaitingPeer` state fields. Legacy duo-only templates removed.
- **Federation intent files** — SSH remote dispatch replaced with state-repo intent files (`federation/slot-intents/slot-{N}.json`). Controller writes intents, worker nodes consume and clear them. 10-minute TTL, one-shot command pattern.
- **Worker keepalive** — Separated from federation trigger. Worker nodes independently detect dispatched-but-lost slots (proposal exists, no active session) and auto-start them via intent consumption.
- **Deferred launch approval** — Two-stage gate for task launches: `deferred_launch` flag set when auto-start defers to user, dashboard tile with View/Approve/Abandon buttons. On approve, `approved: true` triggers keepalive auto-start. Proposal revision clears approval.
- **Hung agent detection** — Three-branch detection: running-hung (done + pane static >180s), dispatch-hung (dispatched + static >90s), idle-running-hung (running + static >180s for prompt injection failures). Escalating nudges: Enter → "Continue." → re-dispatch → force-settle. Unified paste-buffer prompt injection across all providers.
- **PR merge conflict detection** — During `pr-comments` phase, tracks PR mergeable state transitions. On conflict detection, redispatches coder with `pr-conflict-resolve.md` template for rebase and resolution.
- **Process-suggestions skill** — `/ludics-process-suggestions` extracts actionable items from `REQUEST_CHANGES` review artifacts. Auto-queued when retrospective has request_changes reviews.
- **Atomic queue pop** — `ludics mag queue pop one` and `ludics mag queue pop all` for reliable queue consumption. Gated on `federationIsController`.
- **Adapter preserve-state** — `stop({ preserveState: true })` skips destructive cleanup (worktrees, peer-sync, threads). Used by `slot mode` toggle for switching adapter without losing orchestration state.
- **Dashboard tiles** — Deferred Launch tile, Unanswered Questions tile (`has_questions` flag), adapter toggle button on slot tiles. Shared `FilteredTaskTileConfig` abstraction for filtered-task tiles.
- **Auto-commit round prefix** — Orchestrated agent commits use `[round N]` prefix format.
- **Auto-queue feedback-digest** — Queued during briefing precompute, scoped to briefing trigger.
- **Staging repo support** — `staging_repo` field in project config, plumbed into skill contexts and PR creation templates.
- **Dashboard shared markdown renderer** — Extracted `markdown.js` from duplicated `markdownToHtml()` calls.
- **Direct orchestration flag parsing** — Slot assign accepts orchestration flags (`--duo`, `--pair`, etc.) directly.
- **Task hardware requirements** — Tasks can specify `requirements` frontmatter with optional `os` and `gpu` fields. Machine selection filters federation machines by these capabilities before applying `always_on`/load-balance sorting. Assignment is blocked when no federation machine matches; start is blocked when the assigned machine is offline. Dashboard shows offline machines with a red badge.
- **Codex stop hook** — Codex adapter now supports stop hook for orchestration state transitions, matching tmux-based adapters.
- **Queue hold/resume CLI** — `ludics queue hold`, `ludics queue resume`, `ludics queue status` commands for controlling automatic slot assignment from the command line.
- **Config proposals-path** — `ludics config proposals-path <project>` CLI subcommand for resolving a project's proposals directory.
- **Dashboard pendingAction badge** — Worker signals include machine field; dashboard renders a pending-action badge when a worker signal is active.
- **Tmux capture at round end** — Tmux pane output is captured at each round boundary for retrospective transcripts.
- **Auto-fill orchestration flags** — `slotStart` auto-fills missing orchestration flags (defaulting to small effort) instead of throwing, making bare `slot start` work without explicit `--pair`/`--duo`.

### Fixes

- **Machine selection always_on preference** — `selectMachineForSlot` no longer skips the current machine when it is `always_on`, fixing a bug where the always-on controller dispatched all work to a non-always-on laptop.
- **Robust state sync** — Recover stuck rebases, squash-before-rebase strategy, sort JSONL merges to prevent conflicts. Replace stash-pop with commit-before-pull in `statePull`.
- **Federation hostname resolution** — Improved hostname matching for non-Tailscale contexts, fallback to federation machine host, find Tailscale CLI in macOS app bundle path. Run federation tick before trigger install in init.
- **Terminal host resolution** — Use per-slot Machine field instead of local hostname; resolve via federation config for proper FQDN.
- **Orchestration resilience** — Orchestration runners survive parent exit via `setsid` detachment. Mark slot as Interrupted on setup failure instead of clearing. Slot resume falls back to `slotStart` for interrupted slots. Clean stale orch state before fallback. Reset turnLifecycle and phaseDispatched on resume.
- **Plan-merge skip** — Skip plan-merge phase when only one plan file exists (unless it's the coder's own plan).
- **PR workflow** — Gate `pr-create → pr-comments` transition on `prUrl` being set. Derive PR base branch dynamically. Don't dispatch pr-comments prompt until comments arrive. Look back 10min for comments from prior phases.
- **Review filename validation** — Consolidated into shared `review-files.ts` module. Validate agent name to keep writer/parser aligned. Select latest round per review type before filtering by verdict.
- **State sync safety** — Commit queue-hold state change so sync doesn't revert it. Catch spawn exceptions in `maybeGit` to prevent cleanup crashes.
- **Shell state reset** — Reset shell state before re-booting agent CLI on tmux resume.
- **Dashboard fixes** — Remove fallback guessing in terminals tab, show explicit errors. Resolve slot machine host for tile terminal links.
- **LaunchAgent fixes** — Use modern `launchctl` API and kill stale mag on non-controller nodes. Daemonize ttyd with nohup.
- **Duo mode fixes** — Strip flag values in duo expansion, remove legacy startup path. Move `clearDuoPeerLink` after stop succeeds. Don't inject `--pair` over `-A` mode flag.
- **Various** — Proposal revision clears approved flag. Scope feedback-digest auto-queue to briefing trigger. Re-check federation on mag keepalive path. Undelete soft-deleted t3code threads on slot resume. Prefix non-orchestrated thread titles with slot number.
- **Dead orchestrator scope** — `maybeResumeDeadOrchestrators` skips slots assigned to remote federation machines.
- **Dashboard stateMarkDirty** — Fixed state not being marked dirty before checkpoint in queue hold/resume; extracted `setQueueHold` helper.
- **Zero-pad round numbers** — Round numbers in capture filenames are zero-padded for correct lexicographic sorting; extracted `parseCaptureHeader` helper.
- **Per-agent threadId for tmux captures** — Retrospective tmux captures use per-agent threadId instead of shared session id.
- **Tolerate duplicate YAML keys** — Task frontmatter parsing no longer crashes on duplicate keys.
- **Proposals-path resolution** — Use directory check in autodetection; match project config by both name and repo tail.
- **enterPhase fingerprint guard** — Restored fingerprint guard for `skipToPhase` edge case that could cause phase re-entry.
- **planFilePath type safety** — Replaced unsafe Function cast with typed branch in `planFilePath`.
- **Epoch TTL defense-in-depth** — Reinstated epoch TTL alongside machine validation to prevent stale dispatch acceptance.
- **ttyd survives launchd keepalive** — Use `setsidWrap` for ttyd so it isn't killed when launchd restarts the keepalive agent.
- **Absolute lsof path** — Use absolute path for `lsof` in `slotResume` to fix launchd PATH resolution.
- **Capture file sort order** — Sort capture files by round number for correct dedup hash lookup.
- **Heal stale blocked_by** — Heal stale `blocked_by` links before reconciling blocked status.

### Refactoring

- Consolidated review filename logic into shared `review-files.ts` module.
- Extracted shared tile abstraction (`FilteredTaskTileConfig`) for dashboard filtered-task tiles.
- Extracted `findPlanFiles` helper and `orchestrator-conventions.md` shared boilerplate.
- Refactored `computeSlotLiveness` to take a `SlotLivenessContext` struct.
- Flattened `SkillContext` into `Record<string,string>` with auto-inject and dev warnings.
- Removed `focusProject()` in favor of `priority: true` on project config.
- Worker/orchestrator skill response format converted to JSON blocks.
- Pure `evaluateAutoStartDecision` function, audit of legacy adapter refs.
- Extracted `paginatedGhApiCount` helper with `per_page=100` for GitHub API pagination.
- Extracted `planFilename` helper to consolidate plan file path patterns.
- Extracted `tryQueueFeedbackDigest` helper to centralize dedup+cooldown+queue logic.
- Extracted `validateDoneStatus` helper; simplified `enterPhase` skip-done guard.
- Consolidated `PROPOSAL_INSTRUCTION` across orchestration templates.
- Made `queueRequest` type-safe with discriminated union.

### Tests

- Regression tests for `addFrontmatterField` body-scope bug, WorkerSignal machine validation, PR verification retry loop, `statusEpoch` reset in `preparePhaseRedispatch`.
- Repaired pre-existing test failures in phases and slots tests.
- Hardened t3code client tests: bind to 127.0.0.1, skip when socket binding is unavailable, increase timeouts.

### Removals

- **SSH remote dispatch** — Replaced by state-repo intent files.
- **Legacy duo startup path** — Duo-only templates and pre-PR branches removed.
- **`focusProject()` helper** — Replaced by project `priority: true` config.
- **Legacy migration code** — Removed `maybeStartDispatchedSlots`, dir-walk fallback, and `network.nodes` shim.

## v0.5.0 — 2026-03-27

Major release. Multi-agent orchestration engine with collaborative pair-mode planning, t3code and tmux runtime support, retrospective collection, dashboard action buttons, crash recovery, and milestone-aware scheduling.

### Breaking changes

- **Legacy adapters removed** — `agent-duo`, `agent-pair-claude`, `agent-pair-codex` adapters are removed; all orchestrated workflows now run through the `t3code` adapter. Legacy adapter names in config and task frontmatter are auto-mapped to `t3code` via `normalizeLaunchAdapter()`.
- **Session discovery replaced** — Legacy tmux/ttyd-based session discovery is replaced with t3code snapshot queries.

### New features

- **t3code orchestration engine** — Full phase-driven multi-agent workflow engine (`src/orchestration/`) with 20 phases, artifact validation, dispatch-scoped turn lifecycle tracking, and identity-based phase transitions. Supports duo (same roles) and pair (coder + reviewer) modes with per-role skill templates.
- **Collaborative pair-mode planning** — Independent plans from both agents are merged by the coder in a `plan-merge` phase, then reviewed by the reviewer in `plan-review`. Up to 3 iterations of merge→review before forcing forward to work.
- **Retrospective collection** — Structured post-task records capturing phase timeline, review verdicts, agent thread transcripts (with phase annotations), and artifact summaries. Primary collection at orchestration completion; fallback collection from task frontmatter for orphaned tasks. Viewable via dashboard retrospective page.
- **Auto-start decision logic** — Pure function evaluating whether to auto-launch a coding session based on autonomy config, worker confidence, rationale ambiguity signals, and slot availability. CLI: `ludics auto-start-evaluate`.
- **Crash recovery** — `ludics slot <n> resume` recovers crashed t3code orchestrated sessions by validating persisted thread/orchestration state, killing stale runner PIDs, and spawning a new runner from saved state. Phase-token deduplication prevents duplicate agent dispatches.
- **Hold/resume queue toggle** — Dashboard button to suppress automatic slot assignment and proposal generation. Controlled by `mag/queue-hold` sentinel file.
- **Slot mode toggle** — `ludics slot <n> mode <mode>` switches a slot's adapter (e.g., manual ↔ t3code) with active-session guards and task frontmatter sync.
- **Effort-based orchestration flags** — `selectOrchestrationFlags(effort)` auto-selects pair/duo mode, planning phases, and model based on task effort (small → Sonnet coder, no pre-work; medium → Opus coder, plan; large → Opus coder, plan + gather).
- **Milestone-aware scheduling** — Tasks can have a `milestone` field synced from GitHub. Flow sorting and auto-fill respect relative milestone positions within each project. Dashboard displays milestones.
- **Automated PR workflow** — PR comment polling loop with quiet-period transitions, Codex `+1` reaction triggers immediate final-merge, rebase-and-merge strategy, PR file validation gates.
- **Dashboard action buttons** — Slot tiles have done/abandon/postpone buttons for active slots, start button for assigned-but-idle slots, click-to-promote in ready queue, mode toggle button, and contextual links to t3code/proposals/PRs.
- **Dashboard pages** — Proposal viewer, retrospective viewer, recently-completed tasks tile, briefing page, notifications iframe (ntfy.sh embedded).
- **Tasks unmerge** — `ludics tasks unmerge <source>` reverses a previous task merge, restoring source frontmatter and cleaning up cross-references.
- **t3code thread interaction** — `ludics t3code read`, `ludics t3code send` for reading agent responses and sending messages to t3code threads.
- **Workflow progress notifications** — Phase transitions, review verdicts, and PR events emit ntfy notifications with 5s curl timeout to prevent blocking.
- **TypeScript launch routing** — Ntfy button-tap "Launch agent-X for task-Y" and followup actions are handled directly in `mag.ts` (slot select, assign, start), removing the dedicated launch skill.
- **Configurable orchestration defaults** — `adapters.t3code.default_mode`, `default_coder`, `default_reviewer` in config; per-task `adapter_args` override.
- **Relation-affinity tie-breaking** — Task sorting prefers tasks related to currently active slot work.
- **Focus project boost** — Virtual priority boost for the configured focus project in auto-fill and flow ready.

### Fixes

- **t3code server race condition** — File-based lock (`server.lock`) + 15s startup grace period prevent concurrent `ensureServer()` callers from SIGTERM-ing each other's startups.
- **Dashboard restart** — Waits for old server to die before starting new one.
- **Orchestration state cleanup** — Orchestration state JSON is deleted on slot clear.
- **Stale runner on resume** — Kills stale orchestration runner PID before spawning new one; validates task matches orchestration state.
- **Phase transition hardening** — Identity-based lifecycle tracking, artifact validation gates, env propagation to subprocesses.
- **Turn freshness** — `Date.parse()` for comparison, dispatch-scoped turn lifecycle replaces timestamp-freshness heuristics, `session.status + activeTurnId` as authoritative signal.
- **PR-create deadlock** — Fixed deadlock in PR creation phase; preserve existing Claude settings on merge.
- **Milestone field sync** — Clears local milestone when GitHub issue milestone is removed.
- **Case-insensitive project matching** — `focusProject()` normalized to lowercase.
- **Worktree symlinks** — `node_modules` symlinked into worktrees for typecheck/test support.
- **Various orchestration fixes** — Null-snapshot guard, root-worktree stop-hook resolution, empty taskId handling, review verdict notification using parsed verdict, stale PR/t3code link display, legacy effort value normalization.

### Removals

- **Agent-duo/pair adapters** — Removed in favor of t3code adapter.
- **Legacy session discovery** — tmux/ttyd discovery modules removed.
- **Dead notification code** — Unused notification helpers cleaned up.

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
