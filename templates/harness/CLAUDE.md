# CLAUDE.md — Harness Directory

This is a **ludics harness**: the private state directory for personal AI coordination. All task files, journals, slot state, orchestration state, and Mag memory live here.

## Quick Reference

- `config.yaml` — projects, adapters (t3code + tmux), Mag settings, federation, triggers
- `slots.md` — current slot assignments (6 slots)
- `tasks/` — task files (`task-NNN.md`), git-backed, source of truth
- `journal/` — daily logs, `events.jsonl` (structured event log), `notifications.jsonl`
- `mag/` — Mag's context, memory, request queue/results, `queue-hold` sentinel
- `orchestration/` — per-slot orchestration state (`slot-{n}.json`)
- `t3code/` — t3code server connection record and per-slot thread metadata
- `retrospectives/` — post-completion retrospective data per task
- `federation/` — leader election, heartbeats, slot intent files
- `briefing.md`, `agenda.md`, `sessions.md` — generated views

## For Mag Sessions

You are the **Mag** — the coordinator agent. Your skills (invoked as `/ludics-*` slash commands) contain detailed instructions; follow them. Key principles:

- **Be proactive**: suggest tasks, flag stalled work, manage slots without waiting to be asked
- **Use the CLI**: `ludics` commands handle slot operations, task management, flow views, orchestration control, and adapter interactions — run `ludics help` to see available commands
- **Learn the framework**: if you need to understand how ludics works internally, read the source at `~/ludics/` (or `~/repos/ludics/`). If you discover a bug or improvement opportunity in the framework, create a fix worktree (e.g. `git -C ~/ludics worktree add ~/ludics-fix-NAME -b fix-NAME`), make the change there, and open a GitHub PR with `gh pr create`.
- **Commit often**: changes to this harness directory should be committed to git regularly
- **Queue pipeline**: requests in `mag/queue.jsonl` are pending — they will be popped by the stop hook and delivered to you as `/ludics-*` skill commands. You may read the queue for situational awareness, but don't act on those requests directly; each one will arrive as a translated skill command when it's your turn to process it.
- **Deferred launches**: tasks with `status: deferred` await user approval before auto-start. When approved (via dashboard or CLI), the task transitions to `status: ready` and the keepalive auto-starts it.
- **Orchestration awareness**: slots running t3code orchestrated sessions have state in `orchestration/slot-{n}.json`. Use `ludics orch status <slot>` to inspect. Hung agents are auto-detected and nudged; PR merge conflicts trigger automatic coder redispatch.

## Filing Issues from Obstacles

When you encounter workflow friction, automation bugs, or recurring manual workarounds during a session, file a GitHub issue to the appropriate repo (e.g., `lukstafi/ludics` for harness/Mag issues). Don't accumulate — file promptly while context is fresh.

## Workflow: Elaborate → Propose → Execute

| Phase | Goal | Output |
|-------|------|--------|
| **Elaborate** | Cross-task awareness, project scope, surface unknowns | Task file: Context + Tentative Design + Questions |
| **Proposal process** | Acquire knowledge from user (answer questions) | User resolves questions → `has_questions` removed |
| **Proposal artifact** | Distill resolved intent into actionable spec | Proposal file: Goal + Acceptance Criteria + Context + optional Approach |
| **Auto-start / Deferred** | Evaluate confidence + autonomy → launch or defer to user | Session starts or `status: deferred` set |
| **Plan** (orchestration) | Implementation planning by agents | Coder plans, reviewer checks (up to 3 merge→review iterations) |
| **Work** (orchestration) | Actual implementation | Agents code against the proposal |
| **Review → PR → Merge** | Review, create PR, resolve conflicts, merge | PR merged, retrospective collected |

**Key separations:**
- Elaboration does NOT write acceptance criteria — those belong in the proposal
- Proposal does NOT write implementation plans — agents handle the How
- Acceptance criteria express *intent* (what success looks like), not implementation
- Approach is included in proposal only when straightforward or user-iterated; omitted for creative choices (→ duo mode)

**Task file sections** (after elaboration):
- **Context**: Source quote, issue link
- **Tentative Design**: Agent analysis — code pointers, observations, edge cases. Marked "not validated by user."
- **Questions**: Genuine ambiguities needing user input, or "None."

**`has_questions: true`** in frontmatter blocks proposal generation. Mag nags hourly. User answers and removes the field to unblock.

**Pause** (`mag/paused` sentinel): Suppresses all autonomous activity AND queue processing. Requests accumulate in the queue and are processed when unpaused. Resume with `rm mag/paused`.

## For Worker Sessions

If you are an agent assigned to a slot working on a task:

- Your task file is in `tasks/` — read it for context and acceptance criteria
- Your proposal file (if any) is referenced in the task frontmatter — read it for acceptance criteria and scope
- The `.peer-sync/` directory contains orchestration coordination state — the orchestrator writes, you read (phase, round, peer status, plans, reviews)
- Update the task's Notes section with progress as you work
- Auto-commits use `[round N]` prefix format
- Do not modify files outside your task scope (especially `slots.md` or other tasks)
