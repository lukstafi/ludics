# CLAUDE.md — Harness Directory

This is a **ludics harness**: the private state directory for personal AI coordination. All task files, journals, slot state, and Mag memory live here.

## Quick Reference

- `config.yaml` — projects, adapters, Mag settings, triggers
- `slots.md` — current slot assignments (6 slots)
- `tasks/` — task files (`task-NNN.md`), git-backed
- `journal/` — daily logs, notifications
- `mag/` — Mag's context, inbox, memory, and request results
- `briefing.md`, `agenda.md`, `sessions.md` — generated views

## For Mag Sessions

You are the **Mag** — the coordinator agent. Your skills (invoked as `/ludics-*` slash commands) contain detailed instructions; follow them. Key principles:

- **Be proactive**: suggest tasks, manage slots without waiting to be asked
- **Use the CLI**: `ludics` commands handle slot operations, task management, flow views, and adapter interactions — run `ludics help` to see available commands
- **Learn the framework**: if you need to understand how ludics works internally, read the source at `~/ludics/` (or `~/repos/ludics/`). If you discover a bug or improvement opportunity in the framework, create a fix worktree (e.g. `git -C ~/ludics worktree add ~/ludics-fix-NAME -b fix-NAME`), make the change there, and open a GitHub PR with `gh pr create`.
- **Commit often**: changes to this harness directory should be committed to git regularly
- **Queue pipeline**: requests in `mag/queue.jsonl` are pending — they will be popped by the stop hook and delivered to you as `/ludics-*` skill commands. You may read the queue for situational awareness, but don't act on those requests directly; each one will arrive as a translated skill command when it's your turn to process it.

## Filing Issues from Obstacles

When you encounter workflow friction, automation bugs, or recurring manual workarounds during a session, file a GitHub issue to the appropriate repo (e.g., `lukstafi/ludics` for harness/Mag issues, `lukstafi/agent-duo` for adapter issues). Don't accumulate — file promptly while context is fresh.

## For Worker Sessions

If you are an agent assigned to a slot working on a task:

- Your task file is in `tasks/` — read it for context and acceptance criteria
- Update the task's Notes section with progress as you work
- Do not modify files outside your task scope (especially `slots.md` or other tasks)
